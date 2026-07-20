/**
 * Test harness: the real app over better-sqlite3 (Phase 2 contract §2
 * portability) with the dev identity provider and a fake in-memory book
 * repo reader.
 */
import { fileURLToPath } from "node:url";
import {
  applyMigrations,
  openSqliteDatabase,
  type SqliteAdapter,
} from "@authorbot/database";
import type { Hono } from "hono";
import type { Repositories } from "@authorbot/database";
import { createApi, type AuthorbotApi } from "../src/app.js";
import type { AppConfig, AppDeps, AppEnv } from "../src/deps.js";
import { createDevIdentityProvider } from "../src/identity/provider.js";
import { createGitHubIdentityProvider } from "../src/identity/github.js";
import type { BookRepoReader, BookRepoSnapshot } from "../src/projection/reader.js";
import { uuidv7 } from "../src/ids.js";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));

export const SESSION_SECRET = "test-session-secret";

/**
 * `Hono#request` builds requests against http://localhost, so this is the
 * API's own origin — cookie-authed mutations send it to satisfy the Phase 2b
 * CSRF origin check (contract 2b §3).
 */
export const API_ORIGIN = "http://localhost";
export const WEBHOOK_SECRET = "test-webhook-secret";
export const PROJECT_SLUG = "hollow-creek-anomaly";
export const INITIAL_MAINTAINER = "github:initial-maintainer";

/** Deterministic fixture ids (UUIDv7-shaped). */
export const CHAPTER_ID = "01900000-0000-7000-8000-000000000001";
export const BLOCK_ID_1 = "01900000-0000-7000-8000-000000000101";
export const BLOCK_ID_2 = "01900000-0000-7000-8000-000000000102";

export function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    authMode: "dev",
    sessionSecret: SESSION_SECRET,
    webhookSecret: WEBHOOK_SECRET,
    projectSlug: PROJECT_SLUG,
    projectRepo: "JoeMattie/causal-projector",
    initialMaintainer: INITIAL_MAINTAINER,
    ...overrides,
  };
}

export function fixtureSnapshot(): BookRepoSnapshot {
  return {
    chapters: [
      {
        frontmatter: {
          schema: "authorbot.chapter/v1",
          id: CHAPTER_ID,
          slug: "baseline",
          title: "Baseline",
          order: 10,
          status: "published",
          revision: 3,
          authors: [{ actor: "github:avery-cole" }],
        },
        path: "chapters/001-baseline.md",
        contentHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        blockIds: [BLOCK_ID_1, BLOCK_ID_2],
      },
    ],
    annotations: [],
    replies: [],
  };
}

export class FakeReader implements BookRepoReader {
  constructor(public snapshot: BookRepoSnapshot = fixtureSnapshot()) {}

  async readSnapshot(): Promise<BookRepoSnapshot> {
    return this.snapshot;
  }
}

export interface TestHarness {
  app: Hono<AppEnv>;
  api: AuthorbotApi;
  db: SqliteAdapter;
  repos: Repositories;
  reader: FakeReader;
  projectId: string;
  mutationsCommitted: string[];
  close(): void;
}

export async function makeHarness(options: {
  config?: Partial<AppConfig>;
  reader?: FakeReader | null;
  githubMode?: boolean;
} = {}): Promise<TestHarness> {
  const db = openSqliteDatabase(":memory:");
  await applyMigrations(db, MIGRATIONS_DIR);

  const config = baseConfig({
    ...(options.githubMode
      ? {
          authMode: "github" as const,
          github: {
            clientId: "test-client",
            clientSecret: "test-oauth-secret",
            redirectUri: "https://example.test/v1/auth/github/callback",
          },
        }
      : {}),
    ...options.config,
  });

  const reader = options.reader === null ? undefined : (options.reader ?? new FakeReader());
  const mutationsCommitted: string[] = [];
  const deps: AppDeps = {
    db,
    config,
    identityProvider:
      config.authMode === "github" && config.github !== undefined
        ? createGitHubIdentityProvider(config.github)
        : createDevIdentityProvider(),
    ...(reader !== undefined ? { reader } : {}),
    onMutationCommitted: async (projectId) => {
      mutationsCommitted.push(projectId);
    },
  };

  const api = createApi(deps);
  const { project } = await api.bootstrap();

  return {
    app: api.app,
    api,
    db,
    repos: api.repos,
    reader: reader ?? new FakeReader(),
    projectId: project.id,
    mutationsCommitted,
    close: () => db.close(),
  };
}

/** POST /v1/dev/login and return the session Cookie header value. */
export async function devLogin(
  harness: TestHarness,
  login: string,
  role: "reader" | "contributor" | "editor" | "maintainer",
): Promise<string> {
  const response = await harness.app.request("/v1/dev/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: API_ORIGIN },
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

/** Mint an agent token via the API as a maintainer; returns the plaintext. */
export async function mintToken(
  harness: TestHarness,
  cookie: string,
  scopes: string[],
  name = "test-agent",
): Promise<{ token: string; tokenId: string }> {
  const response = await harness.app.request(
    `/v1/projects/${harness.projectId}/agent-tokens`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: API_ORIGIN,
        "Idempotency-Key": uuidv7(),
      },
      body: JSON.stringify({ name, scopes }),
    },
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
      Origin: API_ORIGIN,
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

export function validAnnotationPayload(): Record<string, unknown> {
  return {
    kind: "suggestion",
    scope: "range",
    chapterRevision: 3,
    target: {
      blockId: BLOCK_ID_1,
      textPosition: { start: 4, end: 20 },
      textQuote: { exact: "drift appeared on" },
    },
    body: "Consider tightening this opening line.",
  };
}
