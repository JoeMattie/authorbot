/**
 * Integration harness (Phase 2 contract §7): the real app over better-sqlite3
 * with the dev identity provider, a **real** temp book repository cloned via
 * `git` from `examples/book-repo`, the Node `LocalFsBookRepoReader`, and the
 * repo-coordinator processor wired inline through a `LocalGitAdapter`
 * (`MIRROR_MODE=inline`).
 */
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  applyMigrations,
  openSqliteDatabase,
  type Repositories,
  type SqliteAdapter,
} from "@authorbot/database";
import type { Hono } from "hono";
import { createApi, type AuthorbotApi } from "../../src/app.js";
import type { AppConfig, AppDeps, AppEnv } from "../../src/deps.js";
import { createDevIdentityProvider } from "../../src/identity/provider.js";
import { uuidv7 } from "../../src/ids.js";
import { createInlineMirror, type InlineMirror } from "../../src/mirror.js";
import { LocalFsBookRepoReader } from "../../src/projection/local-fs.js";

const execFileAsync = promisify(execFile);

export const EXAMPLE_REPO = fileURLToPath(
  new URL("../../../../examples/book-repo", import.meta.url),
);
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../migrations", import.meta.url));

export const SESSION_SECRET = "integration-session-secret";
export const WEBHOOK_SECRET = "integration-webhook-secret";
export const PROJECT_SLUG = "hollow-creek-anomaly";
export const INITIAL_MAINTAINER = "github:JoeMattie";

/** Chapter 001 of examples/book-repo (fixed ids committed in the example). */
export const CHAPTER_1 = {
  id: "019cadfd-8900-7140-98fb-ceff64cada33",
  revision: 3,
  firstBlockId: "019cadfe-7360-7049-a30b-1f5898a5020a",
} as const;
/** Chapter 002 — the example repo's committed annotation targets it. */
export const CHAPTER_2 = { id: "019d0bc2-a980-734d-b0c1-aa819448d107", revision: 2 } as const;
/** Chapter 003 — revision 1; used by the webhook rebuild test. */
export const CHAPTER_3 = { id: "019d7c32-d780-7cc1-817a-a1369297a9fc", revision: 1 } as const;
export const EXAMPLE_ANNOTATION_ID = "019f32b1-7b00-7896-92ab-30424bda2cd7";

/** Run git in `cwd` with a pinned fixture identity; returns stdout. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  return stdout;
}

export interface BookRepoClone {
  /** Temp root holding origin, work tree, and any DB files. */
  root: string;
  /** The origin repository initialized from examples/book-repo. */
  sourcePath: string;
  /** `git clone` of the origin — the work tree the app reads and commits to. */
  workTreePath: string;
  cleanup(): Promise<void>;
}

/** Copy examples/book-repo into a temp git repo, then `git clone` it (contract §7.1). */
export async function cloneExampleBookRepo(): Promise<BookRepoClone> {
  const root = await mkdtemp(join(tmpdir(), "authorbot-integration-"));
  const sourcePath = join(root, "book-repo-origin");
  await cp(EXAMPLE_REPO, sourcePath, { recursive: true });
  await git(sourcePath, "init", "--quiet", "-b", "main");
  await git(sourcePath, "add", "-A");
  await git(sourcePath, "commit", "--quiet", "--no-verify", "-m", "book repo baseline");
  const workTreePath = join(root, "book-repo");
  await git(root, "clone", "--quiet", sourcePath, workTreePath);
  return {
    root,
    sourcePath,
    workTreePath,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function integrationConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    authMode: "dev",
    sessionSecret: SESSION_SECRET,
    webhookSecret: WEBHOOK_SECRET,
    projectSlug: PROJECT_SLUG,
    projectRepo: "JoeMattie/causal-projector",
    initialMaintainer: INITIAL_MAINTAINER,
    mirrorMode: "inline",
    ...overrides,
  };
}

export interface IntegrationApp {
  api: AuthorbotApi;
  app: Hono<AppEnv>;
  db: SqliteAdapter;
  repos: Repositories;
  projectId: string;
  mirror: InlineMirror;
  close(): void;
}

/**
 * Build one app instance. The caller owns `db` lifetime via `close()`;
 * migrations are applied idempotently, `bootstrap()` seeds and (when a reader
 * is present) rebuilds the projection from the work tree.
 */
export async function makeIntegrationApp(options: {
  db?: SqliteAdapter;
  dbPath?: string;
  workTreePath: string;
  /** Default true: rebuilds run against the work tree. */
  withReader?: boolean;
  config?: Partial<AppConfig>;
}): Promise<IntegrationApp> {
  const db = options.db ?? openSqliteDatabase(options.dbPath ?? ":memory:");
  await applyMigrations(db, MIGRATIONS_DIR);

  const config = integrationConfig(options.config);
  const mirror = createInlineMirror({ db, workTreePath: options.workTreePath });
  const deps: AppDeps = {
    db,
    config,
    identityProvider: createDevIdentityProvider(),
    ...(options.withReader === false
      ? {}
      : { reader: new LocalFsBookRepoReader(options.workTreePath) }),
    onMutationCommitted: mirror.onMutationCommitted,
  };
  const api = createApi(deps);
  const { project } = await api.bootstrap();

  return {
    api,
    app: api.app,
    db,
    repos: api.repos,
    projectId: project.id,
    mirror,
    close: () => db.close(),
  };
}

/** POST /v1/dev/login; returns the `Cookie` header value for the session. */
export async function devLogin(
  target: IntegrationApp,
  login: string,
  role: "reader" | "contributor" | "editor" | "maintainer",
): Promise<string> {
  const response = await target.app.request("/v1/dev/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login, role }),
  });
  if (response.status !== 200) {
    throw new Error(`dev login failed with status ${response.status}`);
  }
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) {
    throw new Error("dev login set no cookie");
  }
  return setCookie.split(";")[0] as string;
}

/** Mint an agent token as a maintainer; returns plaintext + id. */
export async function mintToken(
  target: IntegrationApp,
  cookie: string,
  scopes: string[],
  name = "integration-agent",
): Promise<{ token: string; tokenId: string }> {
  const response = await target.app.request(
    `/v1/projects/${target.projectId}/agent-tokens`,
    jsonRequest("POST", { name, scopes }, { Cookie: cookie }),
  );
  if (response.status !== 201) {
    throw new Error(`mint failed with status ${response.status}`);
  }
  const body = (await response.json()) as { token: string; id: string };
  return { token: body.token, tokenId: body.id };
}

export function jsonRequest(
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": uuidv7(),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

/** A valid range-suggestion payload against chapter 001 of the example repo. */
export function rangeSuggestionPayload(): Record<string, unknown> {
  return {
    kind: "suggestion",
    scope: "range",
    chapterRevision: CHAPTER_1.revision,
    target: {
      blockId: CHAPTER_1.firstBlockId,
      textPosition: { start: 4, end: 20 },
      textQuote: { exact: "routine calibration" },
    },
    body: "Consider tightening this opening line.",
  };
}
