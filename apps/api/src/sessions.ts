/**
 * Session cookie format (Phase 2 contract §3): the cookie carries
 * `<sessionId>.<signature>` where sessionId is an opaque 256-bit base64url
 * value and signature = HMAC-SHA-256(SESSION_SECRET, sessionId) hex. The
 * server stores only SHA-256(sessionId); the plaintext exists in the cookie
 * alone. Always HttpOnly, Secure, SameSite=Lax (ADR-0019 §2).
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

/**
 * Session cookie attributes (ADR-0019 §2): ALWAYS
 * `HttpOnly; Secure; SameSite=Lax`. The `SameSite=None` path existed only for
 * the cross-origin deployment shape, which is no longer supported — the weaker
 * posture is now unreachable by configuration.
 *
 * `Path=/` rather than the base path: a book under `/my-book` still shares its
 * origin with everything else on the host, so scoping the cookie by path would
 * buy no isolation while breaking sign-in for anything served above it.
 */
export function sessionCookieHeader(value: string): string {
  return (
    `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; ` +
    `HttpOnly; Secure; SameSite=Lax`
  );
}

/** Short-lived signed OAuth state cookie (github mode). */
export const OAUTH_STATE_COOKIE = "authorbot_oauth_state";

/**
 * OAuth state cookie payload (Phase 2b contract §3): the CSRF state plus the
 * validated `return_to` propagated from the start route. Packed as
 * `base64url(JSON).hmacHex` — signed with the session secret, so the callback
 * trusts only what the start route wrote.
 */
export interface OauthStatePayload {
  state: string;
  returnTo: string | null;
}

export async function packOauthState(
  sessionSecret: string,
  payload: OauthStatePayload,
): Promise<string> {
  const encoded = utf8ToBase64Url(JSON.stringify(payload));
  const signature = await hmacSha256Hex(sessionSecret, encoded);
  return `${encoded}.${signature}`;
}

/** Verify + decode a state cookie value; null on any mismatch. Never throws. */
export async function unpackOauthState(
  sessionSecret: string,
  value: string,
): Promise<OauthStatePayload | null> {
  const dot = value.indexOf(".");
  if (dot === -1) {
    return null;
  }
  const encoded = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  const expected = await hmacSha256Hex(sessionSecret, encoded);
  if (!timingSafeEqual(signature, expected)) {
    return null;
  }
  const json = base64UrlToUtf8(encoded);
  if (json === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(json) as { state?: unknown; returnTo?: unknown };
    if (typeof parsed.state !== "string") {
      return null;
    }
    return {
      state: parsed.state,
      returnTo: typeof parsed.returnTo === "string" ? parsed.returnTo : null,
    };
  } catch {
    return null;
  }
}

function utf8ToBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  // btoa exists in Workers and Node >= 16.
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlToUtf8(value: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    return null;
  }
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function oauthStateCookieHeader(value: string): string {
  return `${OAUTH_STATE_COOKIE}=${value}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
}

export function clearOauthStateCookieHeader(): string {
  return `${OAUTH_STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
