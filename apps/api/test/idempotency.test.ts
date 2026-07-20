import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  openSqliteDatabase,
  type SqlDatabase,
  type SqlRow,
  type SqlRunResult,
  type SqlStatement,
  type SqliteAdapter,
} from "@authorbot/database";
import { createApi } from "../src/app.js";
import type { AppDeps } from "../src/deps.js";
import { createDevIdentityProvider } from "../src/identity/provider.js";
import { sha256Hex } from "../src/crypto.js";
import { uuidv7 } from "../src/ids.js";
import {
  CHAPTER_ID,
  FakeReader,
  MIGRATIONS_DIR,
  baseConfig,
  devLogin,
  makeHarness,
  validAnnotationPayload,
  type TestHarness,
} from "./helpers.js";

describe("Idempotency-Key middleware", () => {
  let h: TestHarness;
  let cookie: string;
  const path = (): string =>
    `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`;

  const post = async (key: string | null, body: unknown): Promise<Response> =>
    h.app.request(path(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        ...(key !== null ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    h = await makeHarness();
    cookie = await devLogin(h, "alice", "contributor");
  });
  afterEach(() => h.close());

  it("400 when the header is missing", async () => {
    const res = await post(null, validAnnotationPayload());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("idempotency-key-required");
  });

  it("replays the stored response for the same key + same body", async () => {
    const first = await post("key-1", validAnnotationPayload());
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { operationId: string; annotationId: string };

    const replay = await post("key-1", validAnnotationPayload());
    expect(replay.status).toBe(202);
    expect(replay.headers.get("x-idempotency-replayed")).toBe("true");
    const replayBody = (await replay.json()) as { operationId: string; annotationId: string };
    expect(replayBody.operationId).toBe(firstBody.operationId);
    expect(replayBody.annotationId).toBe(firstBody.annotationId);

    // exactly one annotation row was written
    const annotations = await h.repos.annotations.listByChapter(CHAPTER_ID);
    expect(annotations).toHaveLength(1);
  });

  it("409 for the same key + different body", async () => {
    const first = await post("key-2", validAnnotationPayload());
    expect(first.status).toBe(202);
    const res = await post("key-2", { ...validAnnotationPayload(), body: "different text" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("idempotency-key-mismatch");
  });

  it("keys are scoped per actor: same key by another actor executes fresh", async () => {
    const first = await post("shared-key", validAnnotationPayload());
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { annotationId: string };

    cookie = await devLogin(h, "bob", "contributor");
    const second = await post("shared-key", validAnnotationPayload());
    expect(second.status).toBe(202);
    const secondBody = (await second.json()) as { annotationId: string };
    expect(secondBody.annotationId).not.toBe(firstBody.annotationId);
  });

  it("does not store failed responses: a 4xx re-executes under the same key", async () => {
    const bad = { ...validAnnotationPayload(), chapterRevision: 2 };
    const first = await post("key-3", bad);
    expect(first.status).toBe(409); // revision conflict, not stored
    const second = await post("key-3", bad);
    expect(second.status).toBe(409);
    expect(second.headers.get("x-idempotency-replayed")).toBeNull();
  });

  it("concurrent same-key requests never duplicate the mutation (atomic claim)", async () => {
    // Regression: the claim row used to be inserted before the handler and
    // the response stored after it, so a same-key retry arriving while the
    // first attempt was in flight (or after a crash between the command batch
    // and setResponse) re-executed the whole command — two annotations, two
    // git operations, two outbox rows for one logical mutation. With the
    // claim+response batched atomically with the command, the loser's batch
    // fails on the unique index, rolls back, and replays the winner.
    //
    // Simulate D1-like concurrency: every DB call crosses an event-loop
    // boundary, so two in-flight requests interleave between statements.
    const db = openSqliteDatabase(":memory:");
    await applyMigrations(db, MIGRATIONS_DIR);
    const defer = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    type Wrapped = SqlStatement & { raw: SqlStatement };
    const wrapStatement = (raw: SqlStatement): Wrapped => ({
      raw,
      bind: (...values) => wrapStatement(raw.bind(...values)),
      first: async <T extends SqlRow = SqlRow>(): Promise<T | null> => {
        await defer();
        return raw.first<T>();
      },
      all: async <T extends SqlRow = SqlRow>(): Promise<T[]> => {
        await defer();
        return raw.all<T>();
      },
      run: async (): Promise<SqlRunResult> => {
        await defer();
        return raw.run();
      },
    });
    const asyncDb: SqlDatabase = {
      prepare: (sql: string) => wrapStatement(db.prepare(sql)),
      batch: async (statements: SqlStatement[]) => {
        await defer();
        // Unwrap to the adapter's own statements; the batch itself commits
        // atomically (that atomicity is exactly what the fix relies on).
        return db.batch(statements.map((s) => (s as Wrapped).raw ?? s));
      },
    };
    const api = createApi({
      db: asyncDb,
      config: baseConfig(),
      identityProvider: createDevIdentityProvider(),
      reader: new FakeReader(),
    });
    await api.bootstrap();
    const project = await api.repos.projects.getBySlug(baseConfig().projectSlug);
    if (project === null) {
      throw new Error("project not seeded");
    }
    const login = await api.app.request("/v1/dev/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login: "racer", role: "contributor" }),
    });
    const raceCookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;

    const firePost = async (): Promise<Response> =>
      api.app.request(`/v1/projects/${project.id}/chapters/${CHAPTER_ID}/annotations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: raceCookie,
          "Idempotency-Key": "race-key",
        },
        body: JSON.stringify(validAnnotationPayload()),
      });

    const [first, second] = await Promise.all([firePost(), firePost()]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const a = (await first.json()) as { annotationId: string; operationId: string };
    const b = (await second.json()) as { annotationId: string; operationId: string };
    expect(a.annotationId).toBe(b.annotationId);
    expect(a.operationId).toBe(b.operationId);

    // Exactly ONE annotation / git operation / outbox row exists.
    const count = async (table: string): Promise<number> => {
      const rows = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all();
      return Number(rows[0]?.["n"]);
    };
    expect(await count("annotations")).toBe(1);
    expect(await count("git_operations")).toBe(1);
    expect(await count("outbox")).toBe(1);
    db.close();
  });

  it("mint replay never contains the token plaintext again", async () => {
    const maintainer = await devLogin(h, "boss", "maintainer");
    const mint = async (): Promise<Response> =>
      h.app.request(`/v1/projects/${h.projectId}/agent-tokens`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: maintainer,
          "Idempotency-Key": "mint-key",
        },
        body: JSON.stringify({ name: "once-only", scopes: ["chapters:read"] }),
      });

    const first = await mint();
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { token: string };
    expect(firstBody.token).toMatch(/^authorbot_[A-Za-z0-9_-]{43}$/);

    const replay = await mint();
    expect(replay.status).toBe(201);
    const replayBody = (await replay.json()) as Record<string, unknown>;
    expect(replayBody["token"]).toBeUndefined();
    expect(replayBody["tokenRedacted"]).toBe(true);
    expect(JSON.stringify(replayBody)).not.toContain(firstBody.token);
  });
});
