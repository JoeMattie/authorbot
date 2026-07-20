/**
 * Repositories for content tables: chapters (projection), annotations,
 * replies. `deleteByProject` methods exist so the projection-rebuild routine
 * (design §7.5) can repopulate from committed Git artifacts.
 */
import type { SqlDatabase, SqlRow, SqlStatement } from "../sql.js";
import type {
  AnnotationRecord,
  AnnotationRecordStatus,
  ChapterProjectionRecord,
  ReplyRecord,
  ReplyRecordStatus,
} from "../records.js";

export interface ListPage {
  /** Maximum rows to return (default 100). */
  limit?: number;
  /** Return rows with id greater than this cursor (UUIDv7 ids are time-ordered). */
  afterId?: string;
}

function pageParams(page: ListPage | undefined): { limit: number; afterId: string } {
  return { limit: page?.limit ?? 100, afterId: page?.afterId ?? "" };
}

export class ChaptersRepository {
  constructor(private readonly db: SqlDatabase) {}

  upsertStatement(record: ChapterProjectionRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO chapters
           (id, project_id, path, slug, title, status, revision, content_hash,
            head_commit, last_published_commit, block_ids, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           path = excluded.path,
           slug = excluded.slug,
           title = excluded.title,
           status = excluded.status,
           revision = excluded.revision,
           content_hash = excluded.content_hash,
           head_commit = excluded.head_commit,
           last_published_commit = excluded.last_published_commit,
           block_ids = excluded.block_ids,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.id,
        record.projectId,
        record.path,
        record.slug,
        record.title,
        record.status,
        record.revision,
        record.contentHash,
        record.headCommit,
        record.lastPublishedCommit,
        JSON.stringify(record.blockIds),
        record.updatedAt,
      );
  }

  async upsert(record: ChapterProjectionRecord): Promise<void> {
    await this.upsertStatement(record).run();
  }

  async getById(id: string): Promise<ChapterProjectionRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM chapters WHERE id = ?`).bind(id).first();
    return row ? mapChapter(row) : null;
  }

  async getBySlug(projectId: string, slug: string): Promise<ChapterProjectionRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM chapters WHERE project_id = ? AND slug = ?`)
      .bind(projectId, slug)
      .first();
    return row ? mapChapter(row) : null;
  }

  async listByProject(projectId: string): Promise<ChapterProjectionRecord[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM chapters WHERE project_id = ? ORDER BY path`)
      .bind(projectId)
      .all();
    return rows.map(mapChapter);
  }

  /** Delete specific rows by id (caller chunks; ids must be non-empty). */
  deleteByIdsStatement(ids: readonly string[]): SqlStatement {
    return this.db
      .prepare(`DELETE FROM chapters WHERE id IN (${ids.map(() => "?").join(", ")})`)
      .bind(...ids);
  }

  deleteByProjectStatement(projectId: string): SqlStatement {
    return this.db.prepare(`DELETE FROM chapters WHERE project_id = ?`).bind(projectId);
  }

  async deleteByProject(projectId: string): Promise<number> {
    const result = await this.deleteByProjectStatement(projectId).run();
    return result.changes;
  }
}

function mapChapter(row: SqlRow): ChapterProjectionRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    path: String(row["path"]),
    slug: String(row["slug"]),
    title: String(row["title"]),
    status: String(row["status"]) as ChapterProjectionRecord["status"],
    revision: Number(row["revision"]),
    contentHash: String(row["content_hash"]),
    headCommit: row["head_commit"] === null ? null : String(row["head_commit"]),
    lastPublishedCommit:
      row["last_published_commit"] === null ? null : String(row["last_published_commit"]),
    blockIds: JSON.parse(String(row["block_ids"] ?? "[]")) as string[],
    updatedAt: String(row["updated_at"]),
  };
}

export class AnnotationsRepository {
  constructor(private readonly db: SqlDatabase) {}

  insertStatement(record: AnnotationRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO annotations
           (id, project_id, chapter_id, kind, scope, chapter_revision, target,
            author_actor_id, body, status, git_operation_id, superseded_by,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.projectId,
        record.chapterId,
        record.kind,
        record.scope,
        record.chapterRevision,
        record.target === null ? null : JSON.stringify(record.target),
        record.authorActorId,
        record.body,
        record.status,
        record.gitOperationId,
        record.supersededBy,
        record.createdAt,
        record.updatedAt,
      );
  }

  async insert(record: AnnotationRecord): Promise<void> {
    await this.insertStatement(record).run();
  }

  async getById(id: string): Promise<AnnotationRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM annotations WHERE id = ?`).bind(id).first();
    return row ? mapAnnotation(row) : null;
  }

  async listByChapter(chapterId: string, page?: ListPage): Promise<AnnotationRecord[]> {
    const { limit, afterId } = pageParams(page);
    const rows = await this.db
      .prepare(
        `SELECT * FROM annotations WHERE chapter_id = ? AND id > ? ORDER BY id LIMIT ?`,
      )
      .bind(chapterId, afterId, limit)
      .all();
    return rows.map(mapAnnotation);
  }

  updateStatusStatement(
    id: string,
    status: AnnotationRecordStatus,
    updatedAt: string,
  ): SqlStatement {
    return this.db
      .prepare(`UPDATE annotations SET status = ?, updated_at = ? WHERE id = ?`)
      .bind(status, updatedAt, id);
  }

  /** Returns true when the annotation existed. */
  async updateStatus(
    id: string,
    status: AnnotationRecordStatus,
    updatedAt: string,
  ): Promise<boolean> {
    const result = await this.updateStatusStatement(id, status, updatedAt).run();
    return result.changes > 0;
  }

  setGitOperationStatement(id: string, gitOperationId: string, updatedAt: string): SqlStatement {
    return this.db
      .prepare(`UPDATE annotations SET git_operation_id = ?, updated_at = ? WHERE id = ?`)
      .bind(gitOperationId, updatedAt, id);
  }

  /**
   * Insert-or-replace by id, updating in place on conflict (FK-safe: child
   * replies keep a valid parent, unlike INSERT OR REPLACE's delete+insert).
   * Used by projection rebuild to apply the repository's truth over an
   * existing row without a destructive delete window.
   */
  upsertStatement(record: AnnotationRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO annotations
           (id, project_id, chapter_id, kind, scope, chapter_revision, target,
            author_actor_id, body, status, git_operation_id, superseded_by,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           project_id = excluded.project_id,
           chapter_id = excluded.chapter_id,
           kind = excluded.kind,
           scope = excluded.scope,
           chapter_revision = excluded.chapter_revision,
           target = excluded.target,
           author_actor_id = excluded.author_actor_id,
           body = excluded.body,
           status = excluded.status,
           git_operation_id = excluded.git_operation_id,
           superseded_by = excluded.superseded_by,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.id,
        record.projectId,
        record.chapterId,
        record.kind,
        record.scope,
        record.chapterRevision,
        record.target === null ? null : JSON.stringify(record.target),
        record.authorActorId,
        record.body,
        record.status,
        record.gitOperationId,
        record.supersededBy,
        record.createdAt,
        record.updatedAt,
      );
  }

  /** Delete specific rows by id (caller chunks; ids must be non-empty). */
  deleteByIdsStatement(ids: readonly string[]): SqlStatement {
    return this.db
      .prepare(`DELETE FROM annotations WHERE id IN (${ids.map(() => "?").join(", ")})`)
      .bind(...ids);
  }

  deleteByProjectStatement(projectId: string): SqlStatement {
    return this.db.prepare(`DELETE FROM annotations WHERE project_id = ?`).bind(projectId);
  }

  async deleteByProject(projectId: string): Promise<number> {
    const result = await this.deleteByProjectStatement(projectId).run();
    return result.changes;
  }
}

function mapAnnotation(row: SqlRow): AnnotationRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    chapterId: String(row["chapter_id"]),
    kind: String(row["kind"]) as AnnotationRecord["kind"],
    scope: String(row["scope"]) as AnnotationRecord["scope"],
    chapterRevision: Number(row["chapter_revision"]),
    target: row["target"] === null ? null : (JSON.parse(String(row["target"])) as unknown),
    authorActorId: String(row["author_actor_id"]),
    body: String(row["body"]),
    status: String(row["status"]) as AnnotationRecordStatus,
    gitOperationId: row["git_operation_id"] === null ? null : String(row["git_operation_id"]),
    supersededBy: row["superseded_by"] === null ? null : String(row["superseded_by"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

export class RepliesRepository {
  constructor(private readonly db: SqlDatabase) {}

  insertStatement(record: ReplyRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO replies
           (id, project_id, annotation_id, parent_reply_id, author_actor_id,
            body, status, git_operation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.projectId,
        record.annotationId,
        record.parentReplyId,
        record.authorActorId,
        record.body,
        record.status,
        record.gitOperationId,
        record.createdAt,
        record.updatedAt,
      );
  }

  async insert(record: ReplyRecord): Promise<void> {
    await this.insertStatement(record).run();
  }

  async getById(id: string): Promise<ReplyRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM replies WHERE id = ?`).bind(id).first();
    return row ? mapReply(row) : null;
  }

  async listByAnnotation(annotationId: string, page?: ListPage): Promise<ReplyRecord[]> {
    const { limit, afterId } = pageParams(page);
    const rows = await this.db
      .prepare(`SELECT * FROM replies WHERE annotation_id = ? AND id > ? ORDER BY id LIMIT ?`)
      .bind(annotationId, afterId, limit)
      .all();
    return rows.map(mapReply);
  }

  updateStatusStatement(id: string, status: ReplyRecordStatus, updatedAt: string): SqlStatement {
    return this.db
      .prepare(`UPDATE replies SET status = ?, updated_at = ? WHERE id = ?`)
      .bind(status, updatedAt, id);
  }

  /** Returns true when the reply existed. */
  async updateStatus(id: string, status: ReplyRecordStatus, updatedAt: string): Promise<boolean> {
    const result = await this.updateStatusStatement(id, status, updatedAt).run();
    return result.changes > 0;
  }

  /** Insert-or-update by id (see AnnotationsRepository.upsertStatement). */
  upsertStatement(record: ReplyRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO replies
           (id, project_id, annotation_id, parent_reply_id, author_actor_id,
            body, status, git_operation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           project_id = excluded.project_id,
           annotation_id = excluded.annotation_id,
           parent_reply_id = excluded.parent_reply_id,
           author_actor_id = excluded.author_actor_id,
           body = excluded.body,
           status = excluded.status,
           git_operation_id = excluded.git_operation_id,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.id,
        record.projectId,
        record.annotationId,
        record.parentReplyId,
        record.authorActorId,
        record.body,
        record.status,
        record.gitOperationId,
        record.createdAt,
        record.updatedAt,
      );
  }

  /** Delete specific rows by id (caller chunks; ids must be non-empty). */
  deleteByIdsStatement(ids: readonly string[]): SqlStatement {
    return this.db
      .prepare(`DELETE FROM replies WHERE id IN (${ids.map(() => "?").join(", ")})`)
      .bind(...ids);
  }

  deleteByProjectStatement(projectId: string): SqlStatement {
    return this.db.prepare(`DELETE FROM replies WHERE project_id = ?`).bind(projectId);
  }

  async deleteByProject(projectId: string): Promise<number> {
    const result = await this.deleteByProjectStatement(projectId).run();
    return result.changes;
  }
}

function mapReply(row: SqlRow): ReplyRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    annotationId: String(row["annotation_id"]),
    parentReplyId: row["parent_reply_id"] === null ? null : String(row["parent_reply_id"]),
    authorActorId: String(row["author_actor_id"]),
    body: String(row["body"]),
    status: String(row["status"]) as ReplyRecordStatus,
    gitOperationId: row["git_operation_id"] === null ? null : String(row["git_operation_id"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}
