/**
 * Session cookie format (Phase 2 contract §3): the cookie carries
 * `<sessionId>.<signature>` where sessionId is an opaque 256-bit base64url
 * value and signature = HMAC-SHA-256(SESSION_SECRET, sessionId) hex. The
 * server stores only SHA-256(sessionId); the plaintext exists in the cookie
 * alone. HttpOnly, Secure, SameSite=Lax.
 */
import { isSessionIdFormat, SESSION_TTL_DAYS } from "@authorbot/domain";
import { hmacSha256Hex, timingSafeEqual } from "./crypto.js";

export const SESSION_COOKIE = "authorbot_session";

export const SESSION_MAX_AGE_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60;

export async function signSessionCookieValue(
  sessionSecret: string,
  sessionId: string,
): Promise<string> {
  const signature = await hmacSha256Hex(sessionSecret, sessionId);
  return `${sessionId}.${signature}`;
}

/** Verify a cookie value; returns the sessionId or null. Never throws. */
export async function verifySessionCookieValue(
  sessionSecret: string,
  value: string | undefined,
): Promise<string | null> {
  if (value === undefined) {
    return null;
  }
  const dot = value.indexOf(".");
  if (dot === -1) {
    return null;
  }
  const sessionId = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!isSessionIdFormat(sessionId)) {
    return null;
  }
  const expected = await hmacSha256Hex(sessionSecret, sessionId);
  return timingSafeEqual(signature, expected) ? sessionId : null;
}

export function sessionCookieHeader(value: string): string {
  return (
    `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; ` +
    "HttpOnly; Secure; SameSite=Lax"
  );
}

/** Short-lived signed OAuth state cookie (github mode). */
export const OAUTH_STATE_COOKIE = "authorbot_oauth_state";

export function oauthStateCookieHeader(value: string): string {
  return `${OAUTH_STATE_COOKIE}=${value}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
}

export function clearOauthStateCookieHeader(): string {
  return `${OAUTH_STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
