/**
 * Repositories for the Phase 3 tables: votes, vote_events, decisions,
 * work_items, events (Phase 3 contract §2, §4, §5).
 *
 * `vote_events` is append-only (schema-enforced with RAISE(ABORT) triggers);
 * this repository exposes no update or delete. Decision creation treats the
 * `(source_annotation_id, action_type, rule_version)` unique violation as a
 * typed `already_decided` outcome, never an error (contract §4).
 */
import { isUniqueConstraintError, type SqlDatabase, type SqlRow, type SqlStatement } from "../sql.js";
import type {
  DecisionRecord,
  DecisionResult,
  EventRecord,
  NewEventRecord,
  VoteEventRecord,
  VoteRecord,
  VoteValue,
  WorkItemRecord,
  WorkItemStatus,
} from "../records.js";
import type { ListPage } from "./content.js";

/**
 * SQL-computed aggregate for one annotation - the full Phase 3 contract §2
 * metrics vocabulary. Computed in SQL on demand, never cached denormalized.
 */
export interface VoteTally {
  approvals: number;
  rejections: number;
  abstentions: number;
  netScore: number;
  distinctVoters: number;
  humanApprovals: number;
  agentApprovals: number;
  /**
   * Approvals from actors holding the maintainer role (Phase 6 contract §3.6).
   * Role is read from the voter's *current, unrevoked* membership, not from a
   * snapshot taken when the vote was cast: governance asks "does this book's
   * maintainer support this now?", and a revoked maintainer's stale approval
   * must stop counting.
   */
  maintainerApprovals: number;
  /** Maintainer approvals restricted to `actors.type = 'human'` (§3.6). */
  humanMaintainerApprovals: number;
}

/**
 * One compact, bounded Work-history row. It deliberately excludes retained
 * submission prose: the Work page needs attribution and links, not another
 * copy of a chapter revision payload.
 */
export interface CompletedWorkItemSummary {
  workItem: WorkItemRecord;
  source: {
    kind: string;
    scope: string;
    body: string;
    status: string;
  } | null;
  chapter: {
    title: string;
    slug: string;
  } | null;
  completedBy: {
    actorId: string;
    type: string;
    displayName: string;
    externalIdentity: string | null;
  } | null;
  completedAt: string;
  resultingRevision: number | null;
  commitSha: string | null;
  revisionProposalId: string | null;
  approvedBy: {
    actorId: string;
    type: string;
    displayName: string;
    externalIdentity: string | null;
  } | null;
}

const TALLY_SQL = `
  SELECT
    COALESCE(SUM(CASE WHEN v.value = 'approve' THEN 1 ELSE 0 END), 0) AS approvals,
    COALESCE(SUM(CASE WHEN v.value = 'reject' THEN 1 ELSE 0 END), 0) AS rejections,
    COALESCE(SUM(CASE WHEN v.value = 'abstain' THEN 1 ELSE 0 END), 0) AS abstentions,
    COALESCE(SUM(CASE WHEN v.value = 'approve' THEN 1
                      WHEN v.value = 'reject' THEN -1 ELSE 0 END), 0) AS net_score,
    COUNT(DISTINCT v.actor_id) AS distinct_voters,
    COALESCE(SUM(CASE WHEN v.value = 'approve' AND a.type = 'human' THEN 1 ELSE 0 END), 0)
      AS human_approvals,
    COALESCE(SUM(CASE WHEN v.value = 'approve' AND a.type = 'agent' THEN 1 ELSE 0 END), 0)
      AS agent_approvals,
    COALESCE(SUM(CASE WHEN v.value = 'approve' AND m.id IS NOT NULL THEN 1 ELSE 0 END), 0)
      AS maintainer_approvals,
    COALESCE(SUM(CASE WHEN v.value = 'approve' AND m.id IS NOT NULL AND a.type = 'human'
                      THEN 1 ELSE 0 END), 0)
      AS human_maintainer_approvals
  FROM votes v
  JOIN actors a ON a.id = v.actor_id
  -- LEFT JOIN, and narrowed in the ON clause rather than the WHERE clause: a
  -- non-maintainer voter must still contribute to every other metric.
  LEFT JOIN project_memberships m
    ON m.project_id = v.project_id
   AND m.actor_id = v.actor_id
   AND m.role = 'maintainer'
   AND m.revoked_at IS NULL
  WHERE v.annotation_id = ?`;

export class VotesRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** Insert-or-update on the one-current-vote key (annotation, actor). */
  upsertStatement(record: VoteRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO votes
           (id, project_id, annotation_id, actor_id, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (annotation_id, actor_id) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.id,
        record.projectId,
        record.annotationId,
        record.actorId,
        record.value,
        record.createdAt,
        record.updatedAt,
      );
  }

  /**
   * Upsert the actor's current vote and return the previous value (`null`
   * when this is a first vote). Read-then-write is safe because vote
   * recording runs inside the project's serialized command (contract §3);
   * the unique index still backstops racing writers.
   *
   * On update the existing row keeps its id and created_at; `record.id` is
   * only used when a new row is inserted.
   */
  async upsert(record: VoteRecord): Promise<VoteValue | null> {
    const previous = await this.getCurrent(record.annotationId, record.actorId);
    await this.upsertStatement(record).run();
    return previous?.value ?? null;
  }

  async getCurrent(annotationId: string, actorId: string): Promise<VoteRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM votes WHERE annotation_id = ? AND actor_id = ?`)
      .bind(annotationId, actorId)
      .first();
    return row ? mapVote(row) : null;
  }

  deleteStatement(annotationId: string, actorId: string): SqlStatement {
    return this.db
      .prepare(`DELETE FROM votes WHERE annotation_id = ? AND actor_id = ?`)
      .bind(annotationId, actorId);
  }

  /** Clear the actor's vote, returning the value it had (`null` if none). */
  async clear(annotationId: string, actorId: string): Promise<VoteValue | null> {
    const previous = await this.getCurrent(annotationId, actorId);
    if (previous === null) return null;
    await this.deleteStatement(annotationId, actorId).run();
    return previous.value;
  }

  /** Member-only per-voter listing (contract §2: identity is member-only). */
  async listByAnnotation(annotationId: string, page?: ListPage): Promise<VoteRecord[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM votes WHERE annotation_id = ? AND id > ? ORDER BY id LIMIT ?`)
      .bind(annotationId, page?.afterId ?? "", page?.limit ?? 100)
      .all();
    return rows.map(mapVote);
  }

  /** Aggregate tally by actor type, computed entirely in SQL (contract §2). */
  async tally(annotationId: string): Promise<VoteTally> {
    const row = await this.db.prepare(TALLY_SQL).bind(annotationId).first();
    return {
      approvals: Number(row?.["approvals"] ?? 0),
      rejections: Number(row?.["rejections"] ?? 0),
      abstentions: Number(row?.["abstentions"] ?? 0),
      netScore: Number(row?.["net_score"] ?? 0),
      distinctVoters: Number(row?.["distinct_voters"] ?? 0),
      humanApprovals: Number(row?.["human_approvals"] ?? 0),
      agentApprovals: Number(row?.["agent_approvals"] ?? 0),
      maintainerApprovals: Number(row?.["maintainer_approvals"] ?? 0),
      humanMaintainerApprovals: Number(row?.["human_maintainer_approvals"] ?? 0),
    };
  }
}

function mapVote(row: SqlRow): VoteRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    annotationId: String(row["annotation_id"]),
    actorId: String(row["actor_id"]),
    value: String(row["value"]) as VoteValue,
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

export class VoteEventsRepository {
  constructor(private readonly db: SqlDatabase) {}

  insertStatement(record: VoteEventRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO vote_events
           (id, project_id, annotation_id, actor_id, value, previous_value, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.projectId,
        record.annotationId,
        record.actorId,
        record.value,
        record.previousValue,
        record.createdAt,
      );
  }

  async insert(record: VoteEventRecord): Promise<void> {
    await this.insertStatement(record).run();
  }

  async listByAnnotation(annotationId: string, page?: ListPage): Promise<VoteEventRecord[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM vote_events WHERE annotation_id = ? AND id > ? ORDER BY id LIMIT ?`)
      .bind(annotationId, page?.afterId ?? "", page?.limit ?? 100)
      .all();
    return rows.map(mapVoteEvent);
  }
}

function mapVoteEvent(row: SqlRow): VoteEventRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    annotationId: String(row["annotation_id"]),
    actorId: String(row["actor_id"]),
    value: row["value"] === null ? null : (String(row["value"]) as VoteValue),
    previousValue:
      row["previous_value"] === null ? null : (String(row["previous_value"]) as VoteValue),
    createdAt: String(row["created_at"]),
  };
}

/**
 * Outcome of a decision insert. `already_decided` is a NORMAL outcome - the
 * caller lost a benign race on the `(source_annotation_id, action_type,
 * rule_version)` idempotency key and must treat the existing decision as its
 * own (contract §4: "losers of the race treat unique-violation as
 * already-done, not error").
 */
export type DecisionInsertResult =
  | { status: "inserted"; decision: DecisionRecord }
  | { status: "already_decided"; existing: DecisionRecord };

export class DecisionsRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Bare insert statement for composing the contract §4 one-DB-batch
   * (decision + work item + annotation transition + audit + outbox). When
   * the batch aborts with a unique violation on the idempotency key
   * (`isUniqueConstraintError`), the caller re-reads via `getByKey` and
   * proceeds as already-decided.
   */
  insertStatement(record: DecisionRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO decisions
           (id, project_id, source_annotation_id, action_type, rule,
            rule_version, metrics, result, support_changed, override_reason,
            work_item_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.projectId,
        record.sourceAnnotationId,
        record.actionType,
        record.rule,
        record.ruleVersion,
        JSON.stringify(record.metrics),
        record.result,
        record.supportChanged ? 1 : 0,
        record.overrideReason,
        record.workItemId,
        record.createdAt,
        record.updatedAt,
      );
  }

  /**
   * Insert a decision, resolving the idempotency-key race to a typed result:
   * `inserted` on success, `already_decided` (with the existing row) when
   * another writer holds `(sourceAnnotationId, actionType, ruleVersion)`.
   * Never throws for that unique violation.
   */
  async insert(record: DecisionRecord): Promise<DecisionInsertResult> {
    try {
      await this.insertStatement(record).run();
      return { status: "inserted", decision: record };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      let existing = await this.getByKey(
        record.sourceAnnotationId,
        record.actionType,
        record.ruleVersion,
      );
      // Work-item creation has ONE uniqueness domain per annotation across all
      // rule_versions (contract §4: a rule crossing and a maintainer
      // force-create must not both create a work item). When the collision was
      // on that partial index rather than the exact triple, the existing row
      // carries a different rule_version - find it by action_type.
      if (existing === null && record.actionType === "create_work_item") {
        existing = await this.getWorkItemCreation(record.sourceAnnotationId);
      }
      if (existing === null) throw error; // Some other unique index (e.g. id).
      return { status: "already_decided", existing };
    }
  }

  /**
   * The single work-item-creating decision for an annotation, if any (contract
   * §4: at most one exists, across rule crossings and maintainer
   * force-creates). Used to resolve the cross-rule_version idempotency race and
   * to gate new crossings.
   */
  async getWorkItemCreation(sourceAnnotationId: string): Promise<DecisionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM decisions
         WHERE source_annotation_id = ? AND action_type = 'create_work_item'
         LIMIT 1`,
      )
      .bind(sourceAnnotationId)
      .first();
    return row ? mapDecision(row) : null;
  }

  async getById(id: string): Promise<DecisionRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM decisions WHERE id = ?`).bind(id).first();
    return row ? mapDecision(row) : null;
  }

  /** Lookup by the idempotency key (contract §4). */
  async getByKey(
    sourceAnnotationId: string,
    actionType: string,
    ruleVersion: number,
  ): Promise<DecisionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM decisions
         WHERE source_annotation_id = ? AND action_type = ? AND rule_version = ?`,
      )
      .bind(sourceAnnotationId, actionType, ruleVersion)
      .first();
    return row ? mapDecision(row) : null;
  }

  /**
   * Highest `rule_version` ever recorded for each rule NAME in a project - the
   * high-water mark a settings edit must stay above (Phase 6 §3.6).
   *
   * Rule versions were derived solely from the currently *effective* rules, and
   * `governance.rules` replaces the map wholesale, so deleting a rule and
   * re-adding it under the same name later restarted it at version 1. Decisions
   * are keyed `(source_annotation_id, action_type, rule_version)` with no rule
   * name, so the re-added rule's first evaluation collided with a decision row
   * written by materially different semantics - the exact ambiguity the
   * versioning scheme exists to prevent, and the one
   * `DEFAULT_SUGGESTION_TO_WORK_ITEM_RULE` is pinned at version 2 to avoid.
   *
   * The decision rows are the durable record of which versions have been
   * burned, so they are the authority here rather than a counter that a
   * `book.yml` edit could reset.
   */
  async maxRuleVersions(projectId: string): Promise<Map<string, number>> {
    const rows = await this.db
      .prepare(
        `SELECT rule, MAX(rule_version) AS max_version
           FROM decisions WHERE project_id = ? GROUP BY rule`,
      )
      .bind(projectId)
      .all();
    const out = new Map<string, number>();
    for (const row of rows) {
      out.set(String(row["rule"]), Number(row["max_version"]));
    }
    return out;
  }

  async listByAnnotation(sourceAnnotationId: string): Promise<DecisionRecord[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM decisions WHERE source_annotation_id = ? ORDER BY id`)
      .bind(sourceAnnotationId)
      .all();
    return rows.map(mapDecision);
  }

  /** Sticky-decision flag flip (design §11.3): set on drop, clear on return. */
  setSupportChangedStatement(id: string, supportChanged: boolean, updatedAt: string): SqlStatement {
    return this.db
      .prepare(`UPDATE decisions SET support_changed = ?, updated_at = ? WHERE id = ?`)
      .bind(supportChanged ? 1 : 0, updatedAt, id);
  }

  /** Returns true when the decision existed. */
  async setSupportChanged(id: string, supportChanged: boolean, updatedAt: string): Promise<boolean> {
    const result = await this.setSupportChangedStatement(id, supportChanged, updatedAt).run();
    return result.changes > 0;
  }

  /** Insert-or-update by id - projection rebuild from decision artifacts. */
  upsertStatement(record: DecisionRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO decisions
           (id, project_id, source_annotation_id, action_type, rule,
            rule_version, metrics, result, support_changed, override_reason,
            work_item_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           project_id = excluded.project_id,
           source_annotation_id = excluded.source_annotation_id,
           action_type = excluded.action_type,
           rule = excluded.rule,
           rule_version = excluded.rule_version,
           metrics = excluded.metrics,
           result = excluded.result,
           support_changed = excluded.support_changed,
           override_reason = excluded.override_reason,
           work_item_id = excluded.work_item_id,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.id,
        record.projectId,
        record.sourceAnnotationId,
        record.actionType,
        record.rule,
        record.ruleVersion,
        JSON.stringify(record.metrics),
        record.result,
        record.supportChanged ? 1 : 0,
        record.overrideReason,
        record.workItemId,
        record.createdAt,
        record.updatedAt,
      );
  }

  deleteByProjectStatement(projectId: string): SqlStatement {
    return this.db.prepare(`DELETE FROM decisions WHERE project_id = ?`).bind(projectId);
  }

  async deleteByProject(projectId: string): Promise<number> {
    const result = await this.deleteByProjectStatement(projectId).run();
    return result.changes;
  }
}

function mapDecision(row: SqlRow): DecisionRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    sourceAnnotationId: String(row["source_annotation_id"]),
    actionType: String(row["action_type"]),
    rule: String(row["rule"]),
    ruleVersion: Number(row["rule_version"]),
    metrics: JSON.parse(String(row["metrics"])) as Record<string, number>,
    result: String(row["result"]) as DecisionResult,
    supportChanged: Number(row["support_changed"]) === 1,
    overrideReason: row["override_reason"] === null ? null : String(row["override_reason"]),
    workItemId: row["work_item_id"] === null ? null : String(row["work_item_id"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

export class WorkItemsRepository {
  constructor(private readonly db: SqlDatabase) {}

  insertStatement(record: WorkItemRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO work_items
           (id, project_id, type, status, source_annotation_id, chapter_id,
            base_revision, target, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.projectId,
        record.type,
        record.status,
        record.sourceAnnotationId,
        record.chapterId,
        record.baseRevision,
        record.target === null ? null : JSON.stringify(record.target),
        record.priority,
        record.createdAt,
        record.updatedAt,
      );
  }

  async insert(record: WorkItemRecord): Promise<void> {
    await this.insertStatement(record).run();
  }

  async getById(id: string): Promise<WorkItemRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM work_items WHERE id = ?`).bind(id).first();
    return row ? mapWorkItem(row) : null;
  }

  /**
   * Cursor-paginated listing (UUIDv7 ids are time-ordered; `afterId` is the
   * cursor, same convention as annotations/replies). Optional status filter
   * for the Phase 3 `ready`-queue read API.
   */
  async listByProject(
    projectId: string,
    page?: ListPage & { status?: WorkItemStatus },
  ): Promise<WorkItemRecord[]> {
    const limit = page?.limit ?? 100;
    const afterId = page?.afterId ?? "";
    const rows = page?.status
      ? await this.db
          .prepare(
            `SELECT * FROM work_items
             WHERE project_id = ? AND status = ? AND id > ? ORDER BY id LIMIT ?`,
          )
          .bind(projectId, page.status, afterId, limit)
          .all()
      : await this.db
          .prepare(`SELECT * FROM work_items WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?`)
          .bind(projectId, afterId, limit)
          .all();
    return rows.map(mapWorkItem);
  }

  async listBySourceAnnotation(sourceAnnotationId: string): Promise<WorkItemRecord[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM work_items WHERE source_annotation_id = ? ORDER BY id`)
      .bind(sourceAnnotationId)
      .all();
    return rows.map(mapWorkItem);
  }

  /**
   * Newest completed Work first, enriched in one database query. Correlated
   * subqueries select at most one applied submission and approved proposal
   * from the already-bounded Work page; there is no per-row repository or
   * database fan-out.
   */
  async listCompletedSummaries(
    projectId: string,
    page?: { beforeId?: string; limit?: number },
  ): Promise<CompletedWorkItemSummary[]> {
    const cursor = page?.beforeId ?? "";
    const limit = page?.limit ?? 50;
    const rows = await this.db
      .prepare(
        `WITH completed_page AS (
           SELECT *
           FROM work_items
           WHERE project_id = ?
             AND status = 'completed'
             AND (? = '' OR id < ?)
           ORDER BY id DESC
           LIMIT ?
         )
         SELECT
           w.*,
           a.kind AS source_kind,
           a.scope AS source_scope,
           a.body AS source_body,
           a.status AS source_status,
           c.title AS chapter_title,
           c.slug AS chapter_slug,
           s.actor_id AS completed_by_actor_id,
           submitter.type AS completed_by_type,
           submitter.display_name AS completed_by_name,
           submitter.external_identity AS completed_by_external_identity,
           rp.resulting_revision AS resulting_revision,
           COALESCE(rp.commit_sha, operation.commit_sha) AS completion_commit_sha,
           rp.id AS revision_proposal_id,
           rp.reviewed_by_actor_id AS approved_by_actor_id,
           reviewer.type AS approved_by_type,
           reviewer.display_name AS approved_by_name,
           reviewer.external_identity AS approved_by_external_identity
         FROM completed_page w
         LEFT JOIN annotations a ON a.id = w.source_annotation_id
         LEFT JOIN chapters c ON c.id = w.chapter_id AND c.project_id = w.project_id
         LEFT JOIN submissions s ON s.id = (
           SELECT candidate.id
           FROM submissions candidate
           WHERE candidate.work_item_id = w.id AND candidate.state = 'applied'
           ORDER BY candidate.id DESC
           LIMIT 1
         )
         LEFT JOIN actors submitter ON submitter.id = s.actor_id
         LEFT JOIN revision_proposals rp ON rp.id = (
           SELECT candidate.id
           FROM revision_proposals candidate
           WHERE candidate.work_item_id = w.id AND candidate.status = 'approved'
           ORDER BY candidate.id DESC
           LIMIT 1
         )
         LEFT JOIN actors reviewer ON reviewer.id = rp.reviewed_by_actor_id
         LEFT JOIN git_operations operation
           ON operation.id = COALESCE(rp.git_operation_id, s.git_operation_id)
         ORDER BY w.id DESC`,
      )
      .bind(projectId, cursor, cursor, limit)
      .all();
    return rows.map(mapCompletedWorkItemSummary);
  }

  updateStatusStatement(id: string, status: WorkItemStatus, updatedAt: string): SqlStatement {
    return this.db
      .prepare(`UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?`)
      .bind(status, updatedAt, id);
  }

  /** Returns true when the work item existed. */
  async updateStatus(id: string, status: WorkItemStatus, updatedAt: string): Promise<boolean> {
    const result = await this.updateStatusStatement(id, status, updatedAt).run();
    return result.changes > 0;
  }

  /** Insert-or-update by id - projection rebuild from work-item artifacts. */
  upsertStatement(record: WorkItemRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO work_items
           (id, project_id, type, status, source_annotation_id, chapter_id,
            base_revision, target, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           project_id = excluded.project_id,
           type = excluded.type,
           status = excluded.status,
           source_annotation_id = excluded.source_annotation_id,
           chapter_id = excluded.chapter_id,
           base_revision = excluded.base_revision,
           target = excluded.target,
           priority = excluded.priority,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.id,
        record.projectId,
        record.type,
        record.status,
        record.sourceAnnotationId,
        record.chapterId,
        record.baseRevision,
        record.target === null ? null : JSON.stringify(record.target),
        record.priority,
        record.createdAt,
        record.updatedAt,
      );
  }

  deleteByProjectStatement(projectId: string): SqlStatement {
    return this.db.prepare(`DELETE FROM work_items WHERE project_id = ?`).bind(projectId);
  }

  async deleteByProject(projectId: string): Promise<number> {
    const result = await this.deleteByProjectStatement(projectId).run();
    return result.changes;
  }
}

function mapWorkItem(row: SqlRow): WorkItemRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    type: String(row["type"]) as WorkItemRecord["type"],
    status: String(row["status"]) as WorkItemStatus,
    sourceAnnotationId: String(row["source_annotation_id"]),
    chapterId: String(row["chapter_id"]),
    baseRevision: Number(row["base_revision"]),
    target: row["target"] === null ? null : (JSON.parse(String(row["target"])) as unknown),
    priority: String(row["priority"]) as WorkItemRecord["priority"],
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function mapCompletedWorkItemSummary(row: SqlRow): CompletedWorkItemSummary {
  const sourceKind = nullableString(row["source_kind"]);
  const chapterTitle = nullableString(row["chapter_title"]);
  const completedByActorId = nullableString(row["completed_by_actor_id"]);
  const approvedByActorId = nullableString(row["approved_by_actor_id"]);
  const resultingRevision = row["resulting_revision"];
  return {
    workItem: mapWorkItem(row),
    source:
      sourceKind === null
        ? null
        : {
            kind: sourceKind,
            scope: String(row["source_scope"]),
            body: String(row["source_body"]),
            status: String(row["source_status"]),
          },
    chapter:
      chapterTitle === null
        ? null
        : { title: chapterTitle, slug: String(row["chapter_slug"]) },
    completedBy:
      completedByActorId === null
        ? null
        : {
            actorId: completedByActorId,
            type: String(row["completed_by_type"]),
            displayName: String(row["completed_by_name"]),
            externalIdentity: nullableString(row["completed_by_external_identity"]),
          },
    completedAt: String(row["updated_at"]),
    resultingRevision:
      resultingRevision === null || resultingRevision === undefined
        ? null
        : Number(resultingRevision),
    commitSha: nullableString(row["completion_commit_sha"]),
    revisionProposalId: nullableString(row["revision_proposal_id"]),
    approvedBy:
      approvedByActorId === null
        ? null
        : {
            actorId: approvedByActorId,
            type: String(row["approved_by_type"]),
            displayName: String(row["approved_by_name"]),
            externalIdentity: nullableString(row["approved_by_external_identity"]),
          },
  };
}

export class EventsRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Append statement for composing into a batch; the AUTOINCREMENT id is
   * assigned by the database and available from the batch's `SqlRunResult.lastRowId`.
   */
  appendStatement(event: NewEventRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO events (project_id, type, payload, created_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(event.projectId, event.type, JSON.stringify(event.payload), event.createdAt);
  }

  /** Append one event and return it with its assigned monotonic id. */
  async append(event: NewEventRecord): Promise<EventRecord> {
    const result = await this.appendStatement(event).run();
    if (result.lastRowId === null) {
      throw new Error("events append did not report a row id");
    }
    return { id: result.lastRowId, ...event };
  }

  async getById(id: number): Promise<EventRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
    return row ? mapEvent(row) : null;
  }

  /**
   * Rows strictly after the cursor, in id order - the SSE resume/poll read
   * (`Last-Event-ID` / `?after=`, contract §5). Cursor 0 reads from the start.
   */
  async listAfter(projectId: string, afterId: number, limit = 100): Promise<EventRecord[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM events WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?`)
      .bind(projectId, afterId, limit)
      .all();
    return rows.map(mapEvent);
  }

  /** Highest event id for the project, 0 when none (initial SSE cursor). */
  async latestId(projectId: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COALESCE(MAX(id), 0) AS latest FROM events WHERE project_id = ?`)
      .bind(projectId)
      .first();
    return Number(row?.["latest"] ?? 0);
  }
}

function mapEvent(row: SqlRow): EventRecord {
  return {
    id: Number(row["id"]),
    projectId: String(row["project_id"]),
    type: String(row["type"]),
    payload: JSON.parse(String(row["payload"])) as unknown,
    createdAt: String(row["created_at"]),
  };
}
