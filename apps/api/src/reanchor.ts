/**
 * Post-drain Phase 4 side effects (contract §5 last bullet, §6): after the
 * repo-coordinator processor completes `submission.apply` rows, this hook
 *
 * - re-anchors the chapter's OTHER annotations against the applied revision
 *   (§10.3, deterministic steps only): blockId survives AND — for range
 *   scope — the exact quote is still present in that block's normalized text
 *   → keep, bumping the anchored revision; otherwise `needs_reanchor`. Every
 *   result is recorded in the audit log with {@link REANCHOR_ALGORITHM_VERSION};
 * - records the §12.6 "409-style problem" on a conflicted submission's git
 *   operation (the operation committed the conflict-record artifacts; the
 *   structured problem in `error` tells a polling agent the submission was
 *   NOT applied) and emits `work_item_created` for a freshly created
 *   `resolve_conflict` item.
 *
 * Everything here is recomputed from durable state (chapter projection +
 * committed source + submission/work-item rows) and guarded by
 * already-done checks, so re-running after a crash-recovery drain converges
 * without duplicate events.
 */
import {
  createRepositories,
  type AnnotationRecord,
  type SqlDatabase,
  type SqlStatement,
} from "@authorbot/database";
import { toTimestamp } from "@authorbot/domain";
import { buildBlockCharMap, listMarkedBlocks } from "@authorbot/markdown";
import type { BookRepoWriter, DrainRowOutcome } from "@authorbot/repo-coordinator";
import type { Clock } from "./deps.js";
import { uuidv7 } from "./ids.js";

/** Deterministic re-anchor algorithm identifier (contract §5, design §10.3). */
export const REANCHOR_ALGORITHM_VERSION = "deterministic/v1";

export interface FinalizeSubmissionOptions {
  db: SqlDatabase;
  writer: BookRepoWriter;
  clock: Clock;
}

/**
 * Run the post-drain hook for one drain's outcomes, then reconcile anything
 * an earlier drain owed.
 *
 * `projectId` drives the reconciliation pass, which is what makes this hook
 * crash-safe. The processor's finalize batch atomically marks the operation
 * `committed`, syncs the record, and marks the outbox row `done`; after that
 * the row is neither processing nor pending, so no future drain can re-emit
 * its outcome. A crash in the window between that batch and this hook used to
 * skip the §10.3 pass and the §5 conflict problem PERMANENTLY.
 *
 * Rather than add a marker that could itself be lost, the reconciliation
 * reads the owed work straight out of durable state: annotations whose
 * `chapter_revision` lags their chapter, and conflicted submissions whose
 * operation carries no recorded problem. Both are exactly the conditions this
 * hook exists to clear, so re-running converges and a fresh drain repairs
 * whatever the previous one dropped.
 */
export async function finalizeSubmissionOutcomes(
  options: FinalizeSubmissionOptions,
  projectId: string,
  outcomes: readonly DrainRowOutcome[],
): Promise<void> {
  const { db, writer, clock } = options;
  const repos = createRepositories(db);

  for (const outcome of outcomes) {
    if (outcome.result !== "committed") {
      continue;
    }
    const row = await repos.outbox.getById(outcome.outboxId);
    if (row === null || row.kind !== "submission.apply") {
      continue;
    }
    const payload = row.payload as { submissionId?: unknown; workItemId?: unknown } | null;
    const submissionId = typeof payload?.submissionId === "string" ? payload.submissionId : null;
    const workItemId = typeof payload?.workItemId === "string" ? payload.workItemId : null;
    if (submissionId === null || workItemId === null) {
      continue;
    }
    const submission = await repos.submissions.getById(submissionId);
    const workItem = await repos.workItems.getById(workItemId);
    if (submission === null || workItem === null) {
      continue;
    }
    const ts = toTimestamp(clock.now());

    if (submission.state === "applied") {
      await reanchorChapterAnnotations({ db, writer, clock }, workItem, ts);
      continue;
    }
    if (submission.state === "conflicted" && row.gitOperationId !== null) {
      await recordConflictProblem(
        db,
        repos,
        row.gitOperationId,
        submission,
        workItem,
        ts,
        resolvedConflictReason(row.payload),
      );
    }
  }

  await reconcileOwedFinalization({ db, writer, clock }, projectId);
}

/**
 * Repair finalization work a previous drain committed but never completed
 * (see {@link finalizeSubmissionOutcomes}). Driven entirely by durable state,
 * so it is correct no matter where the earlier process died.
 */
async function reconcileOwedFinalization(
  options: FinalizeSubmissionOptions,
  projectId: string,
): Promise<void> {
  const { db, clock } = options;
  const repos = createRepositories(db);
  const ts = toTimestamp(clock.now());

  // 1. Chapters carrying annotations still anchored to an older revision.
  const stale = await db
    .prepare(
      `SELECT DISTINCT a.chapter_id AS chapter_id
         FROM annotations a
         JOIN chapters c ON c.id = a.chapter_id
        WHERE c.project_id = ?
          AND a.status IN ('open', 'work_item_created')
          AND a.chapter_revision < c.revision
        ORDER BY a.chapter_id
        LIMIT ?`,
    )
    .bind(projectId, RECONCILE_CHAPTER_LIMIT)
    .all();
  for (const chapterRow of stale) {
    const chapterId = String(chapterRow["chapter_id"]);
    await reanchorChapterAnnotations(
      options,
      // No originating work item: every lagging annotation is in scope, and
      // the completed item's own source annotation is already `accepted`, so
      // the status filter excludes it. The sentinel id matches nothing.
      { id: `reconcile:${chapterId}`, projectId, chapterId, sourceAnnotationId: "" },
      ts,
    );
  }

  // 2. Conflicted submissions whose operation never got its §5 problem.
  const conflicted = await repos.submissions.listByProjectState(projectId, "conflicted", {
    limit: RECONCILE_SUBMISSION_LIMIT,
  });
  for (const submission of conflicted) {
    if (submission.gitOperationId === null) continue;
    const operation = await repos.gitOperations.getById(submission.gitOperationId);
    if (operation === null || operation.error !== null) continue;
    const workItem = await repos.workItems.getById(submission.workItemId);
    if (workItem === null) continue;
    const outboxRow = await db
      .prepare(`SELECT payload FROM outbox WHERE git_operation_id = ? LIMIT 1`)
      .bind(submission.gitOperationId)
      .first();
    const payload =
      typeof outboxRow?.["payload"] === "string"
        ? (JSON.parse(outboxRow["payload"]) as unknown)
        : null;
    await recordConflictProblem(
      db,
      repos,
      submission.gitOperationId,
      submission,
      workItem,
      ts,
      resolvedConflictReason(payload),
    );
  }
}

/** The applier's conflict reason as persisted on a `submission.apply` payload. */
function resolvedConflictReason(payload: unknown): string | null {
  const resolved = (payload as { resolved?: { outcome?: { reason?: unknown } } } | null)?.resolved;
  const reason = resolved?.outcome?.reason;
  return typeof reason === "string" && reason !== "" ? reason : null;
}

/** Per-drain reconciliation budgets (the next drain continues the tail). */
const RECONCILE_CHAPTER_LIMIT = 50;
const RECONCILE_SUBMISSION_LIMIT = 100;

/**
 * §10.3 re-anchor for one applied work item's chapter. Reads the committed
 * source through the writer; annotations already at the new revision (or
 * already flagged) are skipped, making replays converge.
 */
async function reanchorChapterAnnotations(
  options: FinalizeSubmissionOptions,
  workItem: { id: string; projectId: string; chapterId: string; sourceAnnotationId: string },
  ts: string,
): Promise<void> {
  const { db, writer, clock } = options;
  const repos = createRepositories(db);
  const chapter = await repos.chapters.getById(workItem.chapterId);
  if (chapter === null || writer.readFile === undefined) {
    return;
  }
  const project = await repos.projects.getById(workItem.projectId);
  if (project === null) {
    return;
  }
  const source = await writer.readFile(project.defaultBranch, chapter.path);
  if (source === null) {
    return;
  }
  const newRevision = chapter.revision;
  const blockSet = new Set(chapter.blockIds);
  let blocks: ReturnType<typeof listMarkedBlocks> | null = null;

  // Page through EVERY annotation on the chapter. A single capped read left
  // the tail permanently un-re-anchored and un-flagged: the cap applies
  // before the status filter and ids are creation-ordered, so on a long-lived
  // chapter the window fills with terminal rows and silently hides live ones.
  // A stale anchor that still looks authoritative is exactly the §10.2 step 6
  // hazard, so the pass must be exhaustive rather than bounded.
  const statements: SqlStatement[] = [];
  for await (const a of eachAnnotation(repos, workItem.chapterId)) {
    if (a.id === workItem.sourceAnnotationId) continue;
    if (a.status !== "open" && a.status !== "work_item_created") continue;
    if (a.chapterRevision >= newRevision) continue; // already re-anchored

    const kept = keptByDeterministicReanchor(a, source, blockSet, () => {
      blocks ??= listMarkedBlocks(source);
      return blocks;
    });

    statements.push(
      kept
        ? db
            .prepare(`UPDATE annotations SET chapter_revision = ?, updated_at = ? WHERE id = ?`)
            .bind(newRevision, ts, a.id)
        : db
            .prepare(
              `UPDATE annotations SET status = 'needs_reanchor', updated_at = ?
               WHERE id = ? AND status IN ('open', 'work_item_created')`,
            )
            .bind(ts, a.id),
      repos.auditEvents.insertStatement({
        id: uuidv7(clock.now()),
        projectId: workItem.projectId,
        actorId: null,
        action: "annotation.reanchor",
        targetType: "annotation",
        targetId: a.id,
        correlationId: workItem.id,
        metadata: {
          result: kept ? "kept" : "needs_reanchor",
          algorithmVersion: REANCHOR_ALGORITHM_VERSION,
          fromRevision: a.chapterRevision,
          toRevision: newRevision,
        },
        createdAt: ts,
      }),
    );
    if (!kept) {
      statements.push(
        repos.events.appendStatement({
          projectId: workItem.projectId,
          type: "annotation_needs_reanchor",
          payload: {
            annotationId: a.id,
            chapterId: workItem.chapterId,
            revision: newRevision,
            algorithmVersion: REANCHOR_ALGORITHM_VERSION,
          },
          createdAt: ts,
        }),
      );
    }
    // Bound the transaction size rather than the work: each flush is
    // self-consistent (every annotation's decision, audit row, and event go
    // in together), and re-running converges because decided annotations are
    // skipped by the guards above.
    if (statements.length >= REANCHOR_BATCH_STATEMENTS) {
      await db.batch(statements.splice(0));
    }
  }
  if (statements.length > 0) {
    await db.batch(statements);
  }
}

/** Statement budget per re-anchor transaction. */
const REANCHOR_BATCH_STATEMENTS = 300;

/** Annotation page size for the exhaustive chapter scan. */
const REANCHOR_PAGE_SIZE = 200;

/** Every annotation on a chapter, oldest id first, paged to exhaustion. */
async function* eachAnnotation(
  repos: ReturnType<typeof createRepositories>,
  chapterId: string,
): AsyncGenerator<AnnotationRecord> {
  let afterId = "";
  for (;;) {
    const page = await repos.annotations.listByChapter(chapterId, {
      limit: REANCHOR_PAGE_SIZE,
      afterId,
    });
    if (page.length === 0) {
      return;
    }
    for (const annotation of page) {
      yield annotation;
    }
    afterId = page[page.length - 1]?.id ?? "";
    if (page.length < REANCHOR_PAGE_SIZE) {
      return;
    }
  }
}

/** Deterministic keep/flag decision for one annotation (design §10.3). */
function keptByDeterministicReanchor(
  annotation: AnnotationRecord,
  source: string,
  blockSet: ReadonlySet<string>,
  getBlocks: () => ReturnType<typeof listMarkedBlocks>,
): boolean {
  if (annotation.scope === "chapter") {
    return true;
  }
  const target = annotation.target as {
    blockId?: unknown;
    textQuote?: { exact?: unknown };
  } | null;
  const blockId = typeof target?.blockId === "string" ? target.blockId : null;
  if (blockId === null || !blockSet.has(blockId)) {
    return false;
  }
  if (annotation.scope === "block") {
    return true;
  }
  const exact = typeof target?.textQuote?.exact === "string" ? target.textQuote.exact : null;
  if (exact === null || exact.length === 0) {
    return false;
  }
  const block = getBlocks().find((b) => b.id === blockId);
  return block !== undefined && buildBlockCharMap(source, block.node).text.includes(exact);
}

/**
 * Record the structured conflict problem on the submission's operation
 * (contract §5: "409-style problem recorded on the operation") and emit
 * `work_item_created` for a newly created conflict item. The operation row
 * keeps its `committed` state — the commit that landed IS the conflict
 * record — while `error` carries the machine-readable refusal. Idempotent:
 * an operation that already carries an error is skipped.
 */
async function recordConflictProblem(
  db: SqlDatabase,
  repos: ReturnType<typeof createRepositories>,
  gitOperationId: string,
  submission: { id: string; workItemId: string },
  workItem: { id: string; projectId: string; chapterId: string; sourceAnnotationId: string },
  ts: string,
  reason: string | null,
): Promise<void> {
  const operation = await repos.gitOperations.getById(gitOperationId);
  if (operation === null || operation.error !== null) {
    return; // already recorded (crash-recovery replay)
  }
  const siblings = await repos.workItems.listBySourceAnnotation(workItem.sourceAnnotationId);
  const conflictItem = siblings.find((w) => w.type === "resolve_conflict" && w.status === "ready");
  const problem = {
    code: "submission-conflict",
    status: 409,
    submissionId: submission.id,
    workItemId: workItem.id,
    conflictWorkItemId: conflictItem?.id ?? null,
    // The applier's deterministic reason, so clients can distinguish a moved
    // base from a payload the patch engine refused instead of asserting a
    // cause they cannot know.
    reason,
  };
  const statements: SqlStatement[] = [
    db
      .prepare(`UPDATE git_operations SET error = ?, updated_at = ? WHERE id = ?`)
      .bind(JSON.stringify(problem), ts, gitOperationId),
  ];
  if (conflictItem !== undefined) {
    statements.push(
      repos.events.appendStatement({
        projectId: workItem.projectId,
        type: "work_item_created",
        payload: {
          workItemId: conflictItem.id,
          annotationId: conflictItem.sourceAnnotationId,
          chapterId: conflictItem.chapterId,
          type: "resolve_conflict",
          baseRevision: conflictItem.baseRevision,
        },
        createdAt: ts,
      }),
    );
  }
  await db.batch(statements);
}
