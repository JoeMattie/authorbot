import { describe, expect, it } from "vitest";
import {
  AGENT_TOKEN_REGEX,
  LEASE_TOKEN_PREFIX,
  isAgentTokenFormat,
  isLeaseTokenFormat,
  leaseTokenSchema,
  parseLeaseToken,
} from "../src/index.js";

// Synthetic fixtures only - never real credentials.
const SECRET_43 = "Zx9-_".repeat(8) + "Zx9"; // 43 base64url chars
const FAKE_LEASE_TOKEN = `${LEASE_TOKEN_PREFIX}${SECRET_43}`;

describe("lease token format", () => {
  it("accepts 'authorbot_lease_' + 43 base64url chars", () => {
    expect(SECRET_43).toHaveLength(43);
    expect(isLeaseTokenFormat(FAKE_LEASE_TOKEN)).toBe(true);
    expect(leaseTokenSchema.safeParse(FAKE_LEASE_TOKEN).success).toBe(true);
    expect(parseLeaseToken(FAKE_LEASE_TOKEN)).toEqual({ ok: true, secret: SECRET_43 });
  });

  it("rejects a wrong or missing prefix", () => {
    expect(parseLeaseToken(`authorbot_${SECRET_43}`)).toEqual({ ok: false, reason: "bad-prefix" });
    expect(parseLeaseToken(SECRET_43)).toEqual({ ok: false, reason: "bad-prefix" });
    expect(parseLeaseToken(`Authorbot_lease_${SECRET_43}`)).toEqual({
      ok: false,
      reason: "bad-prefix",
    });
    expect(isLeaseTokenFormat(`lease_${SECRET_43}`)).toBe(false);
  });

  it("rejects secrets of 42 or 44 characters", () => {
    expect(parseLeaseToken(`${LEASE_TOKEN_PREFIX}${SECRET_43.slice(0, 42)}`)).toEqual({
      ok: false,
      reason: "bad-length",
    });
    expect(parseLeaseToken(`${LEASE_TOKEN_PREFIX}${SECRET_43}X`)).toEqual({
      ok: false,
      reason: "bad-length",
    });
    expect(parseLeaseToken(LEASE_TOKEN_PREFIX)).toEqual({ ok: false, reason: "bad-length" });
  });

  it("rejects non-base64url characters (+, /, =, space)", () => {
    for (const bad of ["+", "/", "=", " ", "!"]) {
      const candidate = `${LEASE_TOKEN_PREFIX}${SECRET_43.slice(0, 42)}${bad}`;
      expect(parseLeaseToken(candidate)).toEqual({ ok: false, reason: "bad-charset" });
      expect(isLeaseTokenFormat(candidate)).toBe(false);
    }
  });

  it("parse failures never echo any part of the value", () => {
    const failure = parseLeaseToken(`nope_${SECRET_43}`);
    expect(JSON.stringify(failure)).not.toContain(SECRET_43.slice(0, 10));
  });

  it("lease tokens and agent tokens are disjoint spaces", () => {
    // A lease token starts with 'authorbot_' but its tail is 49 chars, not 43.
    expect(AGENT_TOKEN_REGEX.test(FAKE_LEASE_TOKEN)).toBe(false);
    expect(isAgentTokenFormat(FAKE_LEASE_TOKEN)).toBe(false);
    // And an agent token fails the lease prefix.
    expect(isLeaseTokenFormat(`authorbot_${SECRET_43}`)).toBe(false);
  });
});
