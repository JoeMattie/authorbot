/**
 * Node dev entry (Phase 2 contract §6, `BOOK_REPO_PATH`): runs the full app —
 * including book-repository access — outside Cloudflare. This is the wiring
 * `wrangler dev` cannot provide (the Worker has no repo reader/writer until
 * Phase 5, so under wrangler the chapters projection is empty and pushes are
 * recorded `ignored`): here `BOOK_REPO_PATH` points at a local git work tree
 * of the book repository, which is read for projection rebuilds
 * (`LocalFsBookRepoReader`) and committed to by the inline mirror
 * (`LocalGitAdapter`) after every accepted mutation.
 *
 * Environment (contract §6 names):
 *   BOOK_REPO_PATH      required — absolute path to a git work tree
 *   AUTH_MODE           required — "dev" (plus DEV_LOGIN_ENABLED=true) or "github"
 *   SESSION_SECRET, WEBHOOK_SECRET, PROJECT_SLUG, PROJECT_REPO,
 *   INITIAL_MAINTAINER  required (as in wrangler)
 *   SQLITE_PATH         optional — defaults to ":memory:" (throwaway dev DB)
 *   MIRROR_MODE         optional — "inline" (default here) or "queue"
 *   PORT                optional — default 8788
 *
 * Start: `pnpm --filter @authorbot/api dev:node` (after a build), e.g.
 *   BOOK_REPO_PATH=$PWD/examples/book-repo AUTH_MODE=dev DEV_LOGIN_ENABLED=true \
 *   SESSION_SECRET=dev WEBHOOK_SECRET=dev PROJECT_SLUG=hollow-creek-anomaly \
 *   PROJECT_REPO=JoeMattie/causal-projector INITIAL_MAINTAINER=github:JoeMattie \
 *   pnpm --filter @authorbot/api dev:node
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { applyMigrations, openSqliteDatabase, type SqliteAdapter } from "@authorbot/database";
import { createApi, type AuthorbotApi } from "./app.js";
import type { AppDeps } from "./deps.js";
import { configFromBindings, identityProviderFor, type WorkerBindings } from "./worker.js";
import type { IdentityProvider } from "./identity/provider.js";
import { createInlineMirror, type InlineMirror } from "./mirror.js";
import { LocalFsBookRepoReader } from "./projection/local-fs.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));

export interface NodeDevApi {
  api: AuthorbotApi;
  db: SqliteAdapter;
  /** Present unless MIRROR_MODE=queue. */
  mirror: InlineMirror | null;
  bookRepoPath: string;
  close(): void;
}

/**
 * Build the fully wired Node dev app from environment variables. Exported
 * separately from the HTTP server so tests can exercise the wiring.
 */
export async function createNodeDevApi(env: NodeJS.ProcessEnv = process.env): Promise<NodeDevApi> {
  const bookRepoPath = env["BOOK_REPO_PATH"];
  if (bookRepoPath === undefined || bookRepoPath.length === 0) {
    throw new Error("BOOK_REPO_PATH is required (contract §6): path to a book-repo git work tree");
  }
  // Reuse the Worker's config validation (AUTH_MODE guard incl. the
  // DEV_LOGIN_ENABLED defense-in-depth check); DB comes from SQLITE_PATH.
  const config = configFromBindings({
    ...(env as Record<string, string>),
    MIRROR_MODE: env["MIRROR_MODE"] ?? "inline",
    DB: null as unknown as WorkerBindings["DB"],
  } as WorkerBindings);

  const db = openSqliteDatabase(env["SQLITE_PATH"] ?? ":memory:");
  await applyMigrations(db, env["MIGRATIONS_DIR"] ?? MIGRATIONS_DIR);

  // Same fail-closed selection as the Worker entry (worker.ts): github mode
  // without OAuth config throws — it must never fall back to dev auth.
  const identityProvider: IdentityProvider = identityProviderFor(config);

  const mirror =
    config.mirrorMode === "queue" ? null : createInlineMirror({ db, workTreePath: bookRepoPath });

  const deps: AppDeps = {
    db,
    config,
    identityProvider,
    reader: new LocalFsBookRepoReader(bookRepoPath),
    ...(mirror !== null ? { onMutationCommitted: mirror.onMutationCommitted } : {}),
  };
  const api = createApi(deps);
  await api.bootstrap();
  return { api, db, mirror, bookRepoPath, close: () => db.close() };
}

/** Minimal node:http → fetch bridge (no extra dependency). */
export function serveNodeDevApi(dev: NodeDevApi, port: number): ReturnType<typeof createServer> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);
      const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") {
          headers.set(name, value);
        } else if (Array.isArray(value)) {
          for (const v of value) {
            headers.append(name, v);
          }
        }
      }
      const method = req.method ?? "GET";
      const request = new Request(url, {
        method,
        headers,
        ...(method === "GET" || method === "HEAD" ? {} : { body: new Uint8Array(body) }),
      });
      const response = await dev.api.app.fetch(request);
      res.statusCode = response.status;
      response.headers.forEach((value, name) => {
        if (name === "set-cookie") {
          const cookies = response.headers.getSetCookie();
          res.setHeader("set-cookie", cookies);
        } else {
          res.setHeader(name, value);
        }
      });
      const responseBody = Buffer.from(await response.arrayBuffer());
      res.end(responseBody);
    })().catch(() => {
      res.statusCode = 500;
      res.end("internal error");
    });
  });
  server.listen(port);
  return server;
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  const port = Number(process.env["PORT"] ?? 8788);
  createNodeDevApi()
    .then((dev) => {
      serveNodeDevApi(dev, port);
      // eslint-disable-next-line no-console
      console.log(
        `authorbot dev server on http://127.0.0.1:${port} (book repo: ${dev.bookRepoPath}, mirror: ${dev.mirror !== null ? "inline" : "queue"})`,
      );
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
