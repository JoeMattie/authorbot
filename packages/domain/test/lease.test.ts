import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEASE_CONFIG,
  LEASE_DURATION_MS,
  LEASE_MAX_TOTAL_DURATION_MS,
  LEASE_RENEWAL_DURATION_MS,
  LEASE_RENEWAL_PROMPT_BEFORE_MS,
  WORK_ITEM_STATUSES,
  checkLeaseActive,
  checkLeaseRenewable,
  checkWorkItemClaimable,
  isLeaseExpired,
  leaseConfigSchema,
  parseIsoDuration,
  renewalPromptAt,
  resolveLeaseExpiry,
  shouldExpireLease,
  type LeaseSnapshot,
} from "../src/index.js";

const T0 = new Date("2026-07-19T18:00:00Z");
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A lease issued at T0 under the default config. */
const FRESH_LEASE: LeaseSnapshot = {
  expiresAt: "2026-07-19T18:30:00Z",
  maxExpiresAt: "2026-07-19T22:00:00Z",
};

describe("lease config (design section 25 defaults)", () => {
  it("constants match the design: PT30M, PT30M, PT4H, PT5M", () => {
    expect(LEASE_DURATION_MS).toBe(30 * MINUTE);
    expect(LEASE_RENEWAL_DURATION_MS).toBe(30 * MINUTE);
    expect(LEASE_MAX_TOTAL_DURATION_MS).toBe(4 * HOUR);
    expect(LEASE_RENEWAL_PROMPT_BEFORE_MS).toBe(5 * MINUTE);
  });

  it("an empty override parses to the defaults", () => {
    expect(leaseConfigSchema.parse({})).toEqual(DEFAULT_LEASE_CONFIG);
    expect(DEFAULT_LEASE_CONFIG).toEqual({
      durationMs: 30 * MINUTE,
      renewalDurationMs: 30 * MINUTE,
      maxTotalDurationMs: 4 * HOUR,
      renewalPromptBeforeMs: 5 * MINUTE,
    });
  });

  it("rejects non-positive durations", () => {
    expect(leaseConfigSchema.safeParse({ durationMs: 0 }).success).toBe(false);
    expect(leaseConfigSchema.safeParse({ renewalDurationMs: -1 }).success).toBe(false);
  });

  it("rejects a renewal prompt at or beyond the duration", () => {
    expect(
      leaseConfigSchema.safeParse({ durationMs: 5 * MINUTE, renewalPromptBeforeMs: 5 * MINUTE })
        .success,
    ).toBe(false);
  });

  it("rejects an initial duration beyond the max total", () => {
    expect(
      leaseConfigSchema.safeParse({ durationMs: 5 * HOUR }).success,
    ).toBe(false);
  });

  it("rejects unknown keys (strict, so env typos fail at boot)", () => {
    expect(leaseConfigSchema.safeParse({ durationsMs: MINUTE }).success).toBe(false);
  });
});

describe("parseIsoDuration (LEASE_* env override validation)", () => {
  it("parses the contract's durations", () => {
    expect(parseIsoDuration("PT30M")).toEqual({ ok: true, ms: 30 * MINUTE });
    expect(parseIsoDuration("PT4H")).toEqual({ ok: true, ms: 4 * HOUR });
    expect(parseIsoDuration("PT5M")).toEqual({ ok: true, ms: 5 * MINUTE });
  });

  it("parses combined designators", () => {
    expect(parseIsoDuration("PT1H30M")).toEqual({ ok: true, ms: 90 * MINUTE });
    expect(parseIsoDuration("P1DT2H")).toEqual({ ok: true, ms: 26 * HOUR });
    expect(parseIsoDuration("PT90S")).toEqual({ ok: true, ms: 90_000 });
    expect(parseIsoDuration("P2D")).toEqual({ ok: true, ms: 48 * HOUR });
  });

  it("rejects malformed or empty durations", () => {
    for (const bad of ["", "P", "PT", "30M", "PT30", "PT-5M", "PT5X", "pt30m", "P1M", "P1Y", "P1W", "PT1.5H"]) {
      expect(parseIsoDuration(bad)).toEqual({ ok: false, reason: "bad-format" });
    }
  });

  it("rejects zero durations", () => {
    expect(parseIsoDuration("PT0M")).toEqual({ ok: false, reason: "zero-duration" });
    expect(parseIsoDuration("P0D")).toEqual({ ok: false, reason: "zero-duration" });
  });
});

describe("resolveLeaseExpiry", () => {
  it("issues expiry and max-expiry from the claim instant", () => {
    expect(resolveLeaseExpiry(T0)).toEqual({
      expiresAt: "2026-07-19T18:30:00Z",
      maxExpiresAt: "2026-07-19T22:00:00Z",
    });
  });

  it("honors an overridden config", () => {
    const config = leaseConfigSchema.parse({
      durationMs: MINUTE,
      maxTotalDurationMs: 2 * MINUTE,
      renewalPromptBeforeMs: MINUTE / 2,
    });
    expect(resolveLeaseExpiry(T0, config)).toEqual({
      expiresAt: "2026-07-19T18:01:00Z",
      maxExpiresAt: "2026-07-19T18:02:00Z",
    });
  });
});

describe("isLeaseExpired", () => {
  it("is live strictly before expires_at", () => {
    expect(isLeaseExpired(FRESH_LEASE, at(30 * MINUTE - 1))).toBe(false);
  });

  it("is expired at exactly expires_at (inclusive, like tokens)", () => {
    expect(isLeaseExpired(FRESH_LEASE, at(30 * MINUTE))).toBe(true);
    expect(isLeaseExpired(FRESH_LEASE, at(30 * MINUTE + 1))).toBe(true);
  });
});

describe("checkLeaseActive (contract section 4 order: expired, released, revoked)", () => {
  it("allows a live, unreleased, unrevoked lease", () => {
    expect(checkLeaseActive(FRESH_LEASE, at(0))).toEqual({ allowed: true });
    expect(checkLeaseActive({ ...FRESH_LEASE, releasedAt: null, revokedAt: null }, at(0))).toEqual({
      allowed: true,
    });
  });

  it("denies expired / released / revoked with distinct reasons", () => {
    expect(checkLeaseActive(FRESH_LEASE, at(30 * MINUTE))).toMatchObject({
      allowed: false,
      reason: "expired",
    });
    expect(
      checkLeaseActive({ ...FRESH_LEASE, releasedAt: "2026-07-19T18:10:00Z" }, at(11 * MINUTE)),
    ).toMatchObject({ allowed: false, reason: "released" });
    expect(
      checkLeaseActive({ ...FRESH_LEASE, revokedAt: "2026-07-19T18:10:00Z" }, at(11 * MINUTE)),
    ).toMatchObject({ allowed: false, reason: "revoked" });
  });

  it("expiry is reported before release/revocation (contract order)", () => {
    const ended: LeaseSnapshot = {
      ...FRESH_LEASE,
      releasedAt: "2026-07-19T18:10:00Z",
      revokedAt: "2026-07-19T18:10:00Z",
    };
    expect(checkLeaseActive(ended, at(31 * MINUTE))).toMatchObject({ reason: "expired" });
    expect(checkLeaseActive(ended, at(11 * MINUTE))).toMatchObject({ reason: "released" });
  });
});

describe("checkWorkItemClaimable (design section 12.2 step 1)", () => {
  it("a ready item is claimable with no prior lease to expire", () => {
    expect(checkWorkItemClaimable("ready", null, at(0))).toEqual({
      allowed: true,
      priorLeaseExpired: false,
    });
  });

  it("a leased item with a live lease denies lease-held", () => {
    expect(checkWorkItemClaimable("leased", FRESH_LEASE, at(0))).toMatchObject({
      allowed: false,
      reason: "lease-held",
    });
  });

  it("a leased item whose lease expired is claimable and flags the expiry", () => {
    expect(checkWorkItemClaimable("leased", FRESH_LEASE, at(30 * MINUTE))).toEqual({
      allowed: true,
      priorLeaseExpired: true,
    });
  });

  it("a leased item with released/revoked leftovers is claimable (lazy cleanup)", () => {
    expect(
      checkWorkItemClaimable("leased", { ...FRESH_LEASE, releasedAt: "2026-07-19T18:01:00Z" }, at(2 * MINUTE)),
    ).toEqual({ allowed: true, priorLeaseExpired: true });
  });

  it("a leased item with no lease row on record is claimable (self-heals a stranded slot)", () => {
    // The partial unique index admits exactly one active lease, so "no active
    // lease" is unambiguous: the slot is free. An interrupted expiry or a bare
    // administrative revocation leaves exactly this state, and denying it as
    // `lease-held` made the item permanently unclaimable, unreleasable, and
    // unsweepable - repairable only by direct database surgery.
    expect(checkWorkItemClaimable("leased", null, at(0))).toEqual({
      allowed: true,
      priorLeaseExpired: true,
    });
  });

  // Exhaustive over every status: only ready and leased can ever claim.
  for (const status of WORK_ITEM_STATUSES) {
    const claimStatus = status === "ready" || status === "leased";
    it(`status ${status} is ${claimStatus ? "claim-relevant" : "not-claimable"}`, () => {
      const result = checkWorkItemClaimable(status, null, at(0));
      if (status === "ready") {
        expect(result.allowed).toBe(true);
      } else if (status === "leased") {
        // With no active lease the slot is free; `lease-held` is reserved for
        // a `leased` item whose lease is genuinely still live (covered above).
        expect(result).toEqual({ allowed: true, priorLeaseExpired: true });
      } else {
        expect(result).toMatchObject({ allowed: false, reason: "not-claimable" });
        if (!result.allowed) {
          expect(result.message).toContain(status);
        }
      }
    });
  }
});

describe("checkLeaseRenewable (design section 12.3, exit criterion 2 matrix)", () => {
  it("extends a live lease by the renewal duration from its current expiry", () => {
    expect(checkLeaseRenewable(FRESH_LEASE, at(25 * MINUTE))).toEqual({
      allowed: true,
      expiresAt: "2026-07-19T19:00:00Z",
    });
  });

  it("clamps the extension at max_expires_at", () => {
    const nearCap: LeaseSnapshot = {
      expiresAt: "2026-07-19T21:45:00Z",
      maxExpiresAt: "2026-07-19T22:00:00Z",
    };
    expect(checkLeaseRenewable(nearCap, at(3 * HOUR + 40 * MINUTE))).toEqual({
      allowed: true,
      expiresAt: "2026-07-19T22:00:00Z",
    });
  });

  it("rejects renewal once expiry sits at the max-total cap", () => {
    const capped: LeaseSnapshot = {
      expiresAt: "2026-07-19T22:00:00Z",
      maxExpiresAt: "2026-07-19T22:00:00Z",
    };
    expect(checkLeaseRenewable(capped, at(3 * HOUR + 59 * MINUTE))).toMatchObject({
      allowed: false,
      reason: "max-total-exceeded",
    });
  });

  it("rejects renewing an expired lease (contract: 409)", () => {
    expect(checkLeaseRenewable(FRESH_LEASE, at(30 * MINUTE))).toMatchObject({
      allowed: false,
      reason: "expired",
    });
  });

  it("rejects renewing a released or revoked lease", () => {
    expect(
      checkLeaseRenewable({ ...FRESH_LEASE, releasedAt: "2026-07-19T18:05:00Z" }, at(6 * MINUTE)),
    ).toMatchObject({ allowed: false, reason: "released" });
    expect(
      checkLeaseRenewable({ ...FRESH_LEASE, revokedAt: "2026-07-19T18:05:00Z" }, at(6 * MINUTE)),
    ).toMatchObject({ allowed: false, reason: "revoked" });
  });
});

describe("renewalPromptAt", () => {
  it("is renewal_prompt_before ahead of expiry", () => {
    expect(renewalPromptAt(FRESH_LEASE)).toBe("2026-07-19T18:25:00Z");
  });
});

describe("shouldExpireLease (sweep + lazy expiry)", () => {
  it("true only for past-expiry leases not otherwise ended", () => {
    expect(shouldExpireLease(FRESH_LEASE, at(30 * MINUTE))).toBe(true);
    expect(shouldExpireLease(FRESH_LEASE, at(29 * MINUTE))).toBe(false);
    expect(
      shouldExpireLease({ ...FRESH_LEASE, releasedAt: "2026-07-19T18:10:00Z" }, at(31 * MINUTE)),
    ).toBe(false);
    expect(
      shouldExpireLease({ ...FRESH_LEASE, revokedAt: "2026-07-19T18:10:00Z" }, at(31 * MINUTE)),
    ).toBe(false);
  });
});
