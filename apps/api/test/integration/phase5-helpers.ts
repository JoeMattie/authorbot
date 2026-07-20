/**
 * Phase 5 integration harness (contract §8): the **real** app, the **real**
 * `ProjectCoordinator`, the **real** `GitHubBookRepoWriter` and
 * `GitHubBookRepoReader`, all aimed at the deterministic in-process fake
 * GitHub seeded from `examples/book-repo`.
 *
 * This is deliberately different from `helpers.ts` (the Phase 2 harness),
 * which wires a `LocalGitAdapter` over a real git work tree. Nothing here
 * touches git, the filesystem (beyond reading the example fixture once), or
 * the network — the whole book repository lives in `FakeRepoState`, hashed
 * with real git object hashing, so the SHAs are the SHAs git would compute.
 *
 * `mirrorMode: "durable"` is the production value: `notifyMutation` calls
 * `onMutationCommitted`, which here is the coordinator's `drainOutbox()`.
 * That is the same call the Durable Object makes in `worker.ts`, so these
 * tests exercise the deployed path rather than a test-only shortcut. The
 * only substitution is the transport — this harness calls the coordinator
 * in-process instead of through `callCoordinator`'s internal POST route,
 * which `coordinator.test.ts` covers separately.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyMigrations,
  openSqliteDatabase,
  type Repositories,
  type SqliteAdapter,
} from "@authorbot/database";
import { GitHubBookRepoReader, GitHubBookRepoWriter } from "@authorbot/git-github";
import { createFakeGitHub, type FakeGitHub } from "@authorbot/git-github/testing";
import type { BookRepoWriter } from "@authorbot/repo-coordinator";
import type { Hono } from "hono";
import { createApi, type AuthorbotApi } from "../../src/app.js";
import {
  createProjectCoordinator,
  type CoordinatorGit,
  type ProjectCoordinator,
} from "../../src/coordinator.js";
import { hmacSha256Hex } from "../../src/crypto.js";
import type { AppConfig, AppDeps, AppEnv } from "../../src/deps.js";
import type { BookRepoReader } from "../../src/projection/reader.js";
import { createDevIdentityProvider } from "../../src/identity/provider.js";
import { uuidv7 } from "../../src/ids.js";
import { publicationSigningMaterial } from "../../src/publications.js";

export const EXAMPLE_REPO = fileURLToPath(
  new URL("../../../../examples/book-repo", import.meta.url),
);
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../migrations", import.meta.url));

export const OWNER = "JoeMattie";
export const REPO = "causal-projector";
export const FULL_NAME = `${OWNER}/${REPO}`;
export const BRANCH = "main";

export const SESSION_SECRET = "phase5-session-secret";
export const WEBHOOK_SECRET = "phase5-webhook-secret";
export const PROJECT_SLUG = "hollow-creek-anomaly";
export const INITIAL_MAINTAINER = "github:JoeMattie";

/** Fixed ids committed in `examples/book-repo` (shared with helpers.ts). */
export const CHAPTER_1 = {
  id: "019cadfd-8900-7140-98fb-ceff64cada33",
  path: "chapters/001-baseline.md",
  revision: 3,
  firstBlockId: "019cadfe-7360-7049-a30b-1f5898a5020a",
} as const;
export const CHAPTER_3 = {
  id: "019d7c32-d780-7cc1-817a-a1369297a9fc",
  path: "chapters/003-the-window.md",
  revision: 1,
} as const;

/**
 * Read `examples/book-repo` into the flat path→content map the fake seeds
 * from. The fake never touches the filesystem itself (it must stay
 * Worker-safe), so the caller does the reading.
 */
export async function exampleRepoFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files[relative(EXAMPLE_REPO, full).split("\\").join("/")] = await readFile(full, "utf8");
      }
    }
  };
  await walk(EXAMPLE_REPO);
  return files;
}

/** One observed `PATCH /git/refs/heads/{branch}`, with the body it carried. */
export interface RefUpdateObservation {
  branch: string;
  sha: string;
  /** What the client actually sent. `false` is the contract §4 step 6 value. */
  force: boolean;
}

export interface GitHubIntegrationApp {
  api: AuthorbotApi;
  app: Hono<AppEnv>;
  db: SqliteAdapter;
  repos: Repositories;
  projectId: string;
  /** The fake GitHub backing reader and writer; assert commits on it. */
  fake: FakeGitHub;
  /**
   * Every ref update the fake *received*, in order. The contract's "never a
   * force update" is asserted against these — what went over the wire —
   * rather than against the writer's intent.
   */
  refUpdates: RefUpdateObservation[];
  /** The real coordinator; `drainOutbox`, `refreshProjection`, `alarm`. */
  coordinator: ProjectCoordinator;
  git: CoordinatorGit;
  /** Every `onMutationCommitted` call, so drain triggering is observable. */
  mutations: string[];
  close(): void;
}

export interface MakeGitHubAppOptions {
  files?: Record<string, string>;
  config?: Partial<AppConfig>;
  /** Commit attempts per outbox row (drain-level). Default 3. */
  maxAttempts?: number;
  /**
   * Wrap the writer before the coordinator gets it — used by the
   * serialization test to observe overlapping commits.
   */
  wrapWriter?: (writer: BookRepoWriter) => BookRepoWriter;
  /**
   * Wrap the reader before the coordinator gets it — used by the
   * serialization and re-anchor regression tests to observe read ordering
   * and to prove which source bytes a re-anchor used.
   */
  wrapReader?: (reader: GitHubBookRepoReader) => BookRepoReader;
  /**
   * Record mutations without draining. The production `onMutationCommitted`
   * is a fire-and-forget call to the Durable Object whose failure is
   * swallowed, so a row genuinely can sit `pending` until the alarm — which
   * is the window the divergence regression test needs to reproduce.
   */
  deferDrain?: boolean | (() => boolean);
  /** Skip the boot projection rebuild (divergence tests seed by hand). */
  bootstrap?: boolean;
}

/**
 * Build one app + coordinator + fake GitHub, wired the way the deployed
 * Worker wires them.
 */
export async function makeGitHubIntegrationApp(
  options: MakeGitHubAppOptions = {},
): Promise<GitHubIntegrationApp> {
  const files = options.files ?? (await exampleRepoFiles());
  const fake = await createFakeGitHub({
    owner: OWNER,
    repo: REPO,
    defaultBranch: BRANCH,
    // These tests are about the API↔coordinator↔GitHub path; the App-auth
    // layer (JWT, token cache, 401 refresh) has its own suite in
    // @authorbot/git-github and is not re-proved here.
    requireAuth: false,
    files,
  });

  // Record ref updates as the fake receives them. Wrapping `fetch` (rather
  // than reaching into the fake) keeps the assertion honest: it observes the
  // serialized request body, which is what GitHub would act on.
  const refUpdates: RefUpdateObservation[] = [];
  const observedFetch = async (
    input: Request | string,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const match = /^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/(.+)$/.exec(url.pathname);
    if (request.method.toUpperCase() === "PATCH" && match) {
      // Clone before reading: the body must still be available downstream.
      const body = (await request.clone().json()) as { sha?: unknown; force?: unknown };
      refUpdates.push({
        branch: decodeURIComponent(match[1] as string),
        sha: typeof body.sha === "string" ? body.sha : "",
        force: body.force === true,
      });
    }
    return fake.fetch(request);
  };

  const reader = new GitHubBookRepoReader({
    owner: OWNER,
    repo: REPO,
    branch: BRANCH,
    fetch: observedFetch,
  });
  const baseWriter = new GitHubBookRepoWriter({
    repo: FULL_NAME,
    tokens: async () => "ghs_fake_installation_token",
    fetchImpl: observedFetch,
  });
  const writer = options.wrapWriter ? options.wrapWriter(baseWriter) : baseWriter;
  const coordinatorReader = options.wrapReader ? options.wrapReader(reader) : reader;
  const git: CoordinatorGit = {
    reader: coordinatorReader,
    writer,
    // Mirrors production: the refresh path asks for a reader on the branch
    // the project row names, not the one a binding named.
    readerFor: (branch: string): BookRepoReader =>
      branch === BRANCH
        ? coordinatorReader
        : (options.wrapReader ?? ((value: GitHubBookRepoReader) => value))(
            new GitHubBookRepoReader({ owner: OWNER, repo: REPO, branch, fetch: observedFetch }),
          ),
  };

  const db = openSqliteDatabase(":memory:");
  await applyMigrations(db, MIGRATIONS_DIR);

  const config: AppConfig = {
    authMode: "dev",
    sessionSecret: SESSION_SECRET,
    webhookSecret: WEBHOOK_SECRET,
    projectSlug: PROJECT_SLUG,
    projectRepo: FULL_NAME,
    initialMaintainer: INITIAL_MAINTAINER,
    // The production value (contract §5): mutations ask the coordinator to
    // drain once the command's DB batch has committed.
    mirrorMode: "durable",
    ...options.config,
  };

  // The coordinator needs the project id, which `bootstrap()` produces — so
  // it is created lazily and the hook closes over the holder.
  let coordinator: ProjectCoordinator | null = null;
  const mutations: string[] = [];

  const deps: AppDeps = {
    db,
    config,
    identityProvider: createDevIdentityProvider(),
    reader,
    onMutationCommitted: async (projectId) => {
      mutations.push(projectId);
      const defer = options.deferDrain;
      if (defer === true || (typeof defer === "function" && defer())) return;
      await coordinator?.drainOutbox();
    },
    projectionRefresher: {
      requestProjectionRefresh: async () => {
        await coordinator?.refreshProjection();
      },
    },
  };

  const api = createApi(deps);
  const { project } = await (async () => {
    // Seed first, build the coordinator, then rebuild — so the very first
    // rebuild already runs through the coordinator's reconcile path.
    const seeded = await api.bootstrap();
    return seeded;
  })();

  coordinator = createProjectCoordinator({
    projectId: project.id,
    db,
    git,
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  });

  return {
    api,
    app: api.app,
    db,
    repos: api.repos,
    projectId: project.id,
    fake,
    refUpdates,
    coordinator,
    git,
    mutations,
    close: () => db.close(),
  };
}

/**
 * Repo-relative paths whose content differs between two commits (added,
 * removed, or modified), sorted. The fake's `readFiles` gives the whole tree
 * at a commit, so this is an exact content diff rather than a tree-sha
 * comparison.
 */
export function changedPaths(fake: FakeGitHub, before: string, after: string): string[] {
  const from = fake.state.readFiles(before);
  const to = fake.state.readFiles(after);
  const paths = new Set([...Object.keys(from), ...Object.keys(to)]);
  return [...paths].filter((path) => from[path] !== to[path]).sort();
}

/** POST /v1/dev/login; returns the `Cookie` header value. */
export async function devLogin(
  target: GitHubIntegrationApp,
  login: string,
  role: "reader" | "contributor" | "editor" | "maintainer",
): Promise<string> {
  const response = await target.app.request("/v1/dev/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
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
      Origin: "http://localhost",
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

/** Deliver a signed `push` webhook, as GitHub would. */
export async function deliverPush(
  target: GitHubIntegrationApp,
  options: { deliveryId: string; ref?: string; headCommit?: string } = {
    deliveryId: uuidv7(),
  },
): Promise<Response> {
  const body = JSON.stringify({
    ref: options.ref ?? `refs/heads/${BRANCH}`,
    ...(options.headCommit !== undefined ? { after: options.headCommit } : {}),
  });
  const signature = `sha256=${await hmacSha256Hex(WEBHOOK_SECRET, body)}`;
  return target.app.request("/v1/webhooks/github", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "push",
      "X-GitHub-Delivery": options.deliveryId,
      "X-Hub-Signature-256": signature,
    },
    body,
  });
}

/** Deliver a signed publication callback, as the CI publisher would. */
export async function deliverPublication(
  target: GitHubIntegrationApp,
  body: Record<string, unknown>,
  options: { deliveryId?: string; signature?: string } = {},
): Promise<Response> {
  const raw = JSON.stringify(body);
  const deliveryId = options.deliveryId ?? uuidv7();
  const timestamp = new Date().toISOString();
  const signature =
    options.signature ??
    `sha256=${await hmacSha256Hex(
      WEBHOOK_SECRET,
      publicationSigningMaterial(deliveryId, timestamp, raw),
    )}`;
  return target.app.request("/v1/publications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-authorbot-signature-256": signature,
      "x-authorbot-delivery": deliveryId,
      "x-authorbot-timestamp": timestamp,
    },
    body: raw,
  });
}

/** A valid range-suggestion payload against chapter 001 of the example repo. */
export function rangeSuggestionPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "suggestion",
    scope: "range",
    chapterRevision: CHAPTER_1.revision,
    target: {
      blockId: CHAPTER_1.firstBlockId,
      textPosition: { start: 4, end: 21 },
      textQuote: { exact: "drift appeared on", prefix: "The ", suffix: " a Tuesday" },
    },
    body: "Consider tightening this opening line.",
    ...overrides,
  };
}
