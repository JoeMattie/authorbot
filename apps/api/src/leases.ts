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
 * Eager lease expiration (contract §2): end every active lease whose
 * `expires_at <= now`, return its work item `leased → ready`, and emit
 * `lease_expired`. Race-safe against lazy expiry: `LeasesRepository.expire`
 * is a conditional single-winner UPDATE, so a lease already ended by a
 * concurrent command is skipped without a duplicate event.
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
    const won = await repos.leases.expire(lease.id, now);
    if (won !== 1) {
      continue; // a lazy check or rival sweep got there first
    }
    const statements: SqlStatement[] = [
      // Return the item to `ready` only if it is still `leased` (it may have
      // moved on via submit; the expired lease then just frees its slot).
      db
        .prepare(`UPDATE work_items SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'leased'`)
        .bind(now, lease.workItemId),
      repos.events.appendStatement({
        projectId: lease.projectId,
        type: "lease_expired",
        payload: { leaseId: lease.id, workItemId: lease.workItemId },
        createdAt: now,
      }),
    ];
    await db.batch(statements);
    expired += 1;
  }
  return { expired };
}
