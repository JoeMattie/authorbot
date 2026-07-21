import { describe, expect, it } from "vitest";
import {
  AGENT_TOKEN_PREFIX,
  DEFAULT_TOKEN_TTL_DAYS,
  MAX_TOKEN_TTL_DAYS,
  SESSION_TTL_DAYS,
  agentTokenSchema,
  checkTokenActive,
  isAgentTokenFormat,
  isSessionIdFormat,
  parseAgentToken,
  resolveSessionExpiry,
  resolveTokenExpiry,
  sessionIdSchema,
  shouldUpdateLastUsed,
  toTimestamp,
} from "../src/index.js";

// Synthetic fixtures only - never real credentials.
const SECRET_43 = "Ab1-_".repeat(8) + "Ab1"; // 43 base64url chars
const FAKE_TOKEN = `${AGENT_TOKEN_PREFIX}${SECRET_43}`;

describe("agent token format", () => {
  it("accepts 'authorbot_' + 43 base64url chars", () => {
    expect(SECRET_43).toHaveLength(43);
    expect(isAgentTokenFormat(FAKE_TOKEN)).toBe(true);
    expect(agentTokenSchema.safeParse(FAKE_TOKEN).success).toBe(true);
    const parsed = parseAgentToken(FAKE_TOKEN);
    expect(parsed).toEqual({ ok: true, secret: SECRET_43 });
  });

  it("rejects a wrong or missing prefix", () => {
    expect(parseAgentToken(`authorbat_${SECRET_43}`)).toEqual({ ok: false, reason: "bad-prefix" });
    expect(parseAgentToken(SECRET_43)).toEqual({ ok: false, reason: "bad-prefix" });
    expect(parseAgentToken(`Authorbot_${SECRET_43}`)).toEqual({ ok: false, reason: "bad-prefix" });
    expect(isAgentTokenFormat(`bearer_${SECRET_43}`)).toBe(false);
  });

  it("rejects secrets of 42 or 44 characters", () => {
    expect(parseAgentToken(`${AGENT_TOKEN_PREFIX}${SECRET_43.slice(0, 42)}`)).toEqual({
      ok: false,
      reason: "bad-length",
    });
    expect(parseAgentToken(`${AGENT_TOKEN_PREFIX}${SECRET_43}X`)).toEqual({
      ok: false,
      reason: "bad-length",
    });
    expect(parseAgentToken(AGENT_TOKEN_PREFIX)).toEqual({ ok: false, reason: "bad-length" });
  });

  it("rejects non-base64url characters (+, /, =, space)", () => {
    for (const bad of ["+", "/", "=", " ", "!"]) {
      const candidate = `${AGENT_TOKEN_PREFIX}${SECRET_43.slice(0, 42)}${bad}`;
      expect(parseAgentToken(candidate)).toEqual({ ok: false, reason: "bad-charset" });
      expect(isAgentTokenFormat(candidate)).toBe(false);
    }
  });

  it("parse failures never echo any part of the value", () => {
    const failure = parseAgentToken(`nope_${SECRET_43}`);
    expect(JSON.stringify(failure)).not.toContain(SECRET_43.slice(0, 10));
  });
});

describe("session id format", () => {
  it("accepts 43 base64url chars and rejects other lengths/charsets", () => {
    expect(isSessionIdFormat(SECRET_43)).toBe(true);
    expect(sessionIdSchema.safeParse(SECRET_43).success).toBe(true);
    expect(isSessionIdFormat(SECRET_43.slice(0, 42))).toBe(false);
    expect(isSessionIdFormat(`${SECRET_43}A`)).toBe(false);
    expect(isSessionIdFormat(SECRET_43.slice(0, 42) + "+")).toBe(false);
    expect(isSessionIdFormat("")).toBe(false);
  });
});

describe("toTimestamp", () => {
  it("formats RFC 3339 UTC at second precision", () => {
    expect(toTimestamp(new Date("2026-07-19T18:00:00.987Z"))).toBe("2026-07-19T18:00:00Z");
  });

  it("throws on an invalid Date", () => {
    expect(() => toTimestamp(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe("resolveTokenExpiry", () => {
  const now = new Date("2026-07-19T18:00:00Z");

  it("defaults to 30 days", () => {
    expect(DEFAULT_TOKEN_TTL_DAYS).toBe(30);
    expect(resolveTokenExpiry(now)).toEqual({ ok: true, expiresAt: "2026-08-18T18:00:00Z" });
  });

  it("honors an explicit TTL up to 90 days", () => {
    expect(resolveTokenExpiry(now, 1)).toEqual({ ok: true, expiresAt: "2026-07-20T18:00:00Z" });
    expect(resolveTokenExpiry(now, MAX_TOKEN_TTL_DAYS)).toEqual({
      ok: true,
      expiresAt: "2026-10-17T18:00:00Z",
    });
  });

  it("rejects out-of-range or fractional TTLs", () => {
    for (const days of [0, -1, 91, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveTokenExpiry(now, days)).toEqual({ ok: false, reason: "ttl-out-of-range" });
    }
  });
});

describe("resolveSessionExpiry", () => {
  it("is 7 days from issue", () => {
    expect(SESSION_TTL_DAYS).toBe(7);
    expect(resolveSessionExpiry(new Date("2026-07-19T18:00:00Z"))).toBe("2026-07-26T18:00:00Z");
  });
});

describe("checkTokenActive", () => {
  const expiresAt = "2026-08-18T18:00:00Z";

  it("allows an unexpired, unrevoked token", () => {
    expect(
      checkTokenActive({ expiresAt }, new Date("2026-08-01T00:00:00Z")).allowed,
    ).toBe(true);
    expect(
      checkTokenActive({ expiresAt, revokedAt: null }, new Date("2026-08-01T00:00:00Z")).allowed,
    ).toBe(true);
  });

  it("denies at and after the expiry instant", () => {
    expect(checkTokenActive({ expiresAt }, new Date(expiresAt))).toMatchObject({
      allowed: false,
      reason: "expired",
    });
    expect(checkTokenActive({ expiresAt }, new Date("2027-01-01T00:00:00Z"))).toMatchObject({
      allowed: false,
      reason: "expired",
    });
  });

  it("denies a revoked token, and revocation wins over expiry", () => {
    const revoked = { expiresAt, revokedAt: "2026-07-20T00:00:00Z" };
    expect(checkTokenActive(revoked, new Date("2026-07-21T00:00:00Z"))).toMatchObject({
      allowed: false,
      reason: "revoked",
    });
    expect(checkTokenActive(revoked, new Date("2027-01-01T00:00:00Z"))).toMatchObject({
      allowed: false,
      reason: "revoked",
    });
  });
});

describe("shouldUpdateLastUsed", () => {
  const now = new Date("2026-07-19T18:00:00Z");

  it("updates when never used", () => {
    expect(shouldUpdateLastUsed(null, now)).toBe(true);
    expect(shouldUpdateLastUsed(undefined, now)).toBe(true);
  });

  it("throttles to at most once per minute", () => {
    expect(shouldUpdateLastUsed("2026-07-19T17:59:30Z", now)).toBe(false);
    expect(shouldUpdateLastUsed("2026-07-19T17:59:00Z", now)).toBe(true);
    expect(shouldUpdateLastUsed("2026-07-19T17:58:59Z", now)).toBe(true);
  });
});
