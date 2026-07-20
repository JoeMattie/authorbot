import { z } from "zod";

/**
 * Lease-token FORMAT helpers only (Phase 4 contract section 2): parse and
 * shape-check, no crypto. Generating the 256-bit random secret, hashing it
 * (SHA-256), storing only the hash, and the constant-time compare are the
 * API layer's job — exactly the split used for agent tokens in `token.ts`.
 * Failure results carry a reason only and never echo any part of the value;
 * lease tokens are never logged.
 *
 * Format (resolved ambiguity — the contracts pin "opaque 256-bit token" but
 * no encoding): `authorbot_lease_` + 43 base64url chars, matching the agent
 * token secret encoding. The distinct prefix makes a leaked lease token
 * identifiable and unconfusable with an agent credential (an agent token is
 * `authorbot_` + exactly 43 chars, so the two spaces are disjoint).
 */

export const LEASE_TOKEN_PREFIX = "authorbot_lease_";
export const LEASE_TOKEN_SECRET_LENGTH = 43;
const BASE64URL_CHAR = /^[A-Za-z0-9_-]+$/;
export const LEASE_TOKEN_REGEX = /^authorbot_lease_[A-Za-z0-9_-]{43}$/;

export const leaseTokenSchema = z
  .string()
  .regex(
    LEASE_TOKEN_REGEX,
    "must be 'authorbot_lease_' followed by 43 base64url characters",
  );

export function isLeaseTokenFormat(value: string): boolean {
  return LEASE_TOKEN_REGEX.test(value);
}

export type LeaseTokenParseFailure = "bad-prefix" | "bad-length" | "bad-charset";

export type LeaseTokenParseResult =
  | { readonly ok: true; readonly secret: string }
  | { readonly ok: false; readonly reason: LeaseTokenParseFailure };

/**
 * Shape-check a presented lease token and split off the secret part (which
 * the API layer hashes for the constant-time comparison against the stored
 * hash). Failures never contain any fragment of the presented value.
 */
export function parseLeaseToken(value: string): LeaseTokenParseResult {
  if (!value.startsWith(LEASE_TOKEN_PREFIX)) {
    return { ok: false, reason: "bad-prefix" };
  }
  const secret = value.slice(LEASE_TOKEN_PREFIX.length);
  if (secret.length !== LEASE_TOKEN_SECRET_LENGTH) {
    return { ok: false, reason: "bad-length" };
  }
  if (!BASE64URL_CHAR.test(secret)) {
    return { ok: false, reason: "bad-charset" };
  }
  return { ok: true, secret };
}
