/**
 * Lease plumbing (Phase 4 contract §2): boot-time `LEASE_*` env validation,
 * token mint/verify helpers (hash-only storage, constant-time compare), and
 * the exported `sweepExpiredLeases(db, clock)` — the eager complement to the
 * lazy expiry every lease-relevant command performs (design §12.4; DO alarm
 * wiring is Phase 5, the dev server runs this on a timer).
 *
 * No lease token, hash, or fragment of either ever reaches a log, an error
 * message, or an event payload from this module.
 */
import {
  createRepositories,
  type SqlDatabase,
  type SqlStatement,
  type SqlValue,
} from "@authorbot/database";
import {
  DEFAULT_LEASE_CONFIG,
  LEASE_TOKEN_PREFIX,
  leaseConfigSchema,
  parseIsoDuration,
  parseLeaseToken,
  toTimestamp,
  type LeaseConfig,
  type LeaseConfigInput,
} from "@authorbot/domain";
import { randomBase64Url, sha256Hex, timingSafeEqual } from "./crypto.js";
import type { Clock } from "./deps.js";

/** Env names for the four durations (contract §2 "`LEASE_*`, validated at boot"). */
export const LEASE_ENV_NAMES = {
  durationMs: "LEASE_DURATION",
  renewalDurationMs: "LEASE_RENEWAL_DURATION",
  maxTotalDurationMs: "LEASE_MAX_TOTAL_DURATION",
  renewalPromptBeforeMs: "LEASE_RENEWAL_PROMPT_BEFORE",
} as const;

/**
 * Parse the `LEASE_*` env overrides (ISO-8601 durations, e.g. `PT30M`) into a
 * validated {@link LeaseConfig}. Throws on any malformed or cross-field
 * invalid value — boot must fail, never silently fall back (contract §2).
 * All-absent yields the design §25 defaults.
 */
export function leaseConfigFromEnv(env: Record<string, string | undefined>): LeaseConfig {
  const input: LeaseConfigInput = {};
  for (const [key, envName] of Object.entries(LEASE_ENV_NAMES) as [
    keyof typeof LEASE_ENV_NAMES,
    string,
  ][]) {
    const raw = env[envName];
    if (raw === undefined || raw.length === 0) {
      continue;
    }
    const parsed = parseIsoDuration(raw);
    if (!parsed.ok) {
      throw new Error(`${envName} must be a positive ISO-8601 duration (got a ${parsed.reason})`);
    }
    input[key] = parsed.ms;
  }
  const result = leaseConfigSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`invalid LEASE_* configuration: ${issue?.message ?? "validation failed"}`);
  }
  return result.data;
}

export interface MintedLeaseToken {
  /** The full plaintext (`authorbot_lease_` + 43 base64url chars). Returned once. */
  token: string;
  /** SHA-256 hex of the secret part — the only stored form. */
  tokenHash: string;
}

/** Mint a fresh opaque 256-bit lease token and its storable hash. */
export async function mintLeaseToken(): Promise<MintedLeaseToken> {
  const secret = randomBase64Url(32);
  return { token: `${LEASE_TOKEN_PREFIX}${secret}`, tokenHash: await sha256Hex(secret) };
}

/**
 * Constant-time verification of a presented lease token against the stored
 * hash. Shape failures and hash mismatches are indistinguishable to the
 * caller-facing result (`false`) and never echo the presented value.
 */
export async function verifyLeaseToken(presented: string, storedHash: string): Promise<boolean> {
  const parsed = parseLeaseToken(presented);
  if (!parsed.ok) {
    return false;
  }
  return timingSafeEqual(await sha256Hex(parsed.secret), storedHash);
}

export interface SweepResult {
  /** Leases this sweep ended (each emitted exactly one `lease_expired` event). */
  expired: number;
}

/**
 * The three statements that end ONE expired lease atomically: the
 * `lease_expired` event, the lease revocation, and the work item's return to
 * `ready`. They MUST be executed as a single `db.batch` — splitting them is
 * what previously let a crash (or a failing second write) strand a work item
 * as `leased` with no active lease row and no event, permanently unclaimable.
 *
 * Single-winner semantics without reading an affected-row count: the event
 * insert runs FIRST and is guarded by the very predicate the revocation then
 * consumes (`active AND expires_at <= now`). Because the batch is one
 * transaction, a rival expiry either committed before us — our guard sees
 * `revoked_at` set, so no event and a 0-row revocation — or commits after us
 * and observes our revocation. Exactly one caller emits the event, whatever
 * the wall clock says (two sweeps sharing a frozen test clock included).
 *
 * The work-item reset additionally requires that no OTHER live lease holds
 * the slot, so a claim that raced in between is never stomped, and it leaves
 * items that already moved on (e.g. to `applying` via submit) untouched.
 */
export function expireLeaseStatements(
  db: SqlDatabase,
  input: {
    projectId: string;
    leaseId: string;
    workItemId: string;
    /** Timestamp used as both the expiry cutoff and the revocation instant. */
    now: string;
  },
): SqlStatement[] {
  const { projectId, leaseId, workItemId, now } = input;
  return [
    leaseExpiredEventStatement(db, {
      projectId,
      leaseId,
      workItemId,
      now,
      guardColumn: "id",
      guardValue: leaseId,
    }),
    db
      .prepare(
        `UPDATE leases SET revoked_at = ?
           WHERE id = ?
             AND released_at IS NULL AND revoked_at IS NULL
             AND expires_at <= ?`,
      )
      .bind(now, leaseId, now),
    workItemReleaseStatement(db, workItemId, now),
  ];
}

/**
 * The claim command's variant, keyed by work item: the same guarded event
 * plus the revocation of whatever expired lease occupies the slot. The claim
 * batch supplies its own work-item compare-and-swap, so no reset is included.
 */
export function expireLeaseForWorkItemStatements(
  db: SqlDatabase,
  input: { projectId: string; leaseId: string; workItemId: string; now: string },
): SqlStatement[] {
  const { projectId, leaseId, workItemId, now } = input;
  return [
    leaseExpiredEventStatement(db, {
      projectId,
      leaseId,
      workItemId,
      now,
      guardColumn: "work_item_id",
      guardValue: workItemId,
    }),
    db
      .prepare(
        `UPDATE leases SET revoked_at = ?
           WHERE work_item_id = ?
             AND released_at IS NULL AND revoked_at IS NULL
             AND expires_at <= ?`,
      )
      .bind(now, workItemId, now),
  ];
}

/**
 * `lease_expired` appended only if an expired-but-active lease is still there
 * to expire. `guardColumn` is a fixed identifier chosen by the two callers
 * above — never caller data — so no value is ever spliced into SQL.
 */
function leaseExpiredEventStatement(
  db: SqlDatabase,
  input: {
    projectId: string;
    leaseId: string;
    workItemId: string;
    now: string;
    guardColumn: "id" | "work_item_id";
    guardValue: string;
  },
): SqlStatement {
  const params: SqlValue[] = [
    input.projectId,
    "lease_expired",
    JSON.stringify({ leaseId: input.leaseId, workItemId: input.workItemId }),
    input.now,
    input.guardValue,
    input.now,
  ];
  return db
    .prepare(
      `INSERT INTO events (project_id, type, payload, created_at)
       SELECT ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM leases
           WHERE ${input.guardColumn} = ?
             AND released_at IS NULL AND revoked_at IS NULL
             AND expires_at <= ?
        )`,
    )
    .bind(...params);
}

/**
 * Return a work item to `ready` — but only while it is still `leased` AND no
 * live lease holds its slot. The second condition is what makes an already
 * stranded item safe to repair and a racing re-claim safe to leave alone.
 */
function workItemReleaseStatement(db: SqlDatabase, workItemId: string, now: string): SqlStatement {
  return db
    .prepare(
      `UPDATE work_items SET status = 'ready', updated_at = ?
         WHERE id = ? AND status = 'leased'
           AND NOT EXISTS (
             SELECT 1 FROM leases
              WHERE work_item_id = ?
                AND released_at IS NULL AND revoked_at IS NULL
                AND expires_at > ?
           )`,
    )
    .bind(now, workItemId, workItemId, now);
}

/**
 * Eager lease expiration (contract §2): end every active lease whose
 * `expires_at <= now`, return its work item `leased → ready`, and emit
 * `lease_expired`. Race-safe against lazy expiry AND crash-safe: each lease
 * is ended by ONE atomic {@link expireLeaseStatements} batch, so there is no
 * window in which the lease is revoked but its work item is still `leased`.
 * A lease already ended by a concurrent command contributes no event and no
 * count (its guarded revocation changes 0 rows).
 */
export async function sweepExpiredLeases(
  db: SqlDatabase,
  clock: Clock,
  limit = 100,
): Promise<SweepResult> {
  const repos = createRepositories(db);
  const now = toTimestamp(clock.now());
  const candidates = await repos.leases.listExpired(now, limit);
  let expired = 0;
  for (const lease of candidates) {
    const results = await db.batch(
      expireLeaseStatements(db, {
        projectId: lease.projectId,
        leaseId: lease.id,
        workItemId: lease.workItemId,
        now,
      }),
    );
    // Index 1 is the guarded revocation: 1 row ⇔ this sweep ended the lease.
    if ((results[1]?.changes ?? 0) === 1) {
      expired += 1;
    }
  }
  return { expired };
}

/**
 * End a lease because its HOLDER lost access (Phase 7 contract "Revoking":
 * revocation must "release any lease they hold, returning the work item to
 * `ready` so their departure does not strand work for up to four hours").
 *
 * Deliberately NOT {@link expireLeaseStatements}. Both of those revoke on the
 * condition `expires_at <= now`, because both describe a lease that ran out of
 * time. A revoked collaborator's lease has not run out of time — that is the
 * whole problem, and it is why the contract calls out "for up to four hours" —
 * so applying the expiry predicate here would change zero rows and strand the
 * item exactly as before.
 *
 * The emitted event is `lease_revoked` rather than `lease_expired` for the same
 * reason the release route distinguishes the two: a feed that says a lease
 * expired when an administrator ended it is lying to everyone reading it.
 *
 * The work-item reset carries the same two guards the expiry path uses — still
 * `leased`, and no OTHER live lease in the slot — so a claim that raced in
 * between is never stomped.
 */
export function revokeLeaseForActorStatements(
  db: SqlDatabase,
  input: { projectId: string; leaseId: string; workItemId: string; now: string },
): SqlStatement[] {
  const { projectId, leaseId, workItemId, now } = input;
  return [
    db
      .prepare(
        `INSERT INTO events (project_id, type, payload, created_at)
         SELECT ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM leases
             WHERE id = ? AND released_at IS NULL AND revoked_at IS NULL
          )`,
      )
      .bind(
        projectId,
        "lease_revoked",
        JSON.stringify({ leaseId, workItemId, reason: "actor-access-revoked" }),
        now,
        leaseId,
      ),
    db
      .prepare(
        `UPDATE leases SET revoked_at = ?
           WHERE id = ? AND released_at IS NULL AND revoked_at IS NULL`,
      )
      .bind(now, leaseId),
    db
      .prepare(
        `UPDATE work_items SET status = 'ready', updated_at = ?
           WHERE id = ? AND status = 'leased'
             AND NOT EXISTS (
               SELECT 1 FROM leases
                WHERE work_item_id = ?
                  AND id <> ?
                  AND released_at IS NULL AND revoked_at IS NULL
                  AND expires_at > ?
             )`,
      )
      .bind(now, workItemId, workItemId, leaseId, now),
  ];
}
