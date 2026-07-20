import { z } from "zod";
import { ALLOWED, denied, type Decision } from "./decision.js";

/**
 * Token and session VALUE rules only (Phase 2 contract section 3). This
 * module is deliberately crypto-free: generating randomness and hashing
 * (SHA-256, HMAC) are the API layer's job. Nothing here ever logs or embeds
 * a full credential in an error message.
 */

/** Agent token: `authorbot_` + 43 base64url chars (256-bit random). */
export const AGENT_TOKEN_PREFIX = "authorbot_";
export const AGENT_TOKEN_SECRET_LENGTH = 43;
const BASE64URL_CHAR = /^[A-Za-z0-9_-]+$/;
export const AGENT_TOKEN_REGEX = /^authorbot_[A-Za-z0-9_-]{43}$/;

export const agentTokenSchema = z
  .string()
  .regex(
    AGENT_TOKEN_REGEX,
    "must be 'authorbot_' followed by 43 base64url characters",
  );

export function isAgentTokenFormat(value: string): boolean {
  return AGENT_TOKEN_REGEX.test(value);
}

export type AgentTokenParseFailure =
  | "bad-prefix"
  | "bad-length"
  | "bad-charset";

export type AgentTokenParseResult =
  | { readonly ok: true; readonly secret: string }
  | { readonly ok: false; readonly reason: AgentTokenParseFailure };

/**
 * Shape-check a presented credential and split off the secret part (which the
 * API layer hashes for lookup). Failure results carry a reason only — never
 * any fragment of the presented value.
 */
export function parseAgentToken(value: string): AgentTokenParseResult {
  if (!value.startsWith(AGENT_TOKEN_PREFIX)) {
    return { ok: false, reason: "bad-prefix" };
  }
  const secret = value.slice(AGENT_TOKEN_PREFIX.length);
  if (secret.length !== AGENT_TOKEN_SECRET_LENGTH) {
    return { ok: false, reason: "bad-length" };
  }
  if (!BASE64URL_CHAR.test(secret)) {
    return { ok: false, reason: "bad-charset" };
  }
  return { ok: true, secret };
}

/**
 * Human session id: opaque 256-bit value (contract section 3). The contract
 * does not pin an encoding; this package pins base64url (43 chars), matching
 * the agent-token secret encoding, and the API must generate accordingly.
 * Cookie signing (HMAC) is out of scope here.
 */
export const SESSION_ID_LENGTH = 43;
export const SESSION_ID_REGEX = /^[A-Za-z0-9_-]{43}$/;
export const sessionIdSchema = z
  .string()
  .regex(SESSION_ID_REGEX, "must be 43 base64url characters (256-bit)");

export function isSessionIdFormat(value: string): boolean {
  return SESSION_ID_REGEX.test(value);
}

/** Agent-token TTL bounds (contract section 3: <= 90d, default 30d). */
export const MAX_TOKEN_TTL_DAYS = 90;
export const DEFAULT_TOKEN_TTL_DAYS = 30;
/** Human session TTL (contract section 3: 7d). */
export const SESSION_TTL_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Format a Date as the contract's RFC 3339 UTC second-precision timestamp. */
export function toTimestamp(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("invalid Date");
  }
  return `${date.toISOString().slice(0, 19)}Z`;
}

export type TokenExpiryResult =
  | { readonly ok: true; readonly expiresAt: string }
  | { readonly ok: false; readonly reason: "ttl-out-of-range" };

/**
 * Resolve an agent token's `expires_at` from mint time and requested TTL.
 * Missing TTL means the 30-day default; anything outside 1..90 whole days is
 * rejected rather than clamped.
 */
export function resolveTokenExpiry(
  now: Date,
  requestedDays?: number,
): TokenExpiryResult {
  const days = requestedDays ?? DEFAULT_TOKEN_TTL_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_TTL_DAYS) {
    return { ok: false, reason: "ttl-out-of-range" };
  }
  return { ok: true, expiresAt: toTimestamp(new Date(now.getTime() + days * MS_PER_DAY)) };
}

/** Resolve a human session's `expires_at` (7 days from issue). */
export function resolveSessionExpiry(now: Date): string {
  return toTimestamp(new Date(now.getTime() + SESSION_TTL_DAYS * MS_PER_DAY));
}

export type TokenInactiveReason = "revoked" | "expired";

/**
 * Whether a stored token row is still usable at `now`. Revocation wins over
 * expiry; expiry is inclusive (a token is expired at exactly `expires_at`).
 */
export function checkTokenActive(
  token: { expiresAt: string; revokedAt?: string | null },
  now: Date,
): Decision<TokenInactiveReason> {
  if (token.revokedAt !== undefined && token.revokedAt !== null) {
    return denied("revoked", "token has been revoked");
  }
  if (now.getTime() >= Date.parse(token.expiresAt)) {
    return denied("expired", "token has expired");
  }
  return ALLOWED;
}

/** `last_used_at` update throttle (contract section 3: at most once per minute). */
export const LAST_USED_UPDATE_INTERVAL_MS = 60_000;

export function shouldUpdateLastUsed(
  lastUsedAt: string | null | undefined,
  now: Date,
): boolean {
  if (lastUsedAt === undefined || lastUsedAt === null) {
    return true;
  }
  return now.getTime() - Date.parse(lastUsedAt) >= LAST_USED_UPDATE_INTERVAL_MS;
}
