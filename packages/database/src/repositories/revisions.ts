/** Persistence for immutable chapter/summary proposals (migration 0011). */
import type { SqlDatabase, SqlRow, SqlStatement, SqlValue } from "../sql.js";
import type {
  RevisionProposalRecord,
  RevisionProposalStatus,
} from "../records.js";
import type { ListPage } from "./content.js";

export interface RevisionProposalListOptions extends ListPage {
  status?: RevisionProposalStatus;
  chapterId?: string;
}

export interface RevisionProposalReviewUpdate {
  status: RevisionProposalStatus;
  reviewedByActorId: string;
  reviewedAt: string;
  reviewReason: string | null;
  /** Omitted review operations store no Git operation. */
  gitOperationId?: string | null;
  updatedAt: string;
}

export interface RevisionProposalFinalizeUpdate {
  status: RevisionProposalStatus;
  resultingRevision?: number | null;
  commitSha?: string | null;
  updatedAt: string;
}

export class RevisionProposalsRepository {
  constructor(private readonly db: SqlDatabase) {}

  insertStatement(record: RevisionProposalRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO revision_proposals
           (id, project_id, chapter_id, proposal_type, origin, work_item_id,
            submission_id, author_actor_id, base_revision, base_content_hash,
            base_content, proposed_content, change_summary, notes, status,
            reviewed_by_actor_id, reviewed_at, review_reason, git_operation_id,
            resulting_revision, commit_sha, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.projectId,
        record.chapterId,
        record.proposalType,
        record.origin,
        record.workItemId,
        record.submissionId,
        record.authorActorId,
        record.baseRevision,
        record.baseContentHash,
        record.baseContent,
        record.proposedContent,
        record.changeSummary,
        record.notes,
        record.status,
        record.reviewedByActorId,
        record.reviewedAt,
        record.reviewReason,
        record.gitOperationId,
        record.resultingRevision,
        record.commitSha,
        record.createdAt,
        record.updatedAt,
      );
  }

  async insert(record: RevisionProposalRecord): Promise<void> {
    await this.insertStatement(record).run();
  }

  async getById(id: string): Promise<RevisionProposalRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM revision_proposals WHERE id = ?`)
      .bind(id)
      .first();
    return row ? mapRevisionProposal(row) : null;
  }

  async getBySubmissionId(submissionId: string): Promise<RevisionProposalRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM revision_proposals WHERE submission_id = ?`)
      .bind(submissionId)
      .first();
    return row ? mapRevisionProposal(row) : null;
  }

  /** UUIDv7 cursor page, optionally narrowed to the review queue or chapter. */
  async listByProject(
    projectId: string,
    options?: RevisionProposalListOptions,
  ): Promise<RevisionProposalRecord[]> {
    const conditions = ["project_id = ?", "id > ?"];
    const values: SqlValue[] = [projectId, options?.afterId ?? ""];
    if (options?.status !== undefined) {
      conditions.push("status = ?");
      values.push(options.status);
    }
    if (options?.chapterId !== undefined) {
      conditions.push("chapter_id = ?");
      values.push(options.chapterId);
    }
    values.push(options?.limit ?? 100);
    const rows = await this.db
      .prepare(
        `SELECT * FROM revision_proposals
          WHERE ${conditions.join(" AND ")}
          ORDER BY id LIMIT ?`,
      )
      .bind(...values)
      .all();
    return rows.map(mapRevisionProposal);
  }

  async listByWorkItem(workItemId: string, page?: ListPage): Promise<RevisionProposalRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM revision_proposals
          WHERE work_item_id = ? AND id > ?
          ORDER BY id LIMIT ?`,
      )
      .bind(workItemId, page?.afterId ?? "", page?.limit ?? 100)
      .all();
    return rows.map(mapRevisionProposal);
  }

  /**
   * Generic compare-and-swap status transition. Domain code owns the legal
   * edge list; this guard makes a stale or duplicated transition affect zero
   * rows rather than overwriting a concurrent decision.
   */
  transitionStatusStatement(
    id: string,
    fromStatus: RevisionProposalStatus,
    toStatus: RevisionProposalStatus,
    updatedAt: string,
  ): SqlStatement {
    return this.db
      .prepare(
        `UPDATE revision_proposals
            SET status = ?, updated_at = ?
          WHERE id = ? AND status = ?`,
      )
      .bind(toStatus, updatedAt, id, fromStatus);
  }

  async transitionStatus(
    id: string,
    fromStatus: RevisionProposalStatus,
    toStatus: RevisionProposalStatus,
    updatedAt: string,
  ): Promise<number> {
    const result = await this.transitionStatusStatement(id, fromStatus, toStatus, updatedAt).run();
    return result.changes;
  }

  /**
   * Atomically records a maintainer decision (and, for approval, its queued
   * Git operation) while guarding against a stale `fromStatus`.
   */
  transitionReviewStatement(
    id: string,
    fromStatus: RevisionProposalStatus,
    update: RevisionProposalReviewUpdate,
  ): SqlStatement {
    return this.db
      .prepare(
        `UPDATE revision_proposals
            SET status = ?, reviewed_by_actor_id = ?, reviewed_at = ?,
                review_reason = ?, git_operation_id = ?, updated_at = ?
          WHERE id = ? AND status = ?`,
      )
      .bind(
        update.status,
        update.reviewedByActorId,
        update.reviewedAt,
        update.reviewReason,
        update.gitOperationId ?? null,
        update.updatedAt,
        id,
        fromStatus,
      );
  }

  async transitionReview(
    id: string,
    fromStatus: RevisionProposalStatus,
    update: RevisionProposalReviewUpdate,
  ): Promise<number> {
    const result = await this.transitionReviewStatement(id, fromStatus, update).run();
    return result.changes;
  }

  /** Complete an apply attempt without altering the retained review record. */
  finalizeStatement(
    id: string,
    fromStatus: RevisionProposalStatus,
    update: RevisionProposalFinalizeUpdate,
  ): SqlStatement {
    return this.db
      .prepare(
        `UPDATE revision_proposals
            SET status = ?, resulting_revision = ?, commit_sha = ?, updated_at = ?
          WHERE id = ? AND status = ?`,
      )
      .bind(
        update.status,
        update.resultingRevision ?? null,
        update.commitSha ?? null,
        update.updatedAt,
        id,
        fromStatus,
      );
  }

  async finalize(
    id: string,
    fromStatus: RevisionProposalStatus,
    update: RevisionProposalFinalizeUpdate,
  ): Promise<number> {
    const result = await this.finalizeStatement(id, fromStatus, update).run();
    return result.changes;
  }
}

function mapRevisionProposal(row: SqlRow): RevisionProposalRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    chapterId: String(row["chapter_id"]),
    proposalType: String(row["proposal_type"]) as RevisionProposalRecord["proposalType"],
    origin: String(row["origin"]) as RevisionProposalRecord["origin"],
    workItemId: row["work_item_id"] === null ? null : String(row["work_item_id"]),
    submissionId: row["submission_id"] === null ? null : String(row["submission_id"]),
    authorActorId: String(row["author_actor_id"]),
    baseRevision: Number(row["base_revision"]),
    baseContentHash: String(row["base_content_hash"]),
    baseContent: String(row["base_content"]),
    proposedContent: String(row["proposed_content"]),
    changeSummary: row["change_summary"] === null ? null : String(row["change_summary"]),
    notes: row["notes"] === null ? null : String(row["notes"]),
    status: String(row["status"]) as RevisionProposalStatus,
    reviewedByActorId:
      row["reviewed_by_actor_id"] === null ? null : String(row["reviewed_by_actor_id"]),
    reviewedAt: row["reviewed_at"] === null ? null : String(row["reviewed_at"]),
    reviewReason: row["review_reason"] === null ? null : String(row["review_reason"]),
    gitOperationId:
      row["git_operation_id"] === null ? null : String(row["git_operation_id"]),
    resultingRevision:
      row["resulting_revision"] === null ? null : Number(row["resulting_revision"]),
    commitSha: row["commit_sha"] === null ? null : String(row["commit_sha"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}
