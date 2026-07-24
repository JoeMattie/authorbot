/**
 * Node dev entry (Phase 2 contract §6, `BOOK_REPO_PATH`): runs the full app -
 * including book-repository access - outside Cloudflare. This is the wiring
 * `wrangler dev` cannot provide (the Worker has no repo reader/writer until
 * Phase 5, so under wrangler the chapters projection is empty and pushes are
 * recorded `ignored`): here `BOOK_REPO_PATH` points at a local git work tree
 * of the book repository, which is read for projection rebuilds
 * (`LocalFsBookRepoReader`) and committed to by the inline mirror
 * (`LocalGitAdapter`) after every accepted mutation.
 *
 * Environment (contract §6 names):
 *   BOOK_REPO_PATH      required - absolute path to a git work tree
 *   AUTH_MODE           required - "dev" (plus DEV_LOGIN_ENABLED=true) or "github"
 *   SESSION_SECRET, WEBHOOK_SECRET, PROJECT_SLUG, PROJECT_REPO,
 *   INITIAL_MAINTAINER  required (as in wrangler)
 *   SQLITE_PATH         optional - defaults to ":memory:" (throwaway dev DB)
 *   MIRROR_MODE         optional - "inline" (default here) or "queue"
 *   PORT                optional - default 8788
 *
 * Start: `pnpm --filter @authorbot/api dev:node` (after a build), e.g.
 *   BOOK_REPO_PATH=$PWD/examples/book-repo AUTH_MODE=dev DEV_LOGIN_ENABLED=true \
 *   SESSION_SECRET=dev WEBHOOK_SECRET=dev PROJECT_SLUG=hollow-creek-anomaly \
 *   PROJECT_REPO=JoeMattie/causal-projector INITIAL_MAINTAINER=github:JoeMattie \
 *   pnpm --filter @authorbot/api dev:node
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyMigrations,
  openNodeSqliteDatabase,
  type NodeSqliteAdapter,
} from "@authorbot/database/node";
import { createApi, type AuthorbotApi } from "./app.js";
import type { AppDeps } from "./deps.js";
import { configFromBindings, identityProviderFor, type WorkerBindings } from "./worker.js";
import type { IdentityProvider } from "./identity/provider.js";
import { sweepExpiredLeases } from "./leases.js";
import { createInlineMirror, type InlineMirror } from "./mirror.js";
import { HeadPinnedLocalBookRepoReader } from "./projection/local-fs.js";

const PACKAGED_MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
const WORKSPACE_MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));

export function discoverMigrationsDir(): string {
  if (existsSync(WORKSPACE_MIGRATIONS_DIR)) return WORKSPACE_MIGRATIONS_DIR;
  if (existsSync(PACKAGED_MIGRATIONS_DIR)) return PACKAGED_MIGRATIONS_DIR;
  throw new Error(
    `Authorbot migrations not found (checked ${PACKAGED_MIGRATIONS_DIR} and ${WORKSPACE_MIGRATIONS_DIR})`,
  );
}

export interface NodeDevApi {
  api: AuthorbotApi;
  db: NodeSqliteAdapter;
  /** Present unless MIRROR_MODE=queue. */
  mirror: InlineMirror | null;
  bookRepoPath: string;
  close(): void;
}

/** Default eager lease-sweep interval (Phase 4 contract §2 dev-server timer). */
export const DEFAULT_LEASE_SWEEP_MS = 60_000;

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
  if (env["LOCAL_ACTOR_NAMESPACE"] === "local") {
    config.devActorNamespace = "local";
  }
  if (env["INITIAL_MAINTAINER_DISPLAY_NAME"] !== undefined) {
    config.initialMaintainerDisplayName = env["INITIAL_MAINTAINER_DISPLAY_NAME"];
  }

  const db = openNodeSqliteDatabase(env["SQLITE_PATH"] ?? ":memory:");
  await applyMigrations(db, env["MIGRATIONS_DIR"] ?? discoverMigrationsDir());

  // Same fail-closed selection as the Worker entry (worker.ts): github mode
  // without OAuth config throws - it must never fall back to dev auth.
  const identityProvider: IdentityProvider = identityProviderFor(config);

  const mirror =
    config.mirrorMode === "queue" ? null : createInlineMirror({ db, workTreePath: bookRepoPath });

  const reader = new HeadPinnedLocalBookRepoReader(bookRepoPath);
  const deps: AppDeps = {
    db,
    config,
    identityProvider,
    reader,
    repositoryHistoryReader: reader,
    ...(mirror !== null ? { onMutationCommitted: mirror.onMutationCommitted } : {}),
  };
  const api = createApi(deps);
  const boot = await api.bootstrap();
  if (mirror !== null) {
    await mirror.drain(boot.project.id);
  }
  await api.reconcile();

  // Eager lease expiration (Phase 4 contract §2): `sweepExpiredLeases` on a
  // timer - the dev-server stand-in for the Phase 5 Durable Object alarm.
  // Lazy per-command enforcement runs regardless; the sweep frees leases
  // nobody touches. LEASE_SWEEP_MS=0 disables (tests drive sweeps directly).
  const sweepMs = env["LEASE_SWEEP_MS"] === undefined
    ? DEFAULT_LEASE_SWEEP_MS
    : Number(env["LEASE_SWEEP_MS"]);
  if (!Number.isFinite(sweepMs) || sweepMs < 0) {
    throw new Error("LEASE_SWEEP_MS must be a non-negative integer (milliseconds)");
  }
  const clock = { now: (): Date => new Date() };
  const sweepTimer =
    sweepMs > 0
      ? setInterval(() => {
          sweepExpiredLeases(db, clock).catch(() => {
            // A transient sweep failure must not kill the server; lazy
            // expiry still guards every command, and the next tick retries.
          });
        }, sweepMs)
      : null;
  sweepTimer?.unref?.();

  return {
    api,
    db,
    mirror,
    bookRepoPath,
    close: () => {
      if (sweepTimer !== null) {
        clearInterval(sweepTimer);
      }
      db.close();
    },
  };
}

export interface NodeDevServerOptions {
  /** Loopback port. Zero asks the OS for a free port. */
  port: number;
  /** Defaults to the loopback-only address required by local authoring. */
  hostname?: "127.0.0.1";
  /**
   * Exact Host headers admitted by the bridge. The direct loopback host and
   * the browser-facing dev-site host belong here when a proxy preserves Host.
   */
  allowedHosts?: readonly string[];
  /** Optional local-mode policy hook, e.g. dirty-tree mutation blocking. */
  beforeRequest?: (request: Request) => Promise<Response | null>;
  /** Browser-facing per-book cookie name; translated at the API boundary. */
  sessionCookieName?: string;
}

function appendResponseHeaders(response: Response, res: ServerResponse): void {
  response.headers.forEach((value, name) => {
    if (name === "set-cookie") {
      res.setHeader("set-cookie", response.headers.getSetCookie());
    } else {
      res.setHeader(name, value);
    }
  });
}

async function writeResponse(
  response: Response,
  res: ServerResponse,
  sessionCookieName?: string,
): Promise<void> {
  res.statusCode = response.status;
  if (sessionCookieName === undefined) {
    appendResponseHeaders(response, res);
  } else {
    response.headers.forEach((value, name) => {
      if (name !== "set-cookie") res.setHeader(name, value);
    });
    const cookies = response.headers.getSetCookie().map((cookie) =>
      cookie
        .replace(/^authorbot_session=/u, `${sessionCookieName}=`)
        .replace(/;\s*Secure/giu, "")
    );
    if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  }
  if (response.body === null) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    while (!res.destroyed) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!res.write(Buffer.from(chunk.value))) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
  } finally {
    if (res.destroyed) await reader.cancel("client disconnected").catch(() => undefined);
  }
  if (!res.destroyed) res.end();
}

/** Minimal streaming node:http → fetch bridge (no extra dependency). */
export function serveNodeDevApi(
  dev: NodeDevApi,
  portOrOptions: number | NodeDevServerOptions,
): Server {
  const options: NodeDevServerOptions =
    typeof portOrOptions === "number" ? { port: portOrOptions } : portOrOptions;
  const hostname = options.hostname ?? "127.0.0.1";
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const host = req.headers.host;
      const localAddress = server.address();
      const localPort =
        typeof localAddress === "object" && localAddress !== null ? localAddress.port : options.port;
      const allowedHosts = new Set(
        options.allowedHosts ?? [`127.0.0.1:${String(localPort)}`, `localhost:${String(localPort)}`],
      );
      if (host === undefined || !allowedHosts.has(host)) {
        res.statusCode = 421;
        res.end("misdirected request");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);
      const url = `http://${host}${req.url ?? "/"}`;
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
      if (options.sessionCookieName !== undefined) {
        const sessionCookieName = options.sessionCookieName;
        const rawCookie = headers.get("cookie") ?? "";
        const translated = rawCookie
          .split(";")
          .map((part) => part.trim())
          .filter((part) => part !== "" && !part.startsWith("authorbot_session="))
          .map((part) =>
            part.startsWith(`${sessionCookieName}=`)
              ? `authorbot_session=${part.slice(sessionCookieName.length + 1)}`
              : part
          );
        if (translated.length > 0) headers.set("cookie", translated.join("; "));
        else headers.delete("cookie");
      }
      const method = req.method ?? "GET";
      const abort = new AbortController();
      const disconnected = (): void => abort.abort("client disconnected");
      req.once("aborted", disconnected);
      res.once("close", disconnected);
      const request = new Request(url, {
        method,
        headers,
        signal: abort.signal,
        ...(method === "GET" || method === "HEAD" ? {} : { body: new Uint8Array(body) }),
      });
      const policyResponse = await options.beforeRequest?.(request);
      const response = policyResponse ?? await dev.api.app.fetch(request);
      await writeResponse(response, res, options.sessionCookieName);
    })().catch(() => {
      if (!res.headersSent) res.statusCode = 500;
      if (!res.destroyed) res.end("internal error");
    });
  });
  server.listen(options.port, hostname);
  return server;
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  const port = Number(process.env["PORT"] ?? 8788);
  const allowedHosts = process.env["ALLOWED_HOSTS"]
    ?.split(",")
    .map((host) => host.trim())
    .filter((host) => host !== "");
  createNodeDevApi()
    .then((dev) => {
      serveNodeDevApi(dev, {
        port,
        ...(allowedHosts === undefined ? {} : { allowedHosts }),
      });
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
