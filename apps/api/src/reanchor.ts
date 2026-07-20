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

/** Run the post-drain hook for one drain's outcomes. */
export async function finalizeSubmissionOutcomes(
  options: FinalizeSubmissionOptions,
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
      await recordConflictProblem(db, repos, row.gitOperationId, submission, workItem, ts);
    }
  }
}

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

  const annotations = await repos.annotations.listByChapter(workItem.chapterId, { limit: 200 });
  const statements: SqlStatement[] = [];
  for (const a of annotations) {
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
  }
  if (statements.length > 0) {
    await db.batch(statements);
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
