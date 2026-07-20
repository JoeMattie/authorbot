import { z } from "zod";
import { type WorkItemStatus } from "@authorbot/schemas";
import { ALLOWED, denied, type Decision, type Denied } from "./decision.js";
import { toTimestamp } from "./token.js";

/**
 * Lease VALUE rules (Phase 4 contract section 2, design sections 12, 25).
 * Pure logic only: claimability, renewability under the max-total cap, and
 * expiry given an injected clock. Token generation, SHA-256 hashing, and the
 * constant-time compare are the API layer's job (as with agent tokens); the
 * serialized compare-and-set that makes two simultaneous claims produce
 * exactly one success is the database's job. Nothing here ever logs or
 * embeds a lease token.
 */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Design section 25 defaults: duration PT30M. */
export const LEASE_DURATION_MS = 30 * MS_PER_MINUTE;
/** Design section 25 defaults: renewal_duration PT30M. */
export const LEASE_RENEWAL_DURATION_MS = 30 * MS_PER_MINUTE;
/** Design section 25 defaults: maximum_total_duration PT4H. */
export const LEASE_MAX_TOTAL_DURATION_MS = 4 * MS_PER_HOUR;
/** Design section 25 defaults: renewal_prompt_before PT5M (UI concern). */
export const LEASE_RENEWAL_PROMPT_BEFORE_MS = 5 * MS_PER_MINUTE;

export type IsoDurationParseResult =
  | { readonly ok: true; readonly ms: number }
  | { readonly ok: false; readonly reason: "bad-format" | "zero-duration" };

const ISO_DURATION_REGEX =
  /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/**
 * Parse the ISO-8601 duration subset the contracts use (`PT30M`, `PT4H`,
 * `P1D`, combinations with integer designators; no years/months/weeks —
 * calendar units are ambiguous in milliseconds). Used to validate `LEASE_*`
 * env overrides at boot (Phase 4 contract section 2).
 */
export function parseIsoDuration(value: string): IsoDurationParseResult {
  const match = ISO_DURATION_REGEX.exec(value);
  if (match === null) {
    return { ok: false, reason: "bad-format" };
  }
  const [, days, hours, minutes, seconds] = match;
  if (
    days === undefined &&
    hours === undefined &&
    minutes === undefined &&
    seconds === undefined
  ) {
    return { ok: false, reason: "bad-format" };
  }
  const ms =
    Number(days ?? 0) * MS_PER_DAY +
    Number(hours ?? 0) * MS_PER_HOUR +
    Number(minutes ?? 0) * MS_PER_MINUTE +
    Number(seconds ?? 0) * MS_PER_SECOND;
  if (ms === 0) {
    return { ok: false, reason: "zero-duration" };
  }
  return { ok: true, ms };
}

/**
 * Lease timing configuration in milliseconds, with design section 25
 * defaults. Boot-time validation of env overrides (contract section 2):
 * every duration positive, renewal prompt strictly inside the duration, and
 * the initial duration within the max total (otherwise a lease would be born
 * beyond its own cap).
 */
export const leaseConfigSchema = z
  .strictObject({
    durationMs: z.number().int().positive().default(LEASE_DURATION_MS),
    renewalDurationMs: z.number().int().positive().default(LEASE_RENEWAL_DURATION_MS),
    maxTotalDurationMs: z.number().int().positive().default(LEASE_MAX_TOTAL_DURATION_MS),
    renewalPromptBeforeMs: z
      .number()
      .int()
      .positive()
      .default(LEASE_RENEWAL_PROMPT_BEFORE_MS),
  })
  .refine((config) => config.renewalPromptBeforeMs < config.durationMs, {
    path: ["renewalPromptBeforeMs"],
    message: "renewal prompt must fire strictly before the lease duration elapses",
  })
  .refine((config) => config.durationMs <= config.maxTotalDurationMs, {
    path: ["durationMs"],
    message: "initial duration must not exceed the maximum total duration",
  });
export type LeaseConfig = z.infer<typeof leaseConfigSchema>;
export type LeaseConfigInput = z.input<typeof leaseConfigSchema>;

/** The design section 25 defaults as a parsed config. */
export const DEFAULT_LEASE_CONFIG: LeaseConfig = Object.freeze(
  leaseConfigSchema.parse({}),
);

/**
 * The clock-relevant columns of a `leases` row (contract section 2). The
 * token hash deliberately does not appear: comparing presented tokens is the
 * API layer's constant-time job.
 */
export interface LeaseSnapshot {
  readonly expiresAt: string;
  readonly maxExpiresAt: string;
  readonly releasedAt?: string | null;
  readonly revokedAt?: string | null;
}

/** Timestamps for a freshly issued lease (claim step; design section 12.2). */
export function resolveLeaseExpiry(
  now: Date,
  config: LeaseConfig = DEFAULT_LEASE_CONFIG,
): { expiresAt: string; maxExpiresAt: string } {
  return {
    expiresAt: toTimestamp(new Date(now.getTime() + config.durationMs)),
    maxExpiresAt: toTimestamp(new Date(now.getTime() + config.maxTotalDurationMs)),
  };
}

/**
 * Expiry is inclusive at exactly `expires_at` (matching `checkTokenActive`):
 * no submission is accepted merely because a countdown still shows 0:00.
 */
export function isLeaseExpired(lease: LeaseSnapshot, now: Date): boolean {
  return now.getTime() >= Date.parse(lease.expiresAt);
}

export type LeaseInactiveReason = "expired" | "released" | "revoked";

/**
 * Whether a lease still backs commands at `now`. Check order follows the
 * contract section 4 verification order ("not expired / not released"):
 * expired first, then released, then revoked. Used by renew, release, and
 * submission checks alike — an expired, released, or revoked lease can do
 * nothing further (contract section 2: renewing an expired lease is a 409).
 */
export function checkLeaseActive(
  lease: LeaseSnapshot,
  now: Date,
): Decision<LeaseInactiveReason> {
  if (isLeaseExpired(lease, now)) {
    return denied("expired", "lease has expired");
  }
  if (lease.releasedAt !== undefined && lease.releasedAt !== null) {
    return denied("released", "lease has been released");
  }
  if (lease.revokedAt !== undefined && lease.revokedAt !== null) {
    return denied("revoked", "lease has been revoked");
  }
  return ALLOWED;
}

export type ClaimDenialReason = "not-claimable" | "lease-held";

export type ClaimCheckResult =
  | {
      readonly allowed: true;
      /**
       * True when the item is still `leased` but its lease is no longer
       * active: the claim command must expire the stale lease in the same
       * serialized batch before issuing the new one (contract section 2).
       */
      readonly priorLeaseExpired: boolean;
    }
  | Denied<ClaimDenialReason>;

/**
 * Claimability (design section 12.2 step 1, contract section 2): the item is
 * `ready`, or it is `leased` and the recorded active lease is no longer
 * active at `now` (expired/released/revoked — lazy expiry). A `leased` item
 * whose lease is still live denies with `lease-held` (the 409 the losing
 * claimant sees; holder-safe messaging is the API's concern). Scope
 * (`work:claim`) and per-type capability checks are separate
 * (`requireScope`, `requiredSubmissionType`).
 */
export function checkWorkItemClaimable(
  status: WorkItemStatus,
  activeLease: LeaseSnapshot | null,
  now: Date,
): ClaimCheckResult {
  if (status === "ready") {
    return { allowed: true, priorLeaseExpired: false };
  }
  if (status !== "leased") {
    return denied(
      "not-claimable",
      `work item in status "${status}" cannot be claimed`,
    );
  }
  if (activeLease === null || checkLeaseActive(activeLease, now).allowed) {
    return denied("lease-held", "work item is already leased");
  }
  return { allowed: true, priorLeaseExpired: true };
}

export type RenewDenialReason = LeaseInactiveReason | "max-total-exceeded";

export type RenewCheckResult =
  | { readonly allowed: true; readonly expiresAt: string }
  | Denied<RenewDenialReason>;

/**
 * Renewal (design section 12.3, contract section 2): only an active lease
 * renews; the new expiry is the current `expires_at` plus the renewal
 * duration ("extends by"), clamped to `max_expires_at`. When the lease
 * already sits at its max-total cap so no extension is possible, the renewal
 * is rejected with `max-total-exceeded` rather than succeeding as a no-op —
 * a partially clamped extension is still allowed. Verifying the presented
 * token against the stored hash happens before this in the API layer.
 */
export function checkLeaseRenewable(
  lease: LeaseSnapshot,
  now: Date,
  config: LeaseConfig = DEFAULT_LEASE_CONFIG,
): RenewCheckResult {
  const active = checkLeaseActive(lease, now);
  if (!active.allowed) {
    return active;
  }
  const currentExpiry = Date.parse(lease.expiresAt);
  const cap = Date.parse(lease.maxExpiresAt);
  const extended = Math.min(currentExpiry + config.renewalDurationMs, cap);
  if (extended <= currentExpiry) {
    return denied(
      "max-total-exceeded",
      "lease has reached its maximum total duration and cannot be renewed",
    );
  }
  return { allowed: true, expiresAt: toTimestamp(new Date(extended)) };
}

/**
 * When the UI should prompt for renewal (design section 12.3: five minutes
 * before expiration). Purely advisory; expiry itself never depends on it.
 */
export function renewalPromptAt(
  lease: LeaseSnapshot,
  config: LeaseConfig = DEFAULT_LEASE_CONFIG,
): string {
  return toTimestamp(new Date(Date.parse(lease.expiresAt) - config.renewalPromptBeforeMs));
}

/**
 * Whether a sweep (`sweepExpiredLeases`) or lazy check should expire this
 * lease now: it is past `expires_at` and has not already been ended some
 * other way (released/revoked leases were already dealt with).
 */
export function shouldExpireLease(lease: LeaseSnapshot, now: Date): boolean {
  return (
    isLeaseExpired(lease, now) &&
    (lease.releasedAt === undefined || lease.releasedAt === null) &&
    (lease.revokedAt === undefined || lease.revokedAt === null)
  );
}
