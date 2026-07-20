/**
 * Repositories for operational tables: git_operations, outbox,
 * idempotency_keys, webhook_deliveries, audit_events.
 *
 * `audit_events` is append-only (contract §2): this repository exposes no
 * update or delete, and the schema enforces it with RAISE(ABORT) triggers.
 */
import type { SqlDatabase, SqlRow, SqlStatement } from "../sql.js";
import type {
  AuditEventRecord,
  GitOperationRecord,
  GitOperationState,
  IdempotencyKeyRecord,
  OutboxRecord,
  WebhookDeliveryRecord,
  WebhookDeliveryStatus,
} from "../records.js";

export class GitOperationsRepository {
  constructor(private readonly db: SqlDatabase) {}

  insertStatement(record: GitOperationRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO git_operations
           (id, project_id, correlation_id, expected_head, state, attempts,
            commit_sha, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.projectId,
        record.correlationId,
        record.expectedHead,
        record.state,
        record.attempts,
        record.commitSha,
        record.error,
        record.createdAt,
        record.updatedAt,
      );
  }

  async insert(record: GitOperationRecord): Promise<void> {
    await this.insertStatement(record).run();
  }

  async getById(id: string): Promise<GitOperationRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM git_operations WHERE id = ?`)
      .bind(id)
      .first();
    return row ? mapGitOperation(row) : null;
  }

  updateStateStatement(
    id: string,
    update: {
      state: GitOperationState;
      updatedAt: string;
      attempts?: number;
      commitSha?: string;
      /**
       * Omitted: keep the stored error. `null`: clear it (transitions into
       * `committed`/`queued` must not leave a stale conflict error on a row
       * that later succeeded). A string: set it.
       */
      error?: string | null;
    },
  ): SqlStatement {
    // COALESCE keeps existing values for fields not supplied. `error` needs
    // an explicit set/clear flag because COALESCE can never null a column.
    return this.db
      .prepare(
        `UPDATE git_operations
         SET state = ?,
             updated_at = ?,
             attempts = COALESCE(?, attempts),
             commit_sha = COALESCE(?, commit_sha),
             error = CASE WHEN ? = 1 THEN ? ELSE error END
         WHERE id = ?`,
      )
      .bind(
        update.state,
        update.updatedAt,
        update.attempts ?? null,
        update.commitSha ?? null,
        update.error === undefined ? 0 : 1,
        update.error ?? null,
        id,
      );
  }

  /** Returns true when the operation existed. */
  async updateState(
    id: string,
    update: Parameters<GitOperationsRepository["updateStateStatement"]>[1],
  ): Promise<boolean> {
    const result = await this.updateStateStatement(id, update).run();
    return result.changes > 0;
  }

  async listByProjectAndState(
    projectId: string,
    state: GitOperationState,
  ): Promise<GitOperationRecord[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM git_operations WHERE project_id = ? AND state = ? ORDER BY id`)
      .bind(projectId, state)
      .all();
    return rows.map(mapGitOperation);
  }
}

function mapGitOperation(row: SqlRow): GitOperationRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    correlationId: String(row["correlation_id"]),
    expectedHead: row["expected_head"] === null ? null : String(row["expected_head"]),
    state: String(row["state"]) as GitOperationState,
    attempts: Number(row["attempts"]),
    commitSha: row["commit_sha"] === null ? null : String(row["commit_sha"]),
    error: row["error"] === null ? null : String(row["error"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

export class OutboxRepository {
  constructor(private readonly db: SqlDatabase) {}

  insertStatement(record: OutboxRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO outbox
           (id, project_id, git_operation_id, kind, payload, status, attempts,
            created_at, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.projectId,
        record.gitOperationId,
        record.kind,
        JSON.stringify(record.payload),
        record.status,
        record.attempts,
        record.createdAt,
        record.processedAt,
      );
  }

  async insert(record: OutboxRecord): Promise<void> {
    await this.insertStatement(record).run();
  }

  async getById(id: string): Promise<OutboxRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM outbox WHERE id = ?`).bind(id).first();
    return row ? mapOutbox(row) : null;
  }

  /**
   * The oldest pending row (the per-project serial drain order), optionally ignoring some kinds or ids.
   *
   * `excludeKinds` lets a drain leave a paused kind (`submission.apply` while
   * the project is diverged) `pending` while still draining everything queued
   * behind it; `excludeIds` lets the drain step past a row it could not claim
   * instead of asking for the same one forever.
   */
  async nextPending(
    projectId: string,
    options: { excludeKinds?: readonly string[]; excludeIds?: readonly string[] } = {},
  ): Promise<OutboxRecord | null> {
    const excludeKinds = options.excludeKinds ?? [];
    const excludeIds = options.excludeIds ?? [];
    const clauses: string[] = [`project_id = ?`, `status = 'pending'`];
    const bindings: string[] = [projectId];
    if (excludeKinds.length > 0) {
      clauses.push(`kind NOT IN (${excludeKinds.map(() => "?").join(", ")})`);
      bindings.push(...excludeKinds);
    }
    if (excludeIds.length > 0) {
      clauses.push(`id NOT IN (${excludeIds.map(() => "?").join(", ")})`);
      bindings.push(...excludeIds);
    }
    const row = await this.db
      .prepare(
        `SELECT * FROM outbox WHERE ${clauses.join(" AND ")}
         ORDER BY created_at, id LIMIT 1`,
      )
      .bind(...bindings)
      .first();
    return row ? mapOutbox(row) : null;
  }

  async listPending(projectId: string, limit = 100): Promise<OutboxRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM outbox WHERE project_id = ? AND status = 'pending'
         ORDER BY created_at, id LIMIT ?`,
      )
      .bind(projectId, limit)
      .all();
    return rows.map(mapOutbox);
  }

  /**
   * Claim a pending row: pending → processing, attempts + 1. Returns false
   * when the row was not in `pending` (already claimed or finished).
   */
  async markProcessing(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE outbox SET status = 'processing', attempts = attempts + 1
         WHERE id = ? AND status = 'pending'`,
      )
      .bind(id)
      .run();
    return result.changes > 0;
  }

  markDoneStatement(id: string, processedAt: string): SqlStatement {
    return this.db
      .prepare(`UPDATE outbox SET status = 'done', processed_at = ? WHERE id = ?`)
      .bind(processedAt, id);
  }

  async markDone(id: string, processedAt: string): Promise<void> {
    await this.markDoneStatement(id, processedAt).run();
  }

  markFailedStatement(id: string, processedAt: string): SqlStatement {
    return this.db
      .prepare(`UPDATE outbox SET status = 'failed', processed_at = ? WHERE id = ?`)
      .bind(processedAt, id);
  }

  async markFailed(id: string, processedAt: string): Promise<void> {
    await this.markFailedStatement(id, processedAt).run();
  }

  /** Return a processing row to pending (bounded-retry loop, design §20.2). */
  async markPending(id: string): Promise<void> {
    await this.db
      .prepare(`UPDATE outbox SET status = 'pending' WHERE id = ? AND status = 'processing'`)
      .bind(id)
      .run();
  }
}

function mapOutbox(row: SqlRow): OutboxRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    gitOperationId: row["git_operation_id"] === null ? null : String(row["git_operation_id"]),
    kind: String(row["kind"]),
    payload: JSON.parse(String(row["payload"])) as unknown,
    status: String(row["status"]) as OutboxRecord["status"],
    attempts: Number(row["attempts"]),
    createdAt: String(row["created_at"]),
    processedAt: row["processed_at"] === null ? null : String(row["processed_at"]),
  };
}

export class IdempotencyKeysRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Insert a new key claim. A UNIQUE violation (same project, actor, key)
   * surfaces as an error recognizable via `isUniqueConstraintError`; the
   * caller then loads the stored row and compares `requestHash` (replay vs
   * 409 mismatch, contract §4).
   */
  insertStatement(record: IdempotencyKeyRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO idempotency_keys
           (id, project_id, actor_id, key, request_hash, response_status,
            response_body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.projectId,
        record.actorId,
        record.key,
        record.requestHash,
        record.responseStatus,
        record.responseBody,
        record.createdAt,
      );
  }

  async insert(record: IdempotencyKeyRecord): Promise<void> {
    await this.insertStatement(record).run();
  }

  async get(
    projectId: string,
    actorId: string,
    key: string,
  ): Promise<IdempotencyKeyRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM idempotency_keys WHERE project_id = ? AND actor_id = ? AND key = ?`,
      )
      .bind(projectId, actorId, key)
      .first();
    return row ? mapIdempotencyKey(row) : null;
  }

  /** Store the response for replays after the handler completes. */
  async setResponse(id: string, responseStatus: number, responseBody: string): Promise<void> {
    await this.db
      .prepare(`UPDATE idempotency_keys SET response_status = ?, response_body = ? WHERE id = ?`)
      .bind(responseStatus, responseBody, id)
      .run();
  }
}

function mapIdempotencyKey(row: SqlRow): IdempotencyKeyRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    actorId: String(row["actor_id"]),
    key: String(row["key"]),
    requestHash: String(row["request_hash"]),
    responseStatus: row["response_status"] === null ? null : Number(row["response_status"]),
    responseBody: row["response_body"] === null ? null : String(row["response_body"]),
    createdAt: String(row["created_at"]),
  };
}

export class WebhookDeliveriesRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Record a delivery. A UNIQUE violation on `delivery_id` (recognizable via
   * `isUniqueConstraintError`) means a duplicate delivery to be ignored.
   */
  insertStatement(record: WebhookDeliveryRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO webhook_deliveries
           (id, delivery_id, event, status, received_at, processed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.deliveryId,
        record.event,
        record.status,
        record.receivedAt,
        record.processedAt,
      );
  }

  async insert(record: WebhookDeliveryRecord): Promise<void> {
    await this.insertStatement(record).run();
  }

  async getByDeliveryId(deliveryId: string): Promise<WebhookDeliveryRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM webhook_deliveries WHERE delivery_id = ?`)
      .bind(deliveryId)
      .first();
    return row ? mapWebhookDelivery(row) : null;
  }

  async setStatus(
    id: string,
    status: WebhookDeliveryStatus,
    processedAt: string,
  ): Promise<void> {
    await this.db
      .prepare(`UPDATE webhook_deliveries SET status = ?, processed_at = ? WHERE id = ?`)
      .bind(status, processedAt, id)
      .run();
  }
}

function mapWebhookDelivery(row: SqlRow): WebhookDeliveryRecord {
  return {
    id: String(row["id"]),
    deliveryId: String(row["delivery_id"]),
    event: String(row["event"]),
    status: String(row["status"]) as WebhookDeliveryStatus,
    receivedAt: String(row["received_at"]),
    processedAt: row["processed_at"] === null ? null : String(row["processed_at"]),
  };
}

export class AuditEventsRepository {
  constructor(private readonly db: SqlDatabase) {}

  insertStatement(record: AuditEventRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO audit_events
           (id, project_id, actor_id, action, target_type, target_id,
            correlation_id, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.projectId,
        record.actorId,
        record.action,
        record.targetType,
        record.targetId,
        record.correlationId,
        record.metadata === null ? null : JSON.stringify(record.metadata),
        record.createdAt,
      );
  }

  async insert(record: AuditEventRecord): Promise<void> {
    await this.insertStatement(record).run();
  }

  async listByProject(
    projectId: string,
    page?: { limit?: number; afterId?: string },
  ): Promise<AuditEventRecord[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM audit_events WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?`)
      .bind(projectId, page?.afterId ?? "", page?.limit ?? 100)
      .all();
    return rows.map(mapAuditEvent);
  }
}

function mapAuditEvent(row: SqlRow): AuditEventRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    actorId: row["actor_id"] === null ? null : String(row["actor_id"]),
    action: String(row["action"]),
    targetType: String(row["target_type"]),
    targetId: row["target_id"] === null ? null : String(row["target_id"]),
    correlationId: String(row["correlation_id"]),
    metadata: row["metadata"] === null ? null : (JSON.parse(String(row["metadata"])) as unknown),
    createdAt: String(row["created_at"]),
  };
}
