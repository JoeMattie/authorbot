/**
 * Phase 4 submissions and the apply pipeline (contract §4-§6, §8 exit
 * criteria 3-6): the §4 verification order with stable problem types, the
 * one-commit happy path (chapter bump + work item done + annotation accepted
 * + attribution, §14.3 trailers), the rebase-vs-conflict decision table
 * (§12.6 - the newer chapter is never clobbered), and §10.3 re-anchoring.
 */
import { describe, expect, it } from "vitest";
import { parseWorkItemArtifact } from "@authorbot/repo-coordinator";
import { uuidv7 } from "../src/ids.js";
import { BLOCK_ID_1, BLOCK_ID_2, CHAPTER_ID, devLogin, jsonRequest } from "./helpers.js";
import {
  BLOCK_2_TEXT,
  CHAPTER_PATH,
  claimWorkItem,
  createReadyWorkItem,
  makePhase4Harness,
  type Phase4Harness,
} from "./phase4-helpers.js";

interface ClaimedContext {
  harness: Phase4Harness;
  cookie: string;
  workItemId: string;
  annotationId: string;
  leaseId: string;
  leaseToken: string;
  baseRevision: number;
  baseContentHash: string;
  source: string;
}

async function claimed(
  harness: Phase4Harness,
  options: Parameters<typeof createReadyWorkItem>[1] = {},
): Promise<ClaimedContext> {
  const cookie = await devLogin(harness, "holder", "editor");
  const { workItemId, annotationId } = await createReadyWorkItem(harness, options);
  const { status, body } = await claimWorkItem(harness, { cookie }, workItemId);
  expect(status).toBe(201);
  const lease = body["lease"] as { id: string; token: string };
  const document = body["document"] as { revision: number; contentHash: string; source: string };
  return {
    harness,
    cookie,
    workItemId,
    annotationId,
    leaseId: lease.id,
    leaseToken: lease.token,
    baseRevision: document.revision,
    baseContentHash: document.contentHash,
    source: document.source,
  };
}

async function submit(
  ctx: ClaimedContext,
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await ctx.harness.app.request(
    `/v1/projects/${ctx.harness.projectId}/work-items/${ctx.workItemId}/submissions`,
    jsonRequest(
      "POST",
      {
        leaseId: ctx.leaseId,
        leaseToken: ctx.leaseToken,
        type: "range_replacement",
        baseRevision: ctx.baseRevision,
        baseContentHash: ctx.baseContentHash,
        content: "haze settled over",
        ...overrides,
      },
      { Cookie: ctx.cookie },
    ),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Simulate an external (webhook-rebuilt) chapter change to `newSource`. */
async function externalEdit(
  harness: Phase4Harness,
  newSource: string,
  revision: number,
): Promise<void> {
  harness.repoFiles.set(CHAPTER_PATH, newSource);
  const chapter = await harness.repos.chapters.getById(CHAPTER_ID);
  if (chapter === null) throw new Error("fixture chapter missing");
  await harness.db
    .prepare(`UPDATE chapters SET revision = ?, updated_at = ? WHERE id = ?`)
    .bind(revision, "2026-07-19T18:03:00Z", CHAPTER_ID)
    .run();
}

async function eventTypes(harness: Phase4Harness): Promise<string[]> {
  const events = await harness.repos.events.listAfter(harness.projectId, 0, 500);
  return events.map((e) => e.type);
}

describe("submission verification order (contract §4)", () => {
  it("walks the ordered checks with stable problem types", async () => {
    const harness = await makePhase4Harness();
    try {
      const ctx = await claimed(harness);

      // 1. Lease exists.
      const unknownLease = await submit({ ...ctx, leaseId: uuidv7() });
      expect(unknownLease.status).toBe(404);

      // 2. Holder - another member with submissions:write, right lease id.
      const other = await devLogin(harness, "other", "editor");
      const notHolder = await submit({ ...ctx, cookie: other });
      expect(notHolder.status).toBe(403);
      expect(notHolder.body["code"]).toBe("forbidden");

      // 3. Token hash - checked before type/base problems (order dominance).
      const wrongToken = await submit(
        { ...ctx, leaseToken: `authorbot_lease_${"x".repeat(43)}` },
        { type: "block_replacement" },
      );
      expect(wrongToken.status).toBe(403);
      expect(wrongToken.body["code"]).toBe("lease-token-invalid");

      // 7. Type matches the work-item type.
      const wrongType = await submit(ctx, { type: "block_replacement" });
      expect(wrongType.status).toBe(422);
      expect(wrongType.body["code"]).toBe("submission-type-mismatch");

      // 8. Base matches the lease's bundle.
      const wrongBase = await submit(ctx, { baseRevision: 2 });
      expect(wrongBase.status).toBe(409);
      expect(wrongBase.body["code"]).toBe("submission-base-mismatch");
      const wrongHash = await submit(ctx, { baseContentHash: `sha256:${"0".repeat(64)}` });
      expect(wrongHash.status).toBe(409);
      expect(wrongHash.body["code"]).toBe("submission-base-mismatch");

      // 9. Phase 0 prose safety on content.
      const unsafe = await submit(ctx, { content: "x <script>alert(1)</script>" });
      expect(unsafe.status).toBe(422);
      expect(unsafe.body["code"]).toBe("unsafe-content");
      const marker = await submit(ctx, { content: `x <!-- authorbot:block id="y" -->` });
      expect(marker.status).toBe(422);

      // 4./5. Inactive lease (released) - after the item left `leased` state
      // the lease check still fires first with its own problem type.
      await harness.app.request(
        `/v1/projects/${harness.projectId}/work-items/${ctx.workItemId}/lease/release`,
        jsonRequest("POST", {}, { Cookie: ctx.cookie }),
      );
      const released = await submit(ctx);
      expect(released.status).toBe(409);
      expect(released.body["code"]).toBe("lease-inactive");
    } finally {
      harness.close();
    }
  });

  it("an expired lease cannot submit (lazy expiry, item back to ready)", async () => {
    const harness = await makePhase4Harness();
    try {
      const ctx = await claimed(harness);
      harness.clock.advanceMs(31 * 60 * 1000);
      const expired = await submit(ctx);
      expect(expired.status).toBe(409);
      expect(expired.body["code"]).toBe("lease-expired");
      expect((await harness.repos.workItems.getById(ctx.workItemId))?.status).toBe("ready");
      expect(await eventTypes(harness)).toContain("lease_expired");
    } finally {
      harness.close();
    }
  });

  it("write_chapter items are claimable but have no submission flow", async () => {
    const harness = await makePhase4Harness();
    try {
      const ctx = await claimed(harness, { type: "write_chapter" });
      const denied = await submit(ctx, { type: "chapter_replacement", content: "A body." });
      expect(denied.status).toBe(422);
      expect(denied.body["code"]).toBe("submission-not-supported");
    } finally {
      harness.close();
    }
  });
});

describe("apply pipeline: happy path (exit criterion 3)", () => {
  it("range_replacement lands ONE commit: chapter bump + work item done + annotation accepted + attribution", async () => {
    const harness = await makePhase4Harness();
    try {
      const ctx = await claimed(harness);
      const accepted = await submit(ctx);
      expect(accepted.status).toBe(202);
      const submissionId = accepted.body["submissionId"] as string;
      const operationId = accepted.body["operationId"] as string;

      // The inline mirror drained during the request: exactly one commit.
      expect(harness.writer.commits).toHaveLength(1);
      const commit = harness.writer.commits[0]!;
      expect(commit.message).toBe(`Apply work item ${ctx.workItemId}`);
      expect(commit.files.map((f) => f.path).sort()).toEqual([
        `.authorbot/annotations/${ctx.annotationId}/annotation.md`,
        `.authorbot/attribution/${CHAPTER_ID}.yml`,
        `.authorbot/work-items/${ctx.workItemId}.md`,
        CHAPTER_PATH,
      ].sort());

      // §14.3 trailers.
      expect(commit.trailers["Authorbot-Actor"]).toBe("github:holder");
      expect(commit.trailers["Authorbot-Work-Item"]).toBe(ctx.workItemId);
      expect(commit.trailers["Authorbot-Annotation"]).toBe(ctx.annotationId);
      expect(commit.trailers["Authorbot-Base-Revision"]).toBe("3");
      expect(commit.trailers["Authorbot-Operation"]).toBe(operationId);

      // Chapter: revision bumped, replacement applied ONLY in the target
      // span, markers intact, submitter appended to authors.
      const chapterFile = harness.repoFiles.get(CHAPTER_PATH)!;
      expect(chapterFile).toContain("revision: 4");
      expect(chapterFile).toContain("The haze settled over the ridge at dawn.");
      expect(chapterFile).not.toContain("drift appeared on");
      expect(chapterFile).toContain(BLOCK_2_TEXT);
      expect(chapterFile).toContain(`id="${BLOCK_ID_1}"`);
      expect(chapterFile).toContain(`id="${BLOCK_ID_2}"`);
      expect(chapterFile).toContain("actor: github:avery-cole");
      expect(chapterFile).toContain("actor: github:holder");

      // Work-item artifact: completed, parseable.
      const artifact = parseWorkItemArtifact(
        harness.repoFiles.get(`.authorbot/work-items/${ctx.workItemId}.md`)!,
      );
      expect(artifact.record.status).toBe("completed");

      // Annotation artifact accepted.
      expect(
        harness.repoFiles.get(`.authorbot/annotations/${ctx.annotationId}/annotation.md`),
      ).toContain("status: accepted");

      // Attribution appended in the same commit.
      const attribution = harness.repoFiles.get(`.authorbot/attribution/${CHAPTER_ID}.yml`)!;
      expect(attribution).toContain("schema: authorbot.attribution/v1");
      expect(attribution).toContain("revision: 4");
      expect(attribution).toContain("actor: github:holder");
      expect(attribution).toContain(`work_item_id: ${ctx.workItemId}`);

      // DB finalized: submission applied, work item completed, annotation
      // accepted, projection advanced, lease consumed.
      expect((await harness.repos.submissions.getById(submissionId))?.state).toBe("applied");
      expect((await harness.repos.workItems.getById(ctx.workItemId))?.status).toBe("completed");
      expect((await harness.repos.annotations.getById(ctx.annotationId))?.status).toBe("accepted");
      const chapter = await harness.repos.chapters.getById(CHAPTER_ID);
      expect(chapter?.revision).toBe(4);
      expect(chapter?.blockIds).toEqual([BLOCK_ID_1, BLOCK_ID_2]);
      expect((await harness.repos.leases.getActiveByWorkItem(ctx.workItemId))).toBeNull();

      // Operation observable as committed; §6 events emitted.
      const operation = await harness.repos.gitOperations.getById(operationId);
      expect(operation?.state).toBe("committed");
      expect(operation?.commitSha).toBe(commit.sha);
      const types = await eventTypes(harness);
      expect(types).toContain("submission_received");
      expect(types).toContain("work_item_completed");
      expect(types).toContain("operation_completed");
      const received = (await harness.repos.events.listAfter(harness.projectId, 0, 500)).find(
        (event) => event.type === "submission_received",
      );
      expect(received?.payload).toMatchObject({
        submissionId,
        operationId,
        workItemId: ctx.workItemId,
        correlationId: accepted.body["correlationId"],
      });
    } finally {
      harness.close();
    }
  });

  it("chapter_replacement applies at base == current, reusing ids for unchanged blocks", async () => {
    const harness = await makePhase4Harness();
    try {
      const ctx = await claimed(harness, { type: "revise_chapter" });
      const newBody = [
        "The drift appeared on the ridge at dawn.",
        "",
        BLOCK_2_TEXT,
        "",
        "A third paragraph arrives.",
      ].join("\n");
      const accepted = await submit(ctx, { type: "chapter_replacement", content: newBody });
      expect(accepted.status).toBe(202);
      const chapterFile = harness.repoFiles.get(CHAPTER_PATH)!;
      expect(chapterFile).toContain("revision: 4");
      expect(chapterFile).toContain("A third paragraph arrives.");
      // Byte-identical blocks keep their marker ids (§5).
      expect(chapterFile).toContain(`id="${BLOCK_ID_1}"`);
      expect(chapterFile).toContain(`id="${BLOCK_ID_2}"`);
      const chapter = await harness.repos.chapters.getById(CHAPTER_ID);
      expect(chapter?.revision).toBe(4);
      expect(chapter?.blockIds).toHaveLength(3);
    } finally {
      harness.close();
    }
  });
});

describe("rebase vs conflict (contract §5, §8 exit criterion 4)", () => {
  const V4_UNRELATED = (blockTwoText: string): string => `---
schema: authorbot.chapter/v1
id: ${CHAPTER_ID}
slug: baseline
title: Baseline
order: 10
status: published
revision: 4
authors:
  - actor: github:avery-cole
summary: The anomaly is first sighted.
---

<!-- authorbot:block id="${BLOCK_ID_1}" -->
The drift appeared on the ridge at dawn.

<!-- authorbot:block id="${BLOCK_ID_2}" -->
${blockTwoText}
`;

  const V4_OVERLAPPING = `---
schema: authorbot.chapter/v1
id: ${CHAPTER_ID}
slug: baseline
title: Baseline
order: 10
status: published
revision: 4
authors:
  - actor: github:avery-cole
summary: The anomaly is first sighted.
---

<!-- authorbot:block id="${BLOCK_ID_1}" -->
The anomaly hovered over the ridge at dawn.

<!-- authorbot:block id="${BLOCK_ID_2}" -->
${BLOCK_2_TEXT}
`;

  it("an unrelated concurrent edit rebases deterministically (range still applies)", async () => {
    const harness = await makePhase4Harness();
    try {
      const ctx = await claimed(harness);
      // Someone edits block 2 after the claim: revision 3 → 4.
      await externalEdit(harness, V4_UNRELATED("Nobody in Hollow Creek dared speak of it."), 4);

      const accepted = await submit(ctx); // base 3, current 4
      expect(accepted.status).toBe(202);
      const chapterFile = harness.repoFiles.get(CHAPTER_PATH)!;
      expect(chapterFile).toContain("revision: 5");
      expect(chapterFile).toContain("The haze settled over the ridge at dawn.");
      // The concurrent edit is preserved - no clobber.
      expect(chapterFile).toContain("Nobody in Hollow Creek dared speak of it.");
      expect((await harness.repos.workItems.getById(ctx.workItemId))?.status).toBe("completed");
    } finally {
      harness.close();
    }
  });

  it("an overlapping edit conflicts: conflict work item, no chapter change, newer revision byte-intact", async () => {
    const harness = await makePhase4Harness();
    try {
      const ctx = await claimed(harness);
      await externalEdit(harness, V4_OVERLAPPING, 4);

      const accepted = await submit(ctx);
      expect(accepted.status).toBe(202);
      const submissionId = accepted.body["submissionId"] as string;
      const operationId = accepted.body["operationId"] as string;

      // The hammer assertion: the newer chapter is byte-intact.
      expect(harness.repoFiles.get(CHAPTER_PATH)).toBe(V4_OVERLAPPING);

      // Submission conflicted; original item in conflict; a ready
      // resolve_conflict item exists against the CURRENT revision.
      expect((await harness.repos.submissions.getById(submissionId))?.state).toBe("conflicted");
      expect((await harness.repos.workItems.getById(ctx.workItemId))?.status).toBe("conflict");
      const siblings = await harness.repos.workItems.listBySourceAnnotation(ctx.annotationId);
      const conflictItem = siblings.find((w) => w.type === "resolve_conflict");
      expect(conflictItem?.status).toBe("ready");
      expect(conflictItem?.baseRevision).toBe(4);

      // 409-style problem recorded on the operation (the operation itself
      // committed - its commit IS the conflict record - but `error` carries
      // the structured refusal for polling agents).
      const operation = await harness.repos.gitOperations.getById(operationId);
      expect(operation?.state).toBe("committed");
      const problem = JSON.parse(operation?.error ?? "{}") as Record<string, unknown>;
      expect(problem["code"]).toBe("submission-conflict");
      expect(problem["status"]).toBe(409);
      expect(problem["conflictWorkItemId"]).toBe(conflictItem?.id);

      // The conflict-record commit carries the §13 artifact (both texts) and
      // the original item re-rendered as `conflict` - chapter untouched.
      expect(harness.writer.commits).toHaveLength(1);
      const conflictCommit = harness.writer.commits[0]!;
      expect(conflictCommit.files.map((f) => f.path).sort()).toEqual(
        [
          `.authorbot/work-items/${ctx.workItemId}.md`,
          `.authorbot/work-items/${conflictItem?.id}.md`,
        ].sort(),
      );
      const conflictArtifactSource = harness.repoFiles.get(
        `.authorbot/work-items/${conflictItem?.id}.md`,
      )!;
      const artifact = parseWorkItemArtifact(conflictArtifactSource);
      expect(artifact.record.type).toBe("resolve_conflict");
      expect(artifact.record.status).toBe("ready");
      // Both texts (§13): the CURRENT text at the target and the submission.
      expect(artifact.sections.originalText).toContain(
        "The anomaly hovered over the ridge at dawn.",
      );
      expect(conflictArtifactSource).toContain("haze settled over");
      expect(artifact.sections.submissionContract).toContain("chapter_replacement");
      expect(artifact.sections.submissionContract).toContain("revision 4");
      const original = parseWorkItemArtifact(
        harness.repoFiles.get(`.authorbot/work-items/${ctx.workItemId}.md`)!,
      );
      expect(original.record.status).toBe("conflict");

      const types = await eventTypes(harness);
      expect(types).toContain("work_item_conflict");
      expect(types).toContain("work_item_created");
    } finally {
      harness.close();
    }
  });

  it("block/chapter replacements against a moved base always conflict (conservative §12.6)", async () => {
    const harness = await makePhase4Harness();
    try {
      const ctx = await claimed(harness, { type: "revise_block" });
      // Even an UNRELATED edit conflicts a whole-block replacement: block
      // intactness cannot be proven without the base source.
      await externalEdit(harness, V4_UNRELATED("Nobody in Hollow Creek dared speak of it."), 4);
      const accepted = await submit(ctx, {
        type: "block_replacement",
        content: "A rewritten opening block.",
      });
      expect(accepted.status).toBe(202);
      expect((await harness.repos.submissions.getById(accepted.body["submissionId"] as string))?.state).toBe(
        "conflicted",
      );
      // Newer chapter untouched.
      expect(harness.repoFiles.get(CHAPTER_PATH)).toContain("dared speak of it");
    } finally {
      harness.close();
    }
  });

  it("block_replacement applies cleanly at base == current", async () => {
    const harness = await makePhase4Harness();
    try {
      const ctx = await claimed(harness, { type: "revise_block" });
      const accepted = await submit(ctx, {
        type: "block_replacement",
        content: "A rewritten opening block.",
      });
      expect(accepted.status).toBe(202);
      const chapterFile = harness.repoFiles.get(CHAPTER_PATH)!;
      expect(chapterFile).toContain("revision: 4");
      expect(chapterFile).toContain("A rewritten opening block.");
      expect(chapterFile).toContain(`id="${BLOCK_ID_1}"`); // marker preserved
      expect((await harness.repos.workItems.getById(ctx.workItemId))?.status).toBe("completed");
    } finally {
      harness.close();
    }
  });
});

describe("re-anchoring (contract §5, §8 exit criterion 6)", () => {
  it("keeps unaffected annotations (revision bumped) and flags overlapped ones, recorded with version", async () => {
    const harness = await makePhase4Harness();
    try {
      const ctx = await claimed(harness);
      const ts = "2026-07-19T18:01:00Z";
      const author = (await harness.repos.actors.getByExternalIdentity("github:fixture-author"))!;
      const unaffectedId = uuidv7();
      await harness.repos.annotations.insert({
        id: unaffectedId,
        projectId: harness.projectId,
        chapterId: CHAPTER_ID,
        kind: "comment",
        scope: "range",
        chapterRevision: 3,
        target: {
          blockId: BLOCK_ID_2,
          textPosition: { start: 10, end: 22 },
          textQuote: { exact: "Hollow Creek" },
        },
        authorActorId: author.id,
        body: "Nice town name.",
        status: "open",
        gitOperationId: null,
        supersededBy: null,
        createdAt: ts,
        updatedAt: ts,
      });
      const overlappedId = uuidv7();
      await harness.repos.annotations.insert({
        id: overlappedId,
        projectId: harness.projectId,
        chapterId: CHAPTER_ID,
        kind: "comment",
        scope: "range",
        chapterRevision: 3,
        target: {
          blockId: BLOCK_ID_1,
          textPosition: { start: 4, end: 18 },
          textQuote: { exact: "drift appeared" },
        },
        authorActorId: author.id,
        body: "This overlaps the revised span.",
        status: "open",
        gitOperationId: null,
        supersededBy: null,
        createdAt: ts,
        updatedAt: ts,
      });

      expect((await submit(ctx)).status).toBe(202);

      const unaffected = await harness.repos.annotations.getById(unaffectedId);
      expect(unaffected?.status).toBe("open");
      expect(unaffected?.chapterRevision).toBe(4);
      const overlapped = await harness.repos.annotations.getById(overlappedId);
      expect(overlapped?.status).toBe("needs_reanchor");
      expect(overlapped?.chapterRevision).toBe(3);

      // Each result recorded with the algorithm version.
      const audits = await harness.db
        .prepare(`SELECT target_id, metadata FROM audit_events WHERE action = 'annotation.reanchor'`)
        .all();
      expect(audits).toHaveLength(2);
      for (const row of audits) {
        const metadata = JSON.parse(String(row["metadata"])) as Record<string, unknown>;
        expect(metadata["algorithmVersion"]).toBe("deterministic/v1");
        expect(["kept", "needs_reanchor"]).toContain(metadata["result"]);
      }
      expect(await eventTypes(harness)).toContain("annotation_needs_reanchor");
    } finally {
      harness.close();
    }
  });
});

/**
 * Contract §5 requires "unique match AND no overlap with the changed regions"
 * before a moved base may rebase. Unique resolution alone is not the second
 * conjunct: when the concurrent edit deletes the target block, §10.2 step 4
 * legitimately searches chapter-wide and can resurrect the quote in prose the
 * submitter never saw - a clobber reported as a clean rebase.
 */
describe("moved-base rebase safety (contract §5, §8 exit criterion 4)", () => {
  const V4_BLOCK_DELETED = `---
schema: authorbot.chapter/v1
id: ${CHAPTER_ID}
slug: baseline
title: Baseline
order: 10
status: published
revision: 4
authors:
  - actor: github:avery-cole
summary: The anomaly is first sighted.
---

<!-- authorbot:block id="${BLOCK_ID_2}" -->
Elsewhere, the drift appeared on a different page entirely.
`;

  it("a cross-block relocation against a moved base conflicts instead of clobbering", async () => {
    const harness = await makePhase4Harness();
    try {
      const ctx = await claimed(harness);
      // The target block is deleted; the quote survives exactly once, in an
      // unrelated paragraph the submitter never saw.
      await externalEdit(harness, V4_BLOCK_DELETED, 4);

      const accepted = await submit(ctx); // base 3, current 4
      expect(accepted.status).toBe(202);

      // The hammer assertion: the newer chapter is byte-intact.
      expect(harness.repoFiles.get(CHAPTER_PATH)).toBe(V4_BLOCK_DELETED);
      const submissionId = accepted.body["submissionId"] as string;
      expect((await harness.repos.submissions.getById(submissionId))?.state).toBe("conflicted");
      expect((await harness.repos.workItems.getById(ctx.workItemId))?.status).toBe("conflict");
      // A human gets the merge, with both texts.
      const siblings = await harness.repos.workItems.listBySourceAnnotation(ctx.annotationId);
      expect(siblings.find((w) => w.type === "resolve_conflict")?.status).toBe("ready");
    } finally {
      harness.close();
    }
  });
});

describe("re-anchor completeness and convergence (contract §5, §8.6)", () => {
  /** Insert `count` annotations on the fixture chapter with the given status. */
  async function seedAnnotations(
    harness: Phase4Harness,
    count: number,
    status: "open" | "resolved",
    blockId: string,
    exact: string,
  ): Promise<string[]> {
    const author = (await harness.repos.actors.getByExternalIdentity("github:fixture-author"))!;
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = uuidv7();
      ids.push(id);
      await harness.repos.annotations.insert({
        id,
        projectId: harness.projectId,
        chapterId: CHAPTER_ID,
        kind: "comment",
        scope: "range",
        chapterRevision: 3,
        target: { blockId, textQuote: { exact } },
        authorActorId: author.id,
        body: `annotation ${i}`,
        status,
        gitOperationId: null,
        supersededBy: null,
        createdAt: "2026-07-19T18:01:00Z",
        updatedAt: "2026-07-19T18:01:00Z",
      });
    }
    return ids;
  }

  it("re-anchors annotations beyond the first page instead of silently skipping them", async () => {
    const harness = await makePhase4Harness();
    try {
      const ctx = await claimed(harness);
      // Terminal rows are created FIRST, so with a single capped read they
      // fill the window and hide every live annotation behind them. UUIDv7
      // ids are creation-ordered, so this is the ordinary shape of a
      // long-lived chapter - 200 LIFETIME annotations, not 200 open ones.
      await seedAnnotations(harness, 205, "resolved", BLOCK_ID_2, "Hollow Creek");
      const live = await seedAnnotations(harness, 4, "open", BLOCK_ID_2, "Hollow Creek");

      expect((await submit(ctx)).status).toBe(202);

      for (const id of live) {
        const annotation = await harness.repos.annotations.getById(id);
        // Unaffected by the edit → kept, with its anchor moved to the new
        // revision. Being skipped would leave a stale anchor that still looks
        // authoritative (design §10.2 step 6).
        expect(annotation?.status).toBe("open");
        expect(annotation?.chapterRevision).toBe(4);
      }
    } finally {
      harness.close();
    }
  });

  it("a drain that crashed before the post-drain hook is repaired by the next drain", async () => {
    const harness = await makePhase4Harness();
    try {
      const ctx = await claimed(harness);
      const [lagging] = await seedAnnotations(harness, 1, "open", BLOCK_ID_2, "Hollow Creek");

      expect((await submit(ctx)).status).toBe(202);
      expect((await harness.repos.annotations.getById(lagging!))?.chapterRevision).toBe(4);

      // Rewind ONLY the annotation, as a crash between the processor's atomic
      // finalize batch and the post-drain hook would leave it. The outbox row
      // is `done`, so no future drain can re-emit that outcome - the repair
      // must come from durable state.
      await harness.db
        .prepare(`UPDATE annotations SET chapter_revision = 3 WHERE id = ?`)
        .bind(lagging!)
        .run();

      await harness.mirror.drain(harness.projectId);

      expect((await harness.repos.annotations.getById(lagging!))?.chapterRevision).toBe(4);
    } finally {
      harness.close();
    }
  });

  it("a conflict problem lost to a crash is re-recorded on the operation", async () => {
    const harness = await makePhase4Harness();
    try {
      const ctx = await claimed(harness);
      // An overlapping edit: the target span is rewritten, so the submission
      // conflicts and the operation must carry the §5 409-style problem.
      await externalEdit(
        harness,
        `---
schema: authorbot.chapter/v1
id: ${CHAPTER_ID}
slug: baseline
title: Baseline
order: 10
status: published
revision: 4
authors:
  - actor: github:avery-cole
summary: The anomaly is first sighted.
---

<!-- authorbot:block id="${BLOCK_ID_1}" -->
The anomaly hovered over the ridge at dawn.

<!-- authorbot:block id="${BLOCK_ID_2}" -->
Nobody in Hollow Creek spoke of it.
`,
        4,
      );
      const accepted = await submit(ctx);
      expect(accepted.status).toBe(202);
      const operationId = accepted.body["operationId"] as string;
      expect((await harness.repos.gitOperations.getById(operationId))?.error).not.toBeNull();

      // As a crash before the hook would leave it: committed, but with no
      // problem recorded - a polling agent would read `committed` and
      // conclude its edit landed.
      await harness.db
        .prepare(`UPDATE git_operations SET error = NULL WHERE id = ?`)
        .bind(operationId)
        .run();

      await harness.mirror.drain(harness.projectId);

      const problem = JSON.parse(
        (await harness.repos.gitOperations.getById(operationId))?.error ?? "{}",
      ) as Record<string, unknown>;
      expect(problem["code"]).toBe("submission-conflict");
      expect(problem["status"]).toBe(409);
    } finally {
      harness.close();
    }
  });
});
