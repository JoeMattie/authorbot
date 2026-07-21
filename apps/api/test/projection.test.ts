import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";
import { createDevIdentityProvider } from "../src/identity/provider.js";
import { LocalFsBookRepoReader, stripFrontmatter } from "../src/projection/local-fs.js";
import {
  baseConfig,
  CHAPTER_ID,
  devLogin,
  jsonRequest,
  makeHarness,
  validAnnotationPayload,
  type TestHarness,
} from "./helpers.js";

const EXAMPLE_REPO = fileURLToPath(new URL("../../../examples/book-repo", import.meta.url));

describe("projection rebuild", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  it("bootstrap populated chapters with persisted block ids from the reader", async () => {
    const chapter = await h.repos.chapters.getById(CHAPTER_ID);
    expect(chapter?.revision).toBe(3);
    // Contract §4: block ids live on the chapter projection row so blockId
    // validation works from the database alone (no in-memory index).
    expect(chapter?.blockIds).toHaveLength(2);
  });

  it("is idempotent: rebuilding twice yields the same rows", async () => {
    const first = await h.api.rebuild();
    const second = await h.api.rebuild();
    expect(second).toEqual(first);
    const chapters = await h.repos.chapters.listByProject(h.projectId);
    expect(chapters).toHaveLength(1);
  });

  it("preserves pending_git rows across a rebuild", async () => {
    const cookie = await devLogin(h, "author", "contributor");
    const res = await h.app.request(
      `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`,
      jsonRequest("POST", validAnnotationPayload(), { Cookie: cookie }),
    );
    expect(res.status).toBe(202);
    const { annotationId } = (await res.json()) as { annotationId: string };

    const result = await h.api.rebuild();
    expect(result?.preservedPending).toBe(1);
    const preserved = await h.repos.annotations.getById(annotationId);
    expect(preserved?.status).toBe("pending_git");
    expect(preserved?.body).toBe(validAnnotationPayload()["body"]);
  });

  it("drops committed rows that vanished from the repo, keeps committed ones", async () => {
    // Simulate an annotation committed to the repo (appears in the snapshot).
    h.reader.snapshot.annotations.push({
      record: {
        schema: "authorbot.annotation/v1",
        id: "01900000-0000-7000-8000-00000000aaaa",
        kind: "comment",
        scope: "chapter",
        chapter_id: CHAPTER_ID,
        chapter_revision: 3,
        author: "github:committed-author",
        status: "open",
        created_at: "2026-07-01T10:00:00Z",
      },
      body: "a committed chapter-scope comment",
    });
    await h.api.rebuild();
    const committed = await h.repos.annotations.getById(
      "01900000-0000-7000-8000-00000000aaaa",
    );
    expect(committed?.status).toBe("open");
    const author = await h.repos.actors.getById(committed?.authorActorId ?? "");
    expect(author?.externalIdentity).toBe("github:committed-author");

    // It disappears from the repo → rebuild drops it.
    h.reader.snapshot.annotations = [];
    await h.api.rebuild();
    expect(await h.repos.annotations.getById("01900000-0000-7000-8000-00000000aaaa")).toBeNull();
  });

  it("orphans a pending annotation whose chapter left the repo (never deletes it)", async () => {
    // Regression: an accepted-but-uncommitted annotation whose chapter was
    // removed by a push used to be silently deleted by the rebuild; its
    // outbox row then failed with "annotation not found". The body exists
    // only in that row - it must be preserved with status `orphaned`
    // (Phase 0 vocabulary) and its git operation/outbox row cancelled.
    const cookie = await devLogin(h, "author", "contributor");
    const res = await h.app.request(
      `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`,
      jsonRequest("POST", validAnnotationPayload(), { Cookie: cookie }),
    );
    expect(res.status).toBe(202);
    const { annotationId, operationId } = (await res.json()) as {
      annotationId: string;
      operationId: string;
    };

    // The chapter disappears from the repo before the outbox drains.
    h.reader.snapshot.chapters = [];
    const result = await h.api.rebuild();
    expect(result?.orphaned).toBe(1);

    const orphaned = await h.repos.annotations.getById(annotationId);
    expect(orphaned?.status).toBe("orphaned");
    expect(orphaned?.body).toBe(validAnnotationPayload()["body"]);

    const operation = await h.repos.gitOperations.getById(operationId);
    expect(operation?.state).toBe("failed");
    expect(operation?.error).toContain("orphaned");
    const outboxRows = await h.db
      .prepare(`SELECT status FROM outbox WHERE git_operation_id = ?`)
      .bind(operationId)
      .all();
    expect(outboxRows.map((r) => r["status"])).toEqual(["failed"]);

    // A second rebuild must not delete the orphaned row either.
    await h.api.rebuild();
    expect((await h.repos.annotations.getById(annotationId))?.status).toBe("orphaned");
  });

  it("preserves a pending row accepted DURING the rebuild window (no TOCTOU wipe)", async () => {
    // Regression: the rebuild used to snapshot pending rows, then delete ALL
    // rows and reinsert the snapshot - a mutation accepted between those two
    // points was wiped. Simulate the race by accepting an annotation inside
    // the reader's snapshot read (i.e. after the rebuild started).
    const cookie = await devLogin(h, "racer", "contributor");
    let racedAnnotationId = "";
    const originalRead = h.reader.readSnapshot.bind(h.reader);
    h.reader.readSnapshot = async () => {
      const snapshot = await originalRead();
      const res = await h.app.request(
        `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`,
        jsonRequest("POST", validAnnotationPayload(), { Cookie: cookie }),
      );
      if (res.status !== 202) {
        throw new Error(`race insert failed: ${res.status}`);
      }
      racedAnnotationId = ((await res.json()) as { annotationId: string }).annotationId;
      return snapshot;
    };

    await h.api.rebuild();
    const survived = await h.repos.annotations.getById(racedAnnotationId);
    expect(survived?.status).toBe("pending_git");
    expect(survived?.body).toBe(validAnnotationPayload()["body"]);
  });

  it("a reader-less instance on the same DB still enforces blockId existence", async () => {
    // Regression: contract §4's block check used to be skipped whenever no
    // reader was configured (Worker deployment shape) because block ids only
    // lived in an in-memory index. They are now persisted on the chapter row.
    const readerless = createApi({
      db: h.db,
      config: baseConfig(),
      identityProvider: createDevIdentityProvider(),
    });
    const login = await readerless.app.request("/v1/dev/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ login: "worker-user", role: "contributor" }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;

    const payload = {
      ...validAnnotationPayload(),
      target: {
        blockId: "01900000-0000-7000-8000-00000000dead",
        textPosition: { start: 4, end: 20 },
        textQuote: { exact: "drift appeared on" },
      },
    };
    const res = await readerless.app.request(
      `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`,
      jsonRequest("POST", payload, { Cookie: cookie }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("unknown-block");

    // A real block id is accepted by the same reader-less instance.
    const ok = await readerless.app.request(
      `/v1/projects/${h.projectId}/chapters/${CHAPTER_ID}/annotations`,
      jsonRequest("POST", validAnnotationPayload(), { Cookie: cookie }),
    );
    expect(ok.status).toBe(202);
  });

  it("replies from the repo are projected as open with resolved authors", async () => {
    h.reader.snapshot.annotations.push({
      record: {
        schema: "authorbot.annotation/v1",
        id: "01900000-0000-7000-8000-00000000bbbb",
        kind: "comment",
        scope: "chapter",
        chapter_id: CHAPTER_ID,
        chapter_revision: 3,
        author: "github:threader",
        status: "open",
        created_at: "2026-07-01T10:00:00Z",
      },
      body: "root",
    });
    h.reader.snapshot.replies.push({
      record: {
        schema: "authorbot.reply/v1",
        id: "01900000-0000-7000-8000-00000000cccc",
        annotation_id: "01900000-0000-7000-8000-00000000bbbb",
        author: "github:replier",
        created_at: "2026-07-02T10:00:00Z",
      },
      body: "a committed reply",
    });
    await h.api.rebuild();
    const reply = await h.repos.replies.getById("01900000-0000-7000-8000-00000000cccc");
    expect(reply?.status).toBe("open");
    expect(reply?.body).toBe("a committed reply");
  });
});

describe("LocalFsBookRepoReader over examples/book-repo", () => {
  it("reads chapters with block ids and annotation/reply artifacts", async () => {
    const reader = new LocalFsBookRepoReader(EXAMPLE_REPO);
    const snapshot = await reader.readSnapshot();

    expect(snapshot.chapters.length).toBeGreaterThanOrEqual(3);
    const baseline = snapshot.chapters.find((c) => c.frontmatter.slug === "baseline");
    expect(baseline).toBeDefined();
    expect(baseline?.blockIds.length).toBeGreaterThan(0);
    expect(baseline?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    expect(snapshot.annotations.length).toBeGreaterThanOrEqual(1);
    const annotation = snapshot.annotations[0];
    expect(annotation?.record.schema).toBe("authorbot.annotation/v1");
    expect(annotation?.body.length).toBeGreaterThan(0);
    expect(annotation?.body.startsWith("---")).toBe(false);

    expect(snapshot.replies.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.replies[0]?.record.schema).toBe("authorbot.reply/v1");
  });

  it("stripFrontmatter removes exactly the frontmatter block", () => {
    expect(stripFrontmatter("---\na: 1\n---\n\nBody text\n")).toBe("Body text");
    expect(stripFrontmatter("No frontmatter here\n")).toBe("No frontmatter here");
  });
});

/**
 * `readTextFile` documents "the resolved path must stay inside the
 * repository", and Phase 4 is the first phase to route repo-relative reads
 * through it (claim task bundles, the applier's source/attribution reads).
 * The Phase 5 GitHub reader is specified to mirror this implementation, so a
 * guard that does not do what it documents propagates.
 */
describe("LocalFsBookRepoReader path containment (BookRepoReader contract)", () => {
  it("refuses a sibling directory that merely shares the repository's name prefix", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const base = await mkdtemp(join(tmpdir(), "authorbot-containment-"));
    const repo = join(base, "book");
    const sibling = join(base, "book-secrets");
    await mkdir(repo, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(join(repo, "inside.txt"), "inside", "utf8");
    await writeFile(join(sibling, "creds.env"), "TOKEN=hunter2", "utf8");

    const reader = new LocalFsBookRepoReader(repo);
    expect(await reader.readTextFile("inside.txt")).toBe("inside");
    // `join(repo, "../book-secrets/creds.env")` normalizes to the sibling,
    // which passes a bare `startsWith(repoPath)` test - it must not pass here.
    expect(await reader.readTextFile("../book-secrets/creds.env")).toBeNull();
    expect(await reader.readTextFile("../../etc/passwd")).toBeNull();
    expect(await reader.readTextFile("chapters/../../book-secrets/creds.env")).toBeNull();
    expect(await reader.readTextFile("/etc/passwd")).toBeNull();
  });

  it("resolves a non-normalized base rather than comparing against it raw", async () => {
    const reader = new LocalFsBookRepoReader(`${EXAMPLE_REPO}/./`);
    // An unresolved base made the prefix test meaningless (and fail closed
    // for a non-normalized root); reads inside the repo must still work.
    expect(await reader.readTextFile("chapters/001-baseline.md")).toContain(
      "schema: authorbot.chapter/v1",
    );
    expect(await reader.readTextFile("../etc/passwd")).toBeNull();
  });
});
