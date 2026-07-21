/**
 * Repository for `book_configs` - the projection of a project's `book.yml`
 * (Phase 6 contract §3.6, migration 0006).
 *
 * The table holds at most one row per project, so there is no list operation
 * and no pagination. Writes are exposed as `SqlStatement`s as well as awaited
 * helpers because a settings PATCH lands the config row, the git operation,
 * the outbox row, and the audit event in ONE `db.batch` - the same
 * one-commit-per-logical-mutation discipline every other write follows.
 */
import type { SqlDatabase, SqlRow, SqlStatement } from "../sql.js";
import type { BookConfigRecord, BookConfigStatus } from "../records.js";

export class BookConfigsRepository {
  constructor(private readonly db: SqlDatabase) {}

  async get(projectId: string): Promise<BookConfigRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM book_configs WHERE project_id = ?`)
      .bind(projectId)
      .first();
    return row ? mapBookConfig(row) : null;
  }

  /**
   * Insert-or-replace the project's config. Keyed on `project_id`, so a
   * settings write and a projection pass converge on one row rather than
   * racing to create two.
   *
   * `created_at` is preserved on update (`excluded` is not used for it): the
   * row records when this project's config was first projected, and a PATCH
   * must not rewrite that.
   */
  upsertStatement(record: BookConfigRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO book_configs
           (project_id, config, status, git_operation_id, source_commit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET
           config = excluded.config,
           status = excluded.status,
           git_operation_id = excluded.git_operation_id,
           source_commit = excluded.source_commit,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.projectId,
        JSON.stringify(record.config),
        record.status,
        record.gitOperationId,
        record.sourceCommit,
        record.createdAt,
        record.updatedAt,
      );
  }

  async upsert(record: BookConfigRecord): Promise<void> {
    await this.upsertStatement(record).run();
  }

  /**
   * Mark a pending config as committed once its git operation lands.
   *
   * Guarded on `git_operation_id` so a *later* settings write that has already
   * replaced this row is never retro-marked committed by the earlier
   * operation's completion - the guard is the compare-and-swap, not a
   * read-then-write.
   */
  markCommittedStatement(
    projectId: string,
    gitOperationId: string,
    sourceCommit: string | null,
    updatedAt: string,
  ): SqlStatement {
    return this.db
      .prepare(
        `UPDATE book_configs
            SET status = 'committed', source_commit = ?, updated_at = ?
          WHERE project_id = ? AND git_operation_id = ?`,
      )
      .bind(sourceCommit, updatedAt, projectId, gitOperationId);
  }

  /**
   * Drop a `pending_git` row whose commit dead-lettered and which has no
   * committed predecessor to fall back to.
   *
   * Guarded on `git_operation_id` and on the pending status for the same
   * compare-and-swap reason {@link markCommittedStatement} is: a later settings
   * write that already replaced this row must not be deleted by its
   * predecessor's failure. Deleting rather than flagging keeps the status
   * vocabulary (and therefore migration 0006's CHECK constraint) untouched,
   * and "no row" already has well-defined meaning everywhere it is read - the
   * projection re-reads `book.yml` from Git, settings report the book as
   * unprojected, and governance falls back to the bootstrap rules.
   */
  deletePendingStatement(projectId: string, gitOperationId: string): SqlStatement {
    return this.db
      .prepare(
        `DELETE FROM book_configs
          WHERE project_id = ? AND git_operation_id = ? AND status = 'pending_git'`,
      )
      .bind(projectId, gitOperationId);
  }
}

function mapBookConfig(row: SqlRow): BookConfigRecord {
  return {
    projectId: String(row["project_id"]),
    config: JSON.parse(String(row["config"])) as unknown,
    status: String(row["status"]) as BookConfigStatus,
    gitOperationId: row["git_operation_id"] === null ? null : String(row["git_operation_id"]),
    sourceCommit: row["source_commit"] === null ? null : String(row["source_commit"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}
