/**
 * Projection rebuild (Phase 2 contract §5, design §7.5): repopulate
 * `chapters`, `annotations`, `replies` from committed Git artifacts. Runs at
 * boot (dev), from tests, and from the GitHub webhook.
 *
 * Durability invariants (contract §5):
 *
 * - Operational rows — status `pending_git` (accepted commands not yet in
 *   Git) and `orphaned` (accepted content whose chapter left the repo) — are
 *   NEVER deleted. They are preserved *in place*: the batch deletes only rows
 *   this rebuild observed as repo-owned and stale, so a mutation accepted
 *   concurrently (between the snapshot read and the batch) can never be wiped
 *   (previously a delete-all + reinsert-from-snapshot lost such rows).
 * - A `pending_git` annotation whose chapter is no longer in the repository
 *   is flipped to `orphaned` (Phase 0 status vocabulary) instead of deleted —
 *   the body exists only in that row. Its git operation and outbox row are
 *   cancelled (`failed`) in the same batch so the drain does not commit an
 *   artifact for a vanished chapter; pending replies to an orphaned
 *   annotation are cancelled the same way but keep their rows.
 * - Everything else is replaced by the repository's truth via id-keyed
 *   upserts (a pending row whose artifact reached the snapshot is upserted to
 *   the committed state).
 */
import type { Repositories, SqlDatabase, SqlRow, SqlStatement } from "@authorbot/database";
import type {
  ActorRecord,
  DecisionRecord,
  ProjectRecord,
  WorkItemRecord,
} from "@authorbot/database";
import type { Clock } from "../deps.js";
import { uuidv7 } from "../ids.js";
import { toTimestamp } from "@authorbot/domain";
import type { BookRepoReader, BookRepoSnapshot, RepoDecisionSnapshot } from "./reader.js";

export interface RebuildResult {
  chapters: number;
  annotations: number;
  replies: number;
  /** Decisions restored from `.authorbot/decisions/` (Phase 3 §4). */
  decisions: number;
  /** Work items restored from `.authorbot/work-items/` (Phase 3 §4). */
  workItems: number;
  /** Operational (pending_git/orphaned) rows left in place, as observed. */
  preservedPending: number;
  /** pending_git annotations flipped to `orphaned` (chapter left the repo), as observed. */
  orphaned: number;
}

/**
 * Recover a decision's `action_type` (the uniqueness key part, absent from the
 * `authorbot.decision/v1` artifact) from its recoverable fields (Phase 3
 * contract §4). The decision's *stored result* disambiguates every case
 * without consulting the referenced work item's mutable current status:
 *
 * - `rule_version >= 1` ⇒ a rule crossing ⇒ `create_work_item`.
 * - `result === "rejected"` ⇒ `reject_suggestion`.
 * - `result === "create_work_item"` (with `rule_version 0`) ⇒ a maintainer
 *   force-create ⇒ `create_work_item`.
 * - `result === "overridden"` ⇒ a cancel (work-item link present) or a reopen
 *   (no link).
 *
 * This distinguishes the force-create-then-cancel history (a force-create
 * decision keeps `result: create_work_item`; the cancel decision on the SAME
 * work item is a separate row with `result: overridden`), which an earlier
 * status-based heuristic collapsed onto one `action_type` and so failed to
 * rebuild.
 */
function deriveDecisionActionType(parsed: RepoDecisionSnapshot["parsed"]): string {
  const { artifact, result } = parsed;
  if (artifact.rule_version >= 1) {
    return "create_work_item";
  }
  if (result === "rejected") {
    return "reject_suggestion";
  }
  if (result === "create_work_item") {
    // Maintainer force-create (rule_version 0), never a cancel/reopen.
    return "create_work_item";
  }
  // result === "overridden" (rule_version 0 cancel or reopen).
  return artifact.work_item_id === undefined ? "reopen_suggestion" : "cancel_work_item";
}

interface RebuildContext {
  db: SqlDatabase;
  repos: Repositories;
  clock: Clock;
}

function actorTypeOf(ref: string): ActorRecord["type"] {
  if (ref.startsWith("agent:")) {
    return "agent";
  }
  if (ref.startsWith("system:")) {
    return "system";
  }
  return "human";
}

/** Row states owned by this API instance, never deleted by a rebuild. */
const OPERATIONAL_ANNOTATION_STATUSES = ["pending_git", "orphaned"] as const;

const DELETE_CHUNK = 50; // stay well under D1's bound-parameter limit

function chunked(ids: string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    chunks.push(ids.slice(i, i + DELETE_CHUNK));
  }
  return chunks;
}

export interface RebuildOptions {
  /**
   * Snapshot the caller already read (Phase 5 §6). Reconciliation classifies
   * a snapshot before deciding whether to project it, so passing it back in
   * avoids a second repository read AND — more importantly — guarantees the
   * bytes that were classified are the bytes that get projected. Re-reading
   * would open a window in which a push between the two reads is projected
   * without ever being checked for divergence.
   */
  snapshot?: BookRepoSnapshot;
}

export async function rebuildProjection(
  ctx: RebuildContext,
  project: ProjectRecord,
  reader: BookRepoReader,
  correlationId: string,
  options: RebuildOptions = {},
): Promise<RebuildResult> {
  const { db, repos, clock } = ctx;
  const now = toTimestamp(clock.now());
  const snapshot = options.snapshot ?? (await reader.readSnapshot());

  const chapterIds = new Set(snapshot.chapters.map((chapter) => chapter.frontmatter.id));
  // Snapshot annotations kept: chapter must be present (repo-side orphan
  // artifacts are skipped); replies kept: their annotation must be kept.
  const keptAnnotations = snapshot.annotations.filter((a) => chapterIds.has(a.record.chapter_id));
  const keptAnnotationIds = new Set(keptAnnotations.map((a) => a.record.id));
  const keptReplies = snapshot.replies.filter((r) => keptAnnotationIds.has(r.record.annotation_id));
  const keptReplyIds = new Set(keptReplies.map((r) => r.record.id));

  // Observe the existing projection (ids + statuses only). Rows created
  // AFTER this read are always operational (`pending_git`) and are only ever
  // touched by status-scoped statements below — never deleted.
  const existingAnnotations: SqlRow[] = await db
    .prepare(`SELECT id, status, chapter_id FROM annotations WHERE project_id = ?`)
    .bind(project.id)
    .all();
  const existingReplies: SqlRow[] = await db
    .prepare(`SELECT id, status, annotation_id, parent_reply_id FROM replies WHERE project_id = ?`)
    .bind(project.id)
    .all();
  const existingChapters: SqlRow[] = await db
    .prepare(`SELECT id FROM chapters WHERE project_id = ?`)
    .bind(project.id)
    .all();

  const isOperational = (status: unknown): boolean =>
    (OPERATIONAL_ANNOTATION_STATUSES as readonly string[]).includes(String(status));

  // Repo-owned rows that vanished from the repo → delete. Operational rows
  // are preserved in place.
  const annotationsToDelete = existingAnnotations
    .filter((row) => !isOperational(row["status"]) && !keptAnnotationIds.has(String(row["id"])))
    .map((row) => String(row["id"]));
  const annotationsToDeleteSet = new Set(annotationsToDelete);
  const replyDeleteSet = new Set(
    existingReplies
      .filter(
        (row) =>
          // repo-owned reply no longer in the snapshot…
          (String(row["status"]) !== "pending_git" && !keptReplyIds.has(String(row["id"]))) ||
          // …or any reply whose annotation row is being deleted (FK).
          annotationsToDeleteSet.has(String(row["annotation_id"])),
      )
      .map((row) => String(row["id"])),
  );
  // Cascade: a surviving reply must not reference a deleted parent
  // (parent_reply_id FK). Fixed-point over reply threads.
  for (;;) {
    const before = replyDeleteSet.size;
    for (const row of existingReplies) {
      const parent = row["parent_reply_id"];
      if (parent !== null && replyDeleteSet.has(String(parent))) {
        replyDeleteSet.add(String(row["id"]));
      }
    }
    if (replyDeleteSet.size === before) {
      break;
    }
  }
  // Delete children before parents across chunks: UUIDv7 ids are
  // time-ordered and a child is always created after its parent, so
  // descending id order is a safe topological order for the FK.
  const repliesToDelete = [...replyDeleteSet].sort((a, b) => (a < b ? 1 : -1));
  const chaptersToDelete = existingChapters
    .map((row) => String(row["id"]))
    .filter((id) => !chapterIds.has(id));

  // Resolve author actor refs to actor rows, creating unknown ones.
  const refs = new Set<string>();
  for (const a of keptAnnotations) {
    refs.add(a.record.author);
  }
  for (const r of keptReplies) {
    refs.add(r.record.author);
  }
  const actorIdByRef = new Map<string, string>();
  const actorInserts: SqlStatement[] = [];
  for (const ref of refs) {
    const existing = await repos.actors.getByExternalIdentity(ref);
    if (existing !== null) {
      actorIdByRef.set(ref, existing.id);
      continue;
    }
    const record: ActorRecord = {
      id: uuidv7(clock.now()),
      type: actorTypeOf(ref),
      displayName: ref.slice(ref.indexOf(":") + 1),
      externalIdentity: ref,
      ownerActorId: null,
      status: "active",
      createdAt: now,
    };
    actorIdByRef.set(ref, record.id);
    actorInserts.push(repos.actors.insertStatement(record));
  }

  const statements: SqlStatement[] = [
    // Delete children before parents (the replies→annotations FK is enforced).
    ...chunked(repliesToDelete).map((ids) => repos.replies.deleteByIdsStatement(ids)),
    ...chunked(annotationsToDelete).map((ids) => repos.annotations.deleteByIdsStatement(ids)),
    ...chunked(chaptersToDelete).map((ids) => repos.chapters.deleteByIdsStatement(ids)),
    ...actorInserts,
  ];

  for (const chapter of snapshot.chapters) {
    statements.push(
      repos.chapters.upsertStatement({
        id: chapter.frontmatter.id,
        projectId: project.id,
        path: chapter.path,
        slug: chapter.frontmatter.slug,
        title: chapter.frontmatter.title,
        status: chapter.frontmatter.status,
        revision: chapter.frontmatter.revision,
        contentHash: chapter.contentHash,
        headCommit: snapshot.headCommit ?? null,
        lastPublishedCommit: null,
        blockIds: chapter.blockIds,
        updatedAt: now,
      }),
    );
  }

  let annotationCount = 0;
  for (const { record, body } of keptAnnotations) {
    const authorId = actorIdByRef.get(record.author);
    if (authorId === undefined) {
      continue;
    }
    statements.push(
      repos.annotations.upsertStatement({
        id: record.id,
        projectId: project.id,
        chapterId: record.chapter_id,
        kind: record.kind,
        scope: record.scope,
        chapterRevision: record.chapter_revision,
        target: record.scope === "chapter" ? null : record.target,
        authorActorId: authorId,
        body,
        status: record.status,
        gitOperationId: null,
        supersededBy: null,
        createdAt: record.created_at,
        updatedAt: now,
      }),
    );
    annotationCount += 1;
  }

  // Orphan pending annotations whose chapter is gone — a pure SQL statement
  // inside the batch, so rows accepted during the snapshot window are
  // handled too (no check-then-act on a stale list).
  statements.push(
    db
      .prepare(
        `UPDATE annotations SET status = 'orphaned', updated_at = ?
         WHERE project_id = ? AND status = 'pending_git'
           AND chapter_id NOT IN (SELECT id FROM chapters WHERE project_id = ?)`,
      )
      .bind(now, project.id, project.id),
    // Cancel their in-flight git operations (and those of pending replies to
    // orphaned annotations): committing an artifact for a vanished chapter
    // would otherwise fail the drain with "annotation not found"-style
    // errors or write artifacts the repo no longer anchors.
    db
      .prepare(
        `UPDATE git_operations SET state = 'failed', updated_at = ?,
           error = 'chapter left the repository; annotation orphaned'
         WHERE project_id = ?
           AND state IN ('queued', 'preparing', 'committing', 'conflict')
           AND id IN (
             SELECT git_operation_id FROM annotations
              WHERE project_id = ? AND status = 'orphaned' AND git_operation_id IS NOT NULL
             UNION
             SELECT r.git_operation_id FROM replies r
              JOIN annotations a ON a.id = r.annotation_id
              WHERE r.project_id = ? AND r.status = 'pending_git'
                AND a.status = 'orphaned' AND r.git_operation_id IS NOT NULL
           )`,
      )
      .bind(now, project.id, project.id, project.id),
    db
      .prepare(
        `UPDATE outbox SET status = 'failed', processed_at = ?
         WHERE project_id = ? AND status IN ('pending', 'processing')
           AND git_operation_id IN (
             SELECT git_operation_id FROM annotations
              WHERE project_id = ? AND status = 'orphaned' AND git_operation_id IS NOT NULL
             UNION
             SELECT r.git_operation_id FROM replies r
              JOIN annotations a ON a.id = r.annotation_id
              WHERE r.project_id = ? AND r.status = 'pending_git'
                AND a.status = 'orphaned' AND r.git_operation_id IS NOT NULL
           )`,
      )
      .bind(now, project.id, project.id, project.id),
  );

  let replyCount = 0;
  for (const { record, body } of keptReplies) {
    const authorId = actorIdByRef.get(record.author);
    if (authorId === undefined) {
      continue;
    }
    statements.push(
      repos.replies.upsertStatement({
        id: record.id,
        projectId: project.id,
        annotationId: record.annotation_id,
        parentReplyId: record.parent_reply_id ?? null,
        authorActorId: authorId,
        body,
        // Reply frontmatter has no status field (Phase 0 contract §4); a
        // committed reply is `open`.
        status: "open",
        gitOperationId: null,
        createdAt: record.created_at,
        updatedAt: record.updated_at ?? now,
      }),
    );
    replyCount += 1;
  }

  // ---- Phase 3: decisions and work items (contract §4 rebuildability) ------
  // `decisions.source_annotation_id`/`work_items.{source_annotation_id,
  // chapter_id}` are deliberately NOT foreign keys (migration 0002), so these
  // sticky rows restore unconditionally from their artifacts. Upsert-by-id:
  // decisions/work items are append-only in the repo (a status change is a
  // re-render of the SAME file), so no stale-delete pass is needed.
  // A work-item artifact ALWAYS says `ready`: leases are operational-only and
  // deliberately never written to Git (Phase 4 contract §6). So restoring
  // `status` verbatim silently resets every currently-leased item to `ready`
  // — on any rebuild, including the push webhook fired by Authorbot's own
  // commits. The lease row survives, leaving the item advertised as available
  // and yet unclaimable (the partial unique index refuses the second lease),
  // which reads as a queue that lies rather than as a bug.
  //
  // The lease is not released here. A chapter moving under a claim does not
  // void the work: Phase 4 §5 rebases a submission whose target still resolves
  // uniquely, and only an ambiguous or overlapping change becomes a conflict.
  // Ending someone's lease because the projection was rebuilt would discard
  // work that was still going to apply cleanly. So the operational status wins
  // over the artifact's ignorance of it.
  const leasedWorkItems = new Set<string>(
    (await repos.leases.listActiveWorkItemIds(project.id, now)) ?? [],
  );
  const snapshotWorkItems = snapshot.workItems ?? [];
  const snapshotDecisions = snapshot.decisions ?? [];

  // The work item's `target` is a snapshot of the source annotation selector
  // (contract §4); the artifact carries only the quoted text, so reconstruct
  // the full selector from the restored annotation (null for chapter scope or
  // when the annotation is absent).
  const annotationTargetById = new Map<string, unknown>();
  for (const { record } of keptAnnotations) {
    annotationTargetById.set(record.id, record.scope === "chapter" ? null : record.target);
  }

  let workItemCount = 0;
  for (const { parsed } of snapshotWorkItems) {
    const wi = parsed.record;
    // Phase 3 only produces `revise_*` items, which always carry these fields;
    // skip any future type lacking a NOT NULL column rather than abort.
    if (
      wi.source_annotation_id === undefined ||
      wi.chapter_id === undefined ||
      wi.base_revision === undefined
    ) {
      continue;
    }
    const target =
      wi.type === "revise_chapter"
        ? null
        : (annotationTargetById.get(wi.source_annotation_id) ?? null);
    const record: WorkItemRecord = {
      id: wi.id,
      projectId: project.id,
      type: wi.type,
      status: leasedWorkItems.has(wi.id) && wi.status === "ready" ? "leased" : wi.status,
      sourceAnnotationId: wi.source_annotation_id,
      chapterId: wi.chapter_id,
      baseRevision: wi.base_revision,
      target,
      priority: wi.priority,
      createdAt: wi.created_at,
      updatedAt: now,
    };
    statements.push(repos.workItems.upsertStatement(record));
    workItemCount += 1;
  }

  let decisionCount = 0;
  for (const { parsed } of snapshotDecisions) {
    const record: DecisionRecord = {
      id: parsed.artifact.id,
      projectId: project.id,
      sourceAnnotationId: parsed.artifact.source_annotation_id,
      actionType: deriveDecisionActionType(parsed),
      rule: parsed.artifact.rule,
      ruleVersion: parsed.artifact.rule_version,
      metrics: parsed.artifact.metrics,
      result: parsed.result,
      supportChanged: parsed.supportChanged,
      overrideReason: parsed.artifact.override_reason ?? null,
      workItemId: parsed.artifact.work_item_id ?? null,
      createdAt: parsed.artifact.effective_at,
      updatedAt: now,
    };
    statements.push(repos.decisions.upsertStatement(record));
    decisionCount += 1;
  }

  // Observed-only counts for the result/audit metadata (the batch statements
  // above are authoritative under concurrency).
  const preservedPending =
    existingAnnotations.filter(
      (row) => isOperational(row.status) && !keptAnnotationIds.has(String(row.id)),
    ).length +
    existingReplies.filter(
      (row) => String(row.status) === "pending_git" && !keptReplyIds.has(String(row.id)),
    ).length;
  const orphaned = existingAnnotations.filter(
    (row) => String(row.status) === "pending_git" && !chapterIds.has(String(row.chapter_id)),
  ).length;

  statements.push(
    repos.auditEvents.insertStatement({
      id: uuidv7(clock.now()),
      projectId: project.id,
      actorId: null,
      action: "projection.rebuild",
      targetType: "project",
      targetId: project.id,
      correlationId,
      metadata: {
        chapters: snapshot.chapters.length,
        annotations: annotationCount,
        replies: replyCount,
        decisions: decisionCount,
        workItems: workItemCount,
        preservedPending,
        orphaned,
      },
      createdAt: now,
    }),
  );

  await db.batch(statements);

  return {
    chapters: snapshot.chapters.length,
    annotations: annotationCount,
    replies: replyCount,
    decisions: decisionCount,
    workItems: workItemCount,
    preservedPending,
    orphaned,
  };
}
