/**
 * Repositories for the Phase 7 access-control tables (migration 0007):
 * `project_access_controls`, `pending_annotations`, `rate_limit_counters`.
 *
 * As everywhere else in this package, every mutating method has a
 * `...Statement` variant returning a bound `SqlStatement` so callers can
 * compose atomic multi-table writes with `db.batch([...])` — an approval must
 * land the annotation row, the git operation, the outbox row, the audit event,
 * and the queue row's transition together or not at all.
 */
import type { SqlDatabase, SqlRow, SqlStatement } from "../sql.js";
import type {
  PendingAnnotationRecord,
  PendingAnnotationStatus,
  ProjectAccessControlRecord,
} from "../records.js";

export class ProjectAccessControlsRepository {
  constructor(private readonly db: SqlDatabase) {}

  async get(projectId: string): Promise<ProjectAccessControlRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM project_access_controls WHERE project_id = ?`)
      .bind(projectId)
      .first();
    return row ? mapAccessControl(row) : null;
  }

  /**
   * Set (or clear) the freeze.
   *
   * Written as an upsert touching only the freeze columns, so freezing a book
   * whose agents are already paused does not silently resume them — the two
   * controls are orthogonal and must stay independently settable, including on
   * the first write when no row exists yet.
   */
  setFreezeStatement(input: {
    projectId: string;
    frozenAt: string | null;
    actorId: string | null;
    reason: string | null;
    at: string;
  }): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO project_access_controls
           (project_id, frozen_at, frozen_by_actor_id, freeze_reason,
            agents_paused_at, agents_paused_by_actor_id, agents_pause_reason,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET
           frozen_at = excluded.frozen_at,
           frozen_by_actor_id = excluded.frozen_by_actor_id,
           freeze_reason = excluded.freeze_reason,
           updated_at = excluded.updated_at`,
      )
      .bind(
        input.projectId,
        input.frozenAt,
        input.frozenAt === null ? null : input.actorId,
        input.frozenAt === null ? null : input.reason,
        input.at,
        input.at,
      );
  }

  /** Set (or clear) the agent pause. See {@link setFreezeStatement}. */
  setAgentsPausedStatement(input: {
    projectId: string;
    pausedAt: string | null;
    actorId: string | null;
    reason: string | null;
    at: string;
  }): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO project_access_controls
           (project_id, frozen_at, frozen_by_actor_id, freeze_reason,
            agents_paused_at, agents_paused_by_actor_id, agents_pause_reason,
            created_at, updated_at)
         VALUES (?, NULL, NULL, NULL, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET
           agents_paused_at = excluded.agents_paused_at,
           agents_paused_by_actor_id = excluded.agents_paused_by_actor_id,
           agents_pause_reason = excluded.agents_pause_reason,
           updated_at = excluded.updated_at`,
      )
      .bind(
        input.projectId,
        input.pausedAt,
        input.pausedAt === null ? null : input.actorId,
        input.pausedAt === null ? null : input.reason,
        input.at,
        input.at,
      );
  }
}

function mapAccessControl(row: SqlRow): ProjectAccessControlRecord {
  return {
    projectId: String(row["project_id"]),
    frozenAt: nullableText(row["frozen_at"]),
    frozenByActorId: nullableText(row["frozen_by_actor_id"]),
    freezeReason: nullableText(row["freeze_reason"]),
    agentsPausedAt: nullableText(row["agents_paused_at"]),
    agentsPausedByActorId: nullableText(row["agents_paused_by_actor_id"]),
    agentsPauseReason: nullableText(row["agents_pause_reason"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export class PendingAnnotationsRepository {
  constructor(private readonly db: SqlDatabase) {}

  insertStatement(record: PendingAnnotationRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO pending_annotations
           (id, project_id, chapter_id, kind, scope, chapter_revision, target,
            author_actor_id, body, status, reviewed_by_actor_id, reviewed_at,
            rejection_reason, approved_annotation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.projectId,
        record.chapterId,
        record.kind,
        record.scope,
        record.chapterRevision,
        record.target === null || record.target === undefined
          ? null
          : JSON.stringify(record.target),
        record.authorActorId,
        record.body,
        record.status,
        record.reviewedByActorId,
        record.reviewedAt,
        record.rejectionReason,
        record.approvedAnnotationId,
        record.createdAt,
        record.updatedAt,
      );
  }

  async insert(record: PendingAnnotationRecord): Promise<void> {
    await this.insertStatement(record).run();
  }

  async getById(id: string): Promise<PendingAnnotationRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM pending_annotations WHERE id = ?`)
      .bind(id)
      .first();
    return row ? mapPendingAnnotation(row) : null;
  }

  /** The queue, oldest first (the order a moderator drains it in). */
  async listByProject(
    projectId: string,
    options: { status?: PendingAnnotationStatus; limit?: number; afterId?: string } = {},
  ): Promise<PendingAnnotationRecord[]> {
    const status = options.status ?? null;
    const rows = await this.db
      .prepare(
        `SELECT * FROM pending_annotations
          WHERE project_id = ?
            AND (? IS NULL OR status = ?)
            AND id > ?
          ORDER BY id
          LIMIT ?`,
      )
      .bind(projectId, status, status, options.afterId ?? "", options.limit ?? 100)
      .all();
    return rows.map(mapPendingAnnotation);
  }

  /** Still-pending rows on one chapter (the read path's author/maintainer view). */
  async listPendingByChapter(chapterId: string): Promise<PendingAnnotationRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM pending_annotations
          WHERE chapter_id = ? AND status = 'pending' ORDER BY id`,
      )
      .bind(chapterId)
      .all();
    return rows.map(mapPendingAnnotation);
  }

  /** How many of this author's submissions to this book landed in each state. */
  async authorHistory(
    projectId: string,
    authorActorId: string,
  ): Promise<{ pending: number; approved: number; rejected: number }> {
    const rows = await this.db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM pending_annotations
          WHERE project_id = ? AND author_actor_id = ? GROUP BY status`,
      )
      .bind(projectId, authorActorId)
      .all();
    const counts = { pending: 0, approved: 0, rejected: 0 };
    for (const row of rows) {
      const key = String(row["status"]) as PendingAnnotationStatus;
      counts[key] = Number(row["n"] ?? 0);
    }
    return counts;
  }

  async countPending(projectId: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM pending_annotations
          WHERE project_id = ? AND status = 'pending'`,
      )
      .bind(projectId)
      .first();
    return Number(row?.["n"] ?? 0);
  }

  /**
   * Resolve a queued row, as a compare-and-swap on `status = 'pending'`.
   *
   * Guarded rather than unconditional because bulk approve and a second
   * moderator clicking the same row are both ordinary: the loser must change
   * zero rows, and the caller reports it as already-reviewed instead of
   * approving something twice (which, for approval, would mean a second commit
   * of the same comment).
   */
  resolveStatement(input: {
    id: string;
    status: Exclude<PendingAnnotationStatus, "pending">;
    reviewedByActorId: string;
    reviewedAt: string;
    rejectionReason: string | null;
    approvedAnnotationId: string | null;
  }): SqlStatement {
    return this.db
      .prepare(
        `UPDATE pending_annotations
            SET status = ?,
                reviewed_by_actor_id = ?,
                reviewed_at = ?,
                rejection_reason = ?,
                approved_annotation_id = ?,
                updated_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .bind(
        input.status,
        input.reviewedByActorId,
        input.reviewedAt,
        input.rejectionReason,
        input.approvedAnnotationId,
        input.reviewedAt,
        input.id,
      );
  }

  async resolve(input: {
    id: string;
    status: Exclude<PendingAnnotationStatus, "pending">;
    reviewedByActorId: string;
    reviewedAt: string;
    rejectionReason: string | null;
    approvedAnnotationId: string | null;
  }): Promise<boolean> {
    const result = await this.resolveStatement(input).run();
    return result.changes > 0;
  }
}

function mapPendingAnnotation(row: SqlRow): PendingAnnotationRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    chapterId: String(row["chapter_id"]),
    kind: String(row["kind"]) as PendingAnnotationRecord["kind"],
    scope: String(row["scope"]) as PendingAnnotationRecord["scope"],
    chapterRevision: Number(row["chapter_revision"]),
    target: row["target"] === null ? null : (JSON.parse(String(row["target"])) as unknown),
    authorActorId: String(row["author_actor_id"]),
    body: String(row["body"]),
    status: String(row["status"]) as PendingAnnotationStatus,
    reviewedByActorId: nullableText(row["reviewed_by_actor_id"]),
    reviewedAt: nullableText(row["reviewed_at"]),
    rejectionReason: nullableText(row["rejection_reason"]),
    approvedAnnotationId: nullableText(row["approved_annotation_id"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

export class RateLimitCountersRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Count this request against `(subject, class, windowStart)` and return the
   * running total INCLUDING it.
   *
   * Two statements rather than one `RETURNING` clause: `RETURNING` is available
   * in both adapters' SQLite, but the portability interface this package is
   * written against (`SqlStatement`) makes no promise about a write returning
   * rows, and the limiter is not the place to start depending on one. The read
   * that follows the upsert can only ever over-report under concurrency (a
   * rival increment landing in between), which errs toward limiting rather than
   * toward letting a fleet through — the safe direction for this control.
   */
  async increment(input: {
    subject: string;
    class: string;
    windowStart: string;
    expiresAt: string;
  }): Promise<number> {
    await this.db
      .prepare(
        `INSERT INTO rate_limit_counters (subject, class, window_start, count, expires_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT (subject, class, window_start)
           DO UPDATE SET count = count + 1`,
      )
      .bind(input.subject, input.class, input.windowStart, input.expiresAt)
      .run();
    const row = await this.db
      .prepare(
        `SELECT count FROM rate_limit_counters
          WHERE subject = ? AND class = ? AND window_start = ?`,
      )
      .bind(input.subject, input.class, input.windowStart)
      .first();
    return Number(row?.["count"] ?? 1);
  }

  /** Current count without recording a request (reads must not consume quota). */
  async peek(subject: string, className: string, windowStart: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT count FROM rate_limit_counters
          WHERE subject = ? AND class = ? AND window_start = ?`,
      )
      .bind(subject, className, windowStart)
      .first();
    return Number(row?.["count"] ?? 0);
  }

  /** Drop closed windows. Called opportunistically, never on a schedule. */
  async deleteExpired(now: string): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM rate_limit_counters WHERE expires_at <= ?`)
      .bind(now)
      .run();
    return result.changes;
  }
}
