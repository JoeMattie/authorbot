/**
 * Phase 5 contract §6 + §7: webhook-driven reconciliation, external-edit
 * detection and re-anchoring, divergence, and the maintainer recovery path.
 *
 * These tests drive the real HTTP surface (signed webhook in, project view and
 * submission endpoint out) rather than calling the reconcile functions
 * directly, because the properties that matter are end-to-end ones: "reads
 * keep working while writes are refused" is not a statement about a function.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hmacSha256Hex } from "../src/crypto.js";
import { uuidv7 } from "../src/ids.js";
import type { RepoAnnotationSnapshot } from "../src/projection/reader.js";
import {
  BLOCK_ID_1,
  BLOCK_ID_2,
  CHAPTER_ID,
  API_ORIGIN,
  devLogin,
  makeHarness,
  WEBHOOK_SECRET,
  type TestHarness,
} from "./helpers.js";

const CHAPTER_PATH = "chapters/001-baseline.md";

/** Chapter source whose two marked blocks carry known, distinct quotes. */
function chapterSource(options: { secondBlockText?: string; secondBlockId?: string } = {}): string {
  const secondId = options.secondBlockId ?? BLOCK_ID_2;
  const secondText =
    options.secondBlockText ??
    "The vacuum pumps humming their one note, the residual plot flattening.";
  return [
    "---",
    "schema: authorbot.chapter/v1",
    `id: ${CHAPTER_ID}`,
    "slug: baseline",
    "title: Baseline",
    "order: 10",
    "status: published",
    "revision: 3",
    "authors:",
    "  - actor: github:avery-cole",
    "---",
    "",
    `<!-- authorbot:block id="${BLOCK_ID_1}" -->`,
    "The drift appeared on a Tuesday, in the fourth decimal place.",
    "",
    `<!-- authorbot:block id="${secondId}" -->`,
    secondText,
    "",
  ].join("\n");
}

interface Fixture {
  h: TestHarness;
  /** Annotation anchored in block 1, quoting text that survives edits. */
  stable: string;
  /** Annotation anchored in block 2, quoting text an edit removes. */
  fragile: string;
}

async function seedAnnotations(h: TestHarness): Promise<Fixture> {
  // Seeded through the SNAPSHOT, not by inserting rows: annotations are
  // repo-owned projections, so a directly-inserted `open` row would be deleted
  // by the very first rebuild for not existing in the repository. Going
  // through the snapshot is also the honest fixture — these are annotations
  // that really are committed artifacts.
  const stable = uuidv7();
  const fragile = uuidv7();
  const make = (id: string, blockId: string, exact: string): RepoAnnotationSnapshot => ({
    record: {
      schema: "authorbot.annotation/v1",
      id,
      kind: "comment",
      scope: "range",
      chapter_id: CHAPTER_ID,
      chapter_revision: 3,
      author: "github:avery-cole",
      status: "open",
      created_at: "2026-05-14T17:00:00Z",
      target: {
        blockId,
        textPosition: { start: 0, end: exact.length },
        textQuote: { exact },
      },
    },
    body: "a note",
  });
  h.reader.snapshot.annotations = [
    make(stable, BLOCK_ID_1, "The drift appeared on a Tuesday"),
    make(fragile, BLOCK_ID_2, "residual plot flattening"),
  ];
  await h.api.rebuild();
  return { h, stable, fragile };
}

async function push(h: TestHarness, deliveryId: string): Promise<Response> {
  const body = JSON.stringify({ ref: "refs/heads/main", after: "a".repeat(40) });
  return h.app.request("/v1/webhooks/github", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": `sha256=${await hmacSha256Hex(WEBHOOK_SECRET, body)}`,
      "X-GitHub-Delivery": deliveryId,
      "X-GitHub-Event": "push",
    },
    body,
  });
}

describe("external edits (contract §6)", () => {
  let f: Fixture;

  beforeEach(async () => {
    const h = await makeHarness();
    h.reader.files.set(CHAPTER_PATH, chapterSource());
    f = await seedAnnotations(h);
  });
  afterEach(() => f.h.close());

  it("re-projects at the file's own frontmatter revision and re-anchors", async () => {
    const chapter = f.h.reader.snapshot.chapters[0];
    if (chapter === undefined) throw new Error("fixture chapter missing");

    // An outside editor rewrote block 2 and bumped the file's revision to 5.
    chapter.frontmatter.revision = 5;
    chapter.contentHash = `sha256:${"1".repeat(64)}`;
    f.h.reader.files.set(
      CHAPTER_PATH,
      chapterSource({ secondBlockText: "The annex was silent; the pumps had been shut down." }),
    );

    const response = await push(f.h, "delivery-external-edit");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      externalEdits: number;
      reanchored: { kept: number; needsReanchor: number };
      diverged: boolean;
    };
    expect(body.diverged).toBe(false);
    expect(body.externalEdits).toBe(1);

    // Re-projected at the FILE's revision, not an invented one.
    const projected = await f.h.repos.chapters.getById(CHAPTER_ID);
    expect(projected?.revision).toBe(5);

    // Block 1's quote survived → kept and moved to the new revision.
    const stable = await f.h.repos.annotations.getById(f.stable);
    expect(stable?.status).toBe("open");
    expect(stable?.chapterRevision).toBe(5);

    // Block 2's quote is gone → flagged, never silently left "anchored".
    const fragile = await f.h.repos.annotations.getById(f.fragile);
    expect(fragile?.status).toBe("needs_reanchor");
    expect(body.reanchored).toEqual({ kept: 1, needsReanchor: 1 });
  });

  it("re-anchors even when the external edit did NOT bump the revision", async () => {
    // The case a revision-gated re-anchor misses entirely: prose changed, the
    // frontmatter number did not, so every annotation still *looks* current.
    const chapter = f.h.reader.snapshot.chapters[0];
    if (chapter === undefined) throw new Error("fixture chapter missing");
    chapter.contentHash = `sha256:${"2".repeat(64)}`;
    f.h.reader.files.set(
      CHAPTER_PATH,
      chapterSource({ secondBlockText: "Nothing of the old sentence remains." }),
    );

    await push(f.h, "delivery-same-revision");

    const fragile = await f.h.repos.annotations.getById(f.fragile);
    expect(fragile?.status).toBe("needs_reanchor");
    const stable = await f.h.repos.annotations.getById(f.stable);
    expect(stable?.status).toBe("open");
  });

  it("records the external edit in the audit log", async () => {
    const chapter = f.h.reader.snapshot.chapters[0];
    if (chapter === undefined) throw new Error("fixture chapter missing");
    chapter.contentHash = `sha256:${"3".repeat(64)}`;

    await push(f.h, "delivery-audit");

    const rows = await f.h.db
      .prepare(`SELECT * FROM audit_events WHERE action = 'projection.external_edit'`)
      .all();
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.["target_id"])).toBe(CHAPTER_ID);
  });

  it("an unchanged repository re-projects nothing and re-anchors nothing", async () => {
    const first = await push(f.h, "delivery-noop-1");
    const body = (await first.json()) as {
      externalEdits: number;
      reanchored: { kept: number; needsReanchor: number };
    };
    expect(body.externalEdits).toBe(0);
    expect(body.reanchored).toEqual({ kept: 0, needsReanchor: 0 });

    const stable = await f.h.repos.annotations.getById(f.stable);
    expect(stable?.chapterRevision).toBe(3);
    expect(stable?.status).toBe("open");
  });

  it("marks the projection stale before refreshing and clears it after", async () => {
    await push(f.h, "delivery-stale");
    const project = await f.h.repos.projects.getById(f.h.projectId);
    expect(project?.projectionStale).toBe(false);
    // The snapshot reported no head commit, so nothing is claimed about one.
    expect(project?.projectedCommit).toBeNull();
  });

  it("records the head commit the snapshot was read at", async () => {
    f.h.reader.snapshot.headCommit = "c".repeat(40);
    await push(f.h, "delivery-head");
    const project = await f.h.repos.projects.getById(f.h.projectId);
    expect(project?.projectedCommit).toBe("c".repeat(40));
  });
});

describe("divergence (contract §6, design §14.5)", () => {
  let f: Fixture;

  beforeEach(async () => {
    const h = await makeHarness();
    h.reader.files.set(CHAPTER_PATH, chapterSource());
    f = await seedAnnotations(h);
  });
  afterEach(() => f.h.close());

  /** Move the repository's revision backwards past the projection. */
  async function diverge(deliveryId = "delivery-diverge"): Promise<void> {
    const chapter = f.h.reader.snapshot.chapters[0];
    if (chapter === undefined) throw new Error("fixture chapter missing");
    chapter.frontmatter.revision = 2; // projection holds 3
    chapter.contentHash = `sha256:${"4".repeat(64)}`;
    await push(f.h, deliveryId);
  }

  it("a backwards revision marks the project diverged and leaves the projection alone", async () => {
    await diverge();

    const project = await f.h.repos.projects.getById(f.h.projectId);
    expect(project?.status).toBe("diverged");
    expect(project?.divergedAt).not.toBeNull();

    // The projection was NOT rewritten to the repository's older revision:
    // serving prose that contradicts published revisions is the failure mode
    // divergence exists to prevent.
    const projected = await f.h.repos.chapters.getById(CHAPTER_ID);
    expect(projected?.revision).toBe(3);
  });

  it("blocks prose writes with a clear problem type", async () => {
    await diverge();
    const cookie = await devLogin(f.h, "prose-writer", "editor");

    const response = await f.h.app.request(
      `/v1/projects/${f.h.projectId}/work-items/${uuidv7()}/submissions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: API_ORIGIN,
          "Idempotency-Key": uuidv7(),
        },
        body: JSON.stringify({
          leaseId: uuidv7(),
          leaseToken: `authorbot_lease_${"a".repeat(43)}`,
          type: "block_replacement",
          baseRevision: 3,
          baseContentHash: `sha256:${"0".repeat(64)}`,
          content: "replacement prose",
        }),
      },
    );

    // 409 rather than the 404 an unknown work item would otherwise produce:
    // the gate is deliberately ahead of every other check, so no divergent
    // submission gets as far as touching lease or work-item state.
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; divergence: { kinds: string[] } };
    expect(body.code).toBe("project-diverged");
    expect(body.divergence.kinds).toEqual(["revision-regressed"]);
  });

  it("does not block reads", async () => {
    await diverge();
    const cookie = await devLogin(f.h, "quiet-reader", "reader");

    const chapters = await f.h.app.request(`/v1/projects/${f.h.projectId}/chapters`, {
      headers: { Cookie: cookie },
    });
    expect(chapters.status).toBe(200);

    const one = await f.h.app.request(
      `/v1/projects/${f.h.projectId}/chapters/${CHAPTER_ID}`,
      { headers: { Cookie: cookie } },
    );
    expect(one.status).toBe(200);

    const annotations = await f.h.app.request(
      `/v1/projects/${f.h.projectId}/chapters/${CHAPTER_ID}/annotations`,
      { headers: { Cookie: cookie } },
    );
    expect(annotations.status).toBe(200);
  });

  it("surfaces divergence on the project view", async () => {
    await diverge();
    const cookie = await devLogin(f.h, "operator", "maintainer");
    const response = await f.h.app.request(`/v1/projects/${f.h.projectId}`, {
      headers: { Cookie: cookie },
    });
    const body = (await response.json()) as {
      divergence: { state: string; kinds: string[]; chapters: { chapterId: string }[] };
    };
    expect(body.divergence.state).toBe("diverged");
    expect(body.divergence.kinds).toEqual(["revision-regressed"]);
    expect(body.divergence.chapters[0]?.chapterId).toBe(CHAPTER_ID);
  });

  it("vanished block ids referenced by live annotations diverge", async () => {
    const chapter = f.h.reader.snapshot.chapters[0];
    if (chapter === undefined) throw new Error("fixture chapter missing");
    // Block 2 disappears from the file; a live annotation still points at it.
    chapter.blockIds = [BLOCK_ID_1];
    chapter.contentHash = `sha256:${"5".repeat(64)}`;

    await push(f.h, "delivery-vanished");

    const project = await f.h.repos.projects.getById(f.h.projectId);
    expect(project?.status).toBe("diverged");
    const reason = project?.divergenceReason as {
      findings: { kind: string; missingBlockIds: string[]; strandedAnnotationIds: string[] }[];
    };
    expect(reason.findings[0]?.kind).toBe("anchor-blocks-vanished");
    expect(reason.findings[0]?.missingBlockIds).toEqual([BLOCK_ID_2]);
    expect(reason.findings[0]?.strandedAnnotationIds).toEqual([f.fragile]);
  });

  it("a vanished block with no LIVE annotation is an ordinary external edit", async () => {
    // History, not a broken invariant: a resolved annotation has no live claim
    // on the block it once quoted.
    await f.h.repos.annotations.updateStatus(f.fragile, "resolved", new Date().toISOString());
    const chapter = f.h.reader.snapshot.chapters[0];
    if (chapter === undefined) throw new Error("fixture chapter missing");
    chapter.blockIds = [BLOCK_ID_1];
    chapter.contentHash = `sha256:${"6".repeat(64)}`;

    await push(f.h, "delivery-dead-anchor");

    const project = await f.h.repos.projects.getById(f.h.projectId);
    expect(project?.status).toBe("active");
  });

  it("emits an audit event and a project_diverged event", async () => {
    await diverge();
    const audit = await f.h.db
      .prepare(`SELECT * FROM audit_events WHERE action = 'project.diverged'`)
      .all();
    expect(audit).toHaveLength(1);
    const events = await f.h.db
      .prepare(`SELECT * FROM events WHERE type = 'project_diverged'`)
      .all();
    expect(events).toHaveLength(1);
  });
});

describe("divergence recovery (contract §6)", () => {
  let f: Fixture;

  beforeEach(async () => {
    const h = await makeHarness();
    h.reader.files.set(CHAPTER_PATH, chapterSource());
    f = await seedAnnotations(h);
    const chapter = h.reader.snapshot.chapters[0];
    if (chapter === undefined) throw new Error("fixture chapter missing");
    chapter.frontmatter.revision = 2;
    chapter.contentHash = `sha256:${"7".repeat(64)}`;
    await push(h, "delivery-recovery-setup");
  });
  afterEach(() => f.h.close());

  async function clear(
    cookie: string,
    body: unknown = { reason: "reverted a bad manual edit; repository is authoritative" },
  ): Promise<Response> {
    return f.h.app.request(`/v1/projects/${f.h.projectId}/divergence/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: API_ORIGIN },
      body: JSON.stringify(body),
    });
  }

  it("a maintainer clears divergence, resyncs, and reopens prose writes", async () => {
    const cookie = await devLogin(f.h, "the-maintainer", "maintainer");
    const response = await clear(cookie);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      cleared: boolean;
      clearedFindings: { kind: string }[];
      resync: { outcome: string } | null;
    };
    expect(body.cleared).toBe(true);
    expect(body.clearedFindings[0]?.kind).toBe("revision-regressed");
    expect(body.resync?.outcome).toBe("projected");

    const project = await f.h.repos.projects.getById(f.h.projectId);
    expect(project?.status).toBe("active");
    expect(project?.divergedAt).toBeNull();

    // Resync accepted the repository as truth: the projection now matches it.
    const projected = await f.h.repos.chapters.getById(CHAPTER_ID);
    expect(projected?.revision).toBe(2);
  });

  it("audits the clearing with the maintainer's reason", async () => {
    const cookie = await devLogin(f.h, "the-maintainer", "maintainer");
    await clear(cookie, { reason: "CI force-pushed a revert; accepting repository state" });
    const rows = await f.h.db
      .prepare(`SELECT * FROM audit_events WHERE action = 'project.divergence_cleared'`)
      .all();
    expect(rows).toHaveLength(1);
    const metadata = JSON.parse(String(rows[0]?.["metadata"])) as {
      reason: string;
      priorFindings: unknown[];
    };
    expect(metadata.reason).toBe("CI force-pushed a revert; accepting repository state");
    expect(metadata.priorFindings).toHaveLength(1);
    expect(rows[0]?.["actor_id"]).not.toBeNull();
  });

  it("requires a maintainer", async () => {
    const cookie = await devLogin(f.h, "an-editor", "editor");
    const response = await clear(cookie);
    expect(response.status).toBe(403);
    const project = await f.h.repos.projects.getById(f.h.projectId);
    expect(project?.status).toBe("diverged");
  });

  it("requires a reason", async () => {
    const cookie = await devLogin(f.h, "the-maintainer", "maintainer");
    expect((await clear(cookie, {})).status).toBe(400);
    expect((await clear(cookie, { reason: "" })).status).toBe(400);
  });

  it("409s when the project is not diverged", async () => {
    const cookie = await devLogin(f.h, "the-maintainer", "maintainer");
    expect((await clear(cookie)).status).toBe(200);
    const second = await clear(cookie);
    expect(second.status).toBe(409);
  });

  it("`resync: false` clears without re-projecting", async () => {
    const cookie = await devLogin(f.h, "the-maintainer", "maintainer");
    const response = await clear(cookie, { reason: "fixing the repo by hand", resync: false });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { resync: unknown };
    expect(body.resync).toBeNull();
    const projected = await f.h.repos.chapters.getById(CHAPTER_ID);
    expect(projected?.revision).toBe(3); // untouched
  });
});

describe("push ref filtering (contract §6)", () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  async function pushRef(ref: string | undefined, deliveryId: string): Promise<Response> {
    const body = JSON.stringify(ref === undefined ? { zen: "opaque" } : { ref });
    return h.app.request("/v1/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": `sha256=${await hmacSha256Hex(WEBHOOK_SECRET, body)}`,
        "X-GitHub-Delivery": deliveryId,
        "X-GitHub-Event": "push",
      },
      body,
    });
  }

  it("ignores a push to a non-default branch without marking the projection stale", async () => {
    const chapter = h.reader.snapshot.chapters[0];
    if (chapter === undefined) throw new Error("fixture chapter missing");
    chapter.frontmatter.revision = 7;

    const response = await pushRef("refs/heads/some-feature", "delivery-feature-branch");
    expect(response.status).toBe(200);
    expect((await response.json()) as { rebuilt: boolean }).toMatchObject({ rebuilt: false });

    const project = await h.repos.projects.getById(h.projectId);
    expect(project?.projectionStale).toBe(false);
    const projected = await h.repos.chapters.getById(CHAPTER_ID);
    expect(projected?.revision).toBe(3);
  });

  it("processes an unrecognized payload rather than dropping a possible push", async () => {
    // Dropping a real push is worse than one redundant refresh.
    const chapter = h.reader.snapshot.chapters[0];
    if (chapter === undefined) throw new Error("fixture chapter missing");
    chapter.frontmatter.revision = 7;

    await pushRef(undefined, "delivery-opaque");
    const projected = await h.repos.chapters.getById(CHAPTER_ID);
    expect(projected?.revision).toBe(7);
  });
});

describe("projection refresh seam (contract §6)", () => {
  it("hands the refresh to the injected refresher instead of doing it inline", async () => {
    const requests: { projectId: string; reason: string; deliveryId?: string }[] = [];
    const h = await makeHarness({
      projectionRefresher: {
        requestProjectionRefresh: async (request) => {
          requests.push({
            projectId: request.projectId,
            reason: request.reason,
            ...(request.deliveryId !== undefined ? { deliveryId: request.deliveryId } : {}),
          });
        },
      },
    });
    try {
      const chapter = h.reader.snapshot.chapters[0];
      if (chapter === undefined) throw new Error("fixture chapter missing");
      chapter.frontmatter.revision = 9;

      const response = await push(h, "delivery-seam");
      const body = (await response.json()) as { refreshRequested: boolean; rebuilt: boolean };
      expect(body.refreshRequested).toBe(true);
      expect(body.rebuilt).toBe(false);

      expect(requests).toEqual([
        { projectId: h.projectId, reason: "webhook-push", deliveryId: "delivery-seam" },
      ]);

      // The projection was NOT rebuilt inline — the coordinator owns it — but
      // the stale flag is durable, so the work is not lost.
      const projected = await h.repos.chapters.getById(CHAPTER_ID);
      expect(projected?.revision).toBe(3);
      const project = await h.repos.projects.getById(h.projectId);
      expect(project?.projectionStale).toBe(true);
    } finally {
      h.close();
    }
  });

  it("a refresher that throws still leaves the projection marked stale", async () => {
    const h = await makeHarness({
      projectionRefresher: {
        requestProjectionRefresh: async () => {
          throw new Error("durable object unreachable");
        },
      },
    });
    try {
      const response = await push(h, "delivery-seam-failure");
      // The webhook must not 500: GitHub would redeliver a delivery whose
      // durable effect already landed.
      expect(response.status).toBe(200);
      const project = await h.repos.projects.getById(h.projectId);
      expect(project?.projectionStale).toBe(true);
    } finally {
      h.close();
    }
  });

  it("marks stale even with no reader configured (today's deployed Worker)", async () => {
    const h = await makeHarness({ reader: null });
    try {
      const response = await push(h, "delivery-no-reader");
      expect(response.status).toBe(200);
      const body = (await response.json()) as { rebuilt: boolean; stale: boolean };
      expect(body.rebuilt).toBe(false);
      expect(body.stale).toBe(true);
      const project = await h.repos.projects.getById(h.projectId);
      expect(project?.projectionStale).toBe(true);
    } finally {
      h.close();
    }
  });
});
