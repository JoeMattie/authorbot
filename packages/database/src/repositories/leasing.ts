/**
 * Repositories for the Phase 4 tables: leases and submissions (Phase 4
 * contract §2, §4; design §12).
 *
 * Lease claiming is a single INSERT arbitrated by the partial unique index
 * `idx_leases_active_work_item` (`WHERE released_at IS NULL AND revoked_at
 * IS NULL`): of two simultaneous claims exactly one INSERT succeeds and the
 * loser gets a typed `lease_held` result, never an exception (contract §2).
 *
 * Vocabulary (defined in migration 0004): a lease is ACTIVE while
 * `released_at IS NULL AND revoked_at IS NULL` (it occupies the work item's
 * one slot); it is LIVE — able to renew or back a submission — only while
 * additionally `expires_at > now` at query time. Expiry is lazy: expired ⇔
 * `expires_at <= now`, enforced by every conditional UPDATE here and by the
 * sweep, never by trusting a countdown.
 *
 * Lease tokens NEVER appear in this module: only SHA-256 hashes are stored,
 * and this repository neither logs nor returns anything derived from the
 * plaintext. Constant-time token comparison is the API layer's job.
 */
import { isUniqueConstraintError, type SqlDatabase, type SqlRow, type SqlStatement } from "../sql.js";
import type {
  LeaseRecord,
  SubmissionRecord,
  SubmissionState,
  SubmissionType,
} from "../records.js";
import type { ListPage } from "./content.js";

/**
 * Outcome of a lease claim. `lease_held` is a NORMAL outcome — the caller
 * lost the benign race on the partial unique index and receives the lease
 * currently holding the slot (which may already be expired-but-unswept; the
 * claim command is expected to lazily expire it and retry in the same
 * serialized command). The API maps it to 409 `lease-held`, exposing
 * holder-safe fields only (never `tokenHash`).
 */
export type LeaseClaimResult =
  | { status: "claimed"; lease: LeaseRecord }
  | { status: "lease_held"; holder: LeaseRecord };

export class LeasesRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Bare INSERT for composing the claim command's one DB batch (lease +
   * work-item `ready → leased` + audit + event). When the batch aborts with
   * a unique violation on `idx_leases_active_work_item`
   * (`isUniqueConstraintError`), re-read via `getActiveByWorkItem` and
   * proceed as lease-held.
   */
  claimStatement(record: LeaseRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO leases
           (id, project_id, work_item_id, actor_id, token_hash, issued_at,
            expires_at, max_expires_at, renewal_count, released_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.projectId,
        record.workItemId,
        record.actorId,
        record.tokenHash,
        record.issuedAt,
        record.expiresAt,
        record.maxExpiresAt,
        record.renewalCount,
        record.releasedAt,
        record.revokedAt,
      );
  }

  /**
   * Claim: one conditional INSERT that loses cleanly. Success ⇔ no active
   * lease row existed for the work item at commit time; the partial unique
   * index is the arbiter, so two simultaneous claims produce exactly one
   * `claimed`. Never throws for that unique violation.
   */
  async claim(record: LeaseRecord): Promise<LeaseClaimResult> {
    try {
      await this.claimStatement(record).run();
      return { status: "claimed", lease: record };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const holder = await this.getActiveByWorkItem(record.workItemId);
      if (holder === null) throw error; // Some other unique index (e.g. id).
      return { status: "lease_held", holder };
    }
  }

  async getById(id: string): Promise<LeaseRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM leases WHERE id = ?`).bind(id).first();
    return row ? mapLease(row) : null;
  }

  /**
   * The lease currently occupying the work item's slot, if any. May be
   * expired-but-unswept — callers deciding liveness must also compare
   * `expiresAt` against their clock.
   */
  async getActiveByWorkItem(workItemId: string): Promise<LeaseRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM leases
         WHERE work_item_id = ? AND released_at IS NULL AND revoked_at IS NULL`,
      )
      .bind(workItemId)
      .first();
    return row ? mapLease(row) : null;
  }

  /**
   * Renew: conditional UPDATE, succeeds (1 row) only when the lease is LIVE
   * at `now` (active AND `expires_at > now`) and headroom remains below
   * `max_expires_at`. The new expiry is capped at `max_expires_at` in SQL
   * (design §12.3: extend by the renewal duration, never past the maximum
   * total). A renewal attempted when `expires_at` already equals
   * `max_expires_at` affects 0 rows — the max-total-exceeded rejection.
   * Renewing an expired/released/revoked lease likewise affects 0 rows.
   */
  renewStatement(id: string, newExpiresAt: string, now: string): SqlStatement {
    return this.db
      .prepare(
        `UPDATE leases
         SET expires_at = MIN(?, max_expires_at),
             renewal_count = renewal_count + 1
         WHERE id = ?
           AND released_at IS NULL AND revoked_at IS NULL
           AND expires_at > ?
           AND expires_at < max_expires_at`,
      )
      .bind(newExpiresAt, id, now);
  }

  /** Affected-row count: 1 = renewed, 0 = not live / no headroom / missing. */
  async renew(id: string, newExpiresAt: string, now: string): Promise<number> {
    const result = await this.renewStatement(id, newExpiresAt, now).run();
    return result.changes;
  }

  /**
   * Release: conditional UPDATE ending an ACTIVE lease voluntarily (holder
   * or maintainer, `POST .../lease/release`). Liveness is NOT required — a
   * holder may release an already-expired-but-unswept lease; either way the
   * slot frees. 0 rows ⇔ the lease was already ended or does not exist.
   */
  releaseStatement(id: string, releasedAt: string): SqlStatement {
    return this.db
      .prepare(
        `UPDATE leases SET released_at = ?
         WHERE id = ? AND released_at IS NULL AND revoked_at IS NULL`,
      )
      .bind(releasedAt, id);
  }

  /** Affected-row count: 1 = released, 0 = already ended / missing. */
  async release(id: string, releasedAt: string): Promise<number> {
    const result = await this.releaseStatement(id, releasedAt).run();
    return result.changes;
  }

  /**
   * Expire one lease by id: conditional UPDATE that ends (sets
   * `revoked_at`) an active lease **only if it is actually expired at
   * `now`** (`expires_at <= now`). Safe to race: at most one caller
   * observes 1 row changed, so the `lease_expired` event is emitted once.
   */
  expireStatement(id: string, now: string): SqlStatement {
    return this.db
      .prepare(
        `UPDATE leases SET revoked_at = ?
         WHERE id = ?
           AND released_at IS NULL AND revoked_at IS NULL
           AND expires_at <= ?`,
      )
      .bind(now, id, now);
  }

  /** Affected-row count: 1 = expired now, 0 = still live / already ended. */
  async expire(id: string, now: string): Promise<number> {
    const result = await this.expireStatement(id, now).run();
    return result.changes;
  }

  /**
   * Expire whatever active lease holds a work item's slot, if it is expired
   * at `now` — composed into the claim batch so "claim an item whose lease
   * expired" frees the slot and inserts the new lease atomically (design
   * §12.2 step 1). A live lease is left untouched (the subsequent INSERT
   * then loses cleanly).
   */
  expireForWorkItemStatement(workItemId: string, now: string): SqlStatement {
    return this.db
      .prepare(
        `UPDATE leases SET revoked_at = ?
         WHERE work_item_id = ?
           AND released_at IS NULL AND revoked_at IS NULL
           AND expires_at <= ?`,
      )
      .bind(now, workItemId, now);
  }

  async expireForWorkItem(workItemId: string, now: string): Promise<number> {
    const result = await this.expireForWorkItemStatement(workItemId, now).run();
    return result.changes;
  }

  /**
   * The sweep query (contract §2: `sweepExpiredLeases(db, clock)` in the API
   * layer drives this): active leases whose `expires_at <= now`, oldest
   * expiry first, scanning only the partial index's active slice. The
   * sweeper then calls `expire(id, now)` per lease — whose conditional
   * UPDATE makes the sweep race-safe against lazy expiry — and emits
   * `lease_expired` / returns the work item to `ready` for each 1-row
   * result.
   */
  async listExpired(now: string, limit = 100): Promise<LeaseRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM leases
         WHERE released_at IS NULL AND revoked_at IS NULL AND expires_at <= ?
         ORDER BY expires_at, id LIMIT ?`,
      )
      .bind(now, limit)
      .all();
    return rows.map(mapLease);
  }
}

function mapLease(row: SqlRow): LeaseRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    workItemId: String(row["work_item_id"]),
    actorId: String(row["actor_id"]),
    tokenHash: String(row["token_hash"]),
    issuedAt: String(row["issued_at"]),
    expiresAt: String(row["expires_at"]),
    maxExpiresAt: String(row["max_expires_at"]),
    renewalCount: Number(row["renewal_count"]),
    releasedAt: row["released_at"] === null ? null : String(row["released_at"]),
    revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
  };
}

export class SubmissionsRepository {
  constructor(private readonly db: SqlDatabase) {}

  insertStatement(record: SubmissionRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO submissions
           (id, project_id, work_item_id, lease_id, actor_id, type,
            base_revision, base_content_hash, content, summary, notes, state,
            git_operation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.projectId,
        record.workItemId,
        record.leaseId,
        record.actorId,
        record.type,
        record.baseRevision,
        record.baseContentHash,
        record.content,
        record.summary,
        record.notes,
        record.state,
        record.gitOperationId,
        record.createdAt,
        record.updatedAt,
      );
  }

  async insert(record: SubmissionRecord): Promise<void> {
    await this.insertStatement(record).run();
  }

  async getById(id: string): Promise<SubmissionRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM submissions WHERE id = ?`).bind(id).first();
    return row ? mapSubmission(row) : null;
  }

  /** Cursor-paginated (UUIDv7 ids are time-ordered; same convention as votes). */
  async listByWorkItem(workItemId: string, page?: ListPage): Promise<SubmissionRecord[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM submissions WHERE work_item_id = ? AND id > ? ORDER BY id LIMIT ?`)
      .bind(workItemId, page?.afterId ?? "", page?.limit ?? 100)
      .all();
    return rows.map(mapSubmission);
  }

  async listByProjectState(
    projectId: string,
    state: SubmissionState,
    page?: ListPage,
  ): Promise<SubmissionRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM submissions
         WHERE project_id = ? AND state = ? AND id > ? ORDER BY id LIMIT ?`,
      )
      .bind(projectId, state, page?.afterId ?? "", page?.limit ?? 100)
      .all();
    return rows.map(mapSubmission);
  }

  /**
   * Lifecycle transition as a conditional UPDATE guarded by the expected
   * current state (`received → applying → applied | conflicted`;
   * `received → rejected`): 0 rows ⇔ the submission was not in `fromState`,
   * so concurrent pipeline steps cannot double-apply a transition.
   */
  transitionStateStatement(
    id: string,
    fromState: SubmissionState,
    toState: SubmissionState,
    updatedAt: string,
  ): SqlStatement {
    return this.db
      .prepare(`UPDATE submissions SET state = ?, updated_at = ? WHERE id = ? AND state = ?`)
      .bind(toState, updatedAt, id, fromState);
  }

  /** Affected-row count: 1 = transitioned, 0 = not in `fromState` / missing. */
  async transitionState(
    id: string,
    fromState: SubmissionState,
    toState: SubmissionState,
    updatedAt: string,
  ): Promise<number> {
    const result = await this.transitionStateStatement(id, fromState, toState, updatedAt).run();
    return result.changes;
  }

  /** Link the git_operations row driving the apply (contract §4 202 body). */
  setGitOperationStatement(id: string, gitOperationId: string, updatedAt: string): SqlStatement {
    return this.db
      .prepare(`UPDATE submissions SET git_operation_id = ?, updated_at = ? WHERE id = ?`)
      .bind(gitOperationId, updatedAt, id);
  }

  /** Returns true when the submission existed. */
  async setGitOperation(id: string, gitOperationId: string, updatedAt: string): Promise<boolean> {
    const result = await this.setGitOperationStatement(id, gitOperationId, updatedAt).run();
    return result.changes > 0;
  }
}

function mapSubmission(row: SqlRow): SubmissionRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    workItemId: String(row["work_item_id"]),
    leaseId: String(row["lease_id"]),
    actorId: String(row["actor_id"]),
    type: String(row["type"]) as SubmissionType,
    baseRevision: Number(row["base_revision"]),
    baseContentHash: String(row["base_content_hash"]),
    content: String(row["content"]),
    summary: row["summary"] === null ? null : String(row["summary"]),
    notes: row["notes"] === null ? null : String(row["notes"]),
    state: String(row["state"]) as SubmissionState,
    gitOperationId: row["git_operation_id"] === null ? null : String(row["git_operation_id"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}
