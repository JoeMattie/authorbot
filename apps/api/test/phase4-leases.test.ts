/**
 * Phase 4 leases (contract §2, §3, §8 exit criteria 1–2): the simultaneous-
 * claim race, the task-bundle shape, the full stale-lease matrix (expired /
 * released / revoked / wrong-token / max-total-exceeded renewals), and both
 * expiry paths (lazy on command, eager sweep) returning items to `ready`
 * with events.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEASE_CONFIG,
  LEASE_TOKEN_REGEX,
} from "@authorbot/domain";
import { leaseConfigFromEnv, sweepExpiredLeases } from "../src/index.js";
import { uuidv7 } from "../src/ids.js";
import { devLogin, jsonRequest, mintToken, BLOCK_ID_1, CHAPTER_ID } from "./helpers.js";
import {
  claimWorkItem,
  createReadyWorkItem,
  makePhase4Harness,
  type Phase4Harness,
} from "./phase4-helpers.js";

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

async function eventTypes(harness: Phase4Harness): Promise<string[]> {
  const events = await harness.repos.events.listAfter(harness.projectId, 0, 200);
  return events.map((e) => e.type);
}

function leaseOf(bundle: Record<string, unknown>): {
  id: string;
  token: string;
  expiresAt: string;
  maxExpiresAt: string;
  renewalPromptAt: string;
} {
  return bundle["lease"] as {
    id: string;
    token: string;
    expiresAt: string;
    maxExpiresAt: string;
    renewalPromptAt: string;
  };
}

async function renew(
  harness: Phase4Harness,
  cookie: string,
  workItemId: string,
  leaseId: string,
  leaseToken: string,
): Promise<Response> {
  return harness.app.request(
    `/v1/projects/${harness.projectId}/work-items/${workItemId}/lease/renew`,
    jsonRequest("POST", { leaseId, leaseToken }, { Cookie: cookie }),
  );
}

describe("claim (contract §2/§3)", () => {
  it("N parallel claims produce exactly one 201 + one active lease, repeatable x5 (exit criterion 1)", async () => {
    const harness = await makePhase4Harness();
    try {
      const cookies = await Promise.all(
        Array.from({ length: 8 }, (_, i) => devLogin(harness, `editor-${i}`, "editor")),
      );
      for (let round = 0; round < 5; round += 1) {
        const { workItemId } = await createReadyWorkItem(harness);
        const results = await Promise.all(
          cookies.map((cookie) => claimWorkItem(harness, { cookie }, workItemId)),
        );
        const winners = results.filter((r) => r.status === 201);
        const losers = results.filter((r) => r.status === 409);
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(7);
        for (const loser of losers) {
          expect(loser.body["code"]).toBe("lease-held");
          // Holder-safe info only: display name, never token material.
          expect(JSON.stringify(loser.body)).not.toContain("authorbot_lease_");
          expect(typeof loser.body["holder"]).toBe("string");
        }
        const active = await harness.repos.leases.getActiveByWorkItem(workItemId);
        expect(active).not.toBeNull();
        const item = await harness.repos.workItems.getById(workItemId);
        expect(item?.status).toBe("leased");
      }
    } finally {
      harness.close();
    }
  });

  it("returns the §15.3 task bundle exactly (shape snapshot)", async () => {
    const harness = await makePhase4Harness();
    try {
      const cookie = await devLogin(harness, "claimer", "editor");
      const { workItemId, annotationId } = await createReadyWorkItem(harness);
      const { status, body } = await claimWorkItem(harness, { cookie }, workItemId);
      expect(status).toBe(201);

      expect(Object.keys(body).sort()).toEqual([
        "context",
        "document",
        "lease",
        "submissionSchema",
        "target",
        "workItem",
      ]);
      expect(body["workItem"]).toEqual({
        id: workItemId,
        type: "revise_range",
        acceptanceCriteria: [
          "Preserve point of view.",
          "Change only the selected span.",
          "Keep continuity facts intact.",
        ],
        priority: "normal",
      });
      const lease = leaseOf(body);
      expect(lease.token).toMatch(LEASE_TOKEN_REGEX);
      // Design §25 defaults from the fake clock's 18:00:00Z.
      expect(lease.expiresAt).toBe("2026-07-19T18:30:00Z");
      expect(lease.maxExpiresAt).toBe("2026-07-19T22:00:00Z");
      // Contract §3 (amended): the claim advertises the renewal prompt instant
      // so a fresh lease honours the deployment's configured lead time rather
      // than the client assuming the default.
      expect(lease.renewalPromptAt).toBe("2026-07-19T18:25:00Z");
      const document = body["document"] as Record<string, unknown>;
      expect(document["chapterId"]).toBe(CHAPTER_ID);
      expect(document["revision"]).toBe(3);
      expect(document["contentHash"]).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(typeof document["source"]).toBe("string");
      expect(document["source"]).toContain("The drift appeared on the ridge at dawn.");
      expect(body["target"]).toEqual({
        blockId: BLOCK_ID_1,
        exact: "drift appeared on",
        start: 4,
        end: 21,
      });
      const context = body["context"] as Record<string, unknown>;
      expect(context["annotationBody"]).toBe("Consider tightening this opening line.");
      expect(context["chapterSummary"]).toBe("The anomaly is first sighted.");
      expect(Array.isArray(context["storyRefs"])).toBe(true);
      expect(body["submissionSchema"]).toBe("authorbot.submission/range-replacement/v1");

      // The token is stored hash-only.
      const active = await harness.repos.leases.getActiveByWorkItem(workItemId);
      expect(active?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(active?.tokenHash).not.toContain(lease.token);
      // work_item_leased event emitted; annotationId untouched by claim.
      expect(await eventTypes(harness)).toContain("work_item_leased");
      const annotation = await harness.repos.annotations.getById(annotationId);
      expect(annotation?.status).toBe("work_item_created");
    } finally {
      harness.close();
    }
  });

  it("replays a claim idempotently with the token redacted from storage", async () => {
    const harness = await makePhase4Harness();
    try {
      const cookie = await devLogin(harness, "claimer", "editor");
      const { workItemId } = await createReadyWorkItem(harness);
      const key = uuidv7();
      const request = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
          Origin: "http://localhost",
          Cookie: cookie,
        },
      };
      const url = `/v1/projects/${harness.projectId}/work-items/${workItemId}/claim`;
      const first = await harness.app.request(url, request);
      expect(first.status).toBe(201);
      const replay = await harness.app.request(url, request);
      expect(replay.status).toBe(201);
      expect(replay.headers.get("x-idempotency-replayed")).toBe("true");
      const replayBody = (await replay.json()) as { lease: Record<string, unknown> };
      // The replayed (stored) body never contains the plaintext again.
      expect(replayBody.lease["token"]).toBeUndefined();
      expect(replayBody.lease["tokenRedacted"]).toBe(true);
    } finally {
      harness.close();
    }
  });

  it("denies claims without work:claim (contributor) and on non-claimable statuses", async () => {
    const harness = await makePhase4Harness();
    try {
      const contributor = await devLogin(harness, "contrib", "contributor");
      const { workItemId } = await createReadyWorkItem(harness);
      const denied = await claimWorkItem(harness, { cookie: contributor }, workItemId);
      expect(denied.status).toBe(403);

      const editor = await devLogin(harness, "editor-a", "editor");
      await harness.repos.workItems.updateStatus(workItemId, "cancelled", "2026-07-19T18:01:00Z");
      const conflict = await claimWorkItem(harness, { cookie: editor }, workItemId);
      expect(conflict.status).toBe(409);
      expect(conflict.body["code"]).toBe("state-conflict");
    } finally {
      harness.close();
    }
  });

  it("agent tokens with work:claim can claim (same interface as humans)", async () => {
    const harness = await makePhase4Harness();
    try {
      const maintainer = await devLogin(harness, "boss", "maintainer");
      const { token } = await mintToken(harness, maintainer, ["work:read", "work:claim", "submissions:write"]);
      const { workItemId } = await createReadyWorkItem(harness);
      const result = await claimWorkItem(harness, { token }, workItemId);
      expect(result.status).toBe(201);
    } finally {
      harness.close();
    }
  });

  it("claims over an expired lease by expiring it in the same batch (lazy takeover)", async () => {
    const harness = await makePhase4Harness();
    try {
      const first = await devLogin(harness, "first", "editor");
      const second = await devLogin(harness, "second", "editor");
      const { workItemId } = await createReadyWorkItem(harness);
      const claimed = await claimWorkItem(harness, { cookie: first }, workItemId);
      expect(claimed.status).toBe(201);
      const staleLeaseId = leaseOf(claimed.body).id;

      // Still held while live.
      const held = await claimWorkItem(harness, { cookie: second }, workItemId);
      expect(held.status).toBe(409);

      harness.clock.advanceMs(31 * MINUTE);
      const takeover = await claimWorkItem(harness, { cookie: second }, workItemId);
      expect(takeover.status).toBe(201);
      const stale = await harness.repos.leases.getById(staleLeaseId);
      expect(stale?.revokedAt).not.toBeNull();
      const active = await harness.repos.leases.getActiveByWorkItem(workItemId);
      expect(active?.id).toBe(leaseOf(takeover.body).id);
      const types = await eventTypes(harness);
      expect(types.filter((t) => t === "work_item_leased")).toHaveLength(2);
      expect(types).toContain("lease_expired");
    } finally {
      harness.close();
    }
  });
});

describe("stale-lease matrix (contract §8 exit criterion 2)", () => {
  async function claimedHarness(): Promise<{
    harness: Phase4Harness;
    cookie: string;
    workItemId: string;
    leaseId: string;
    token: string;
  }> {
    const harness = await makePhase4Harness();
    const cookie = await devLogin(harness, "holder", "editor");
    const { workItemId } = await createReadyWorkItem(harness);
    const { status, body } = await claimWorkItem(harness, { cookie }, workItemId);
    expect(status).toBe(201);
    const lease = leaseOf(body);
    return { harness, cookie, workItemId, leaseId: lease.id, token: lease.token };
  }

  it("renewing an EXPIRED lease → 409 lease-expired, item back to ready + event (lazy expiry)", async () => {
    const { harness, cookie, workItemId, leaseId, token } = await claimedHarness();
    try {
      harness.clock.advanceMs(30 * MINUTE); // expiry is inclusive at expires_at
      const response = await renew(harness, cookie, workItemId, leaseId, token);
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("lease-expired");
      const item = await harness.repos.workItems.getById(workItemId);
      expect(item?.status).toBe("ready");
      expect(await eventTypes(harness)).toContain("lease_expired");
    } finally {
      harness.close();
    }
  });

  it("renewing a RELEASED lease → 409", async () => {
    const { harness, cookie, workItemId, leaseId, token } = await claimedHarness();
    try {
      const release = await harness.app.request(
        `/v1/projects/${harness.projectId}/work-items/${workItemId}/lease/release`,
        jsonRequest("POST", {}, { Cookie: cookie }),
      );
      expect(release.status).toBe(200);
      const item = await harness.repos.workItems.getById(workItemId);
      expect(item?.status).toBe("ready");
      expect(await eventTypes(harness)).toContain("lease_released");

      const response = await renew(harness, cookie, workItemId, leaseId, token);
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("lease-inactive");
    } finally {
      harness.close();
    }
  });

  it("renewing a REVOKED lease → 409", async () => {
    const { harness, cookie, workItemId, leaseId, token } = await claimedHarness();
    try {
      await harness.db
        .prepare(`UPDATE leases SET revoked_at = ? WHERE id = ?`)
        .bind("2026-07-19T18:05:00Z", leaseId)
        .run();
      const response = await renew(harness, cookie, workItemId, leaseId, token);
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("lease-inactive");
    } finally {
      harness.close();
    }
  });

  it("renewing with a WRONG token → 403 lease-token-invalid (before expiry checks)", async () => {
    const { harness, cookie, workItemId, leaseId } = await claimedHarness();
    try {
      const wrong = `authorbot_lease_${"x".repeat(43)}`;
      const response = await renew(harness, cookie, workItemId, leaseId, wrong);
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe("lease-token-invalid");
      // Someone else's session cannot renew even with the right token shape.
      const thief = await devLogin(harness, "thief", "editor");
      const stolen = await renew(harness, thief, workItemId, leaseId, wrong);
      expect(stolen.status).toBe(403);
    } finally {
      harness.close();
    }
  });

  it("renewal extends from current expiry, clamps at max, then rejects MAX-TOTAL-EXCEEDED", async () => {
    const harness = await makePhase4Harness({
      config: {
        leaseConfig: leaseConfigFromEnv({
          LEASE_DURATION: "PT10M",
          LEASE_RENEWAL_DURATION: "PT10M",
          LEASE_MAX_TOTAL_DURATION: "PT15M",
          LEASE_RENEWAL_PROMPT_BEFORE: "PT1M",
        }),
      },
    });
    try {
      const cookie = await devLogin(harness, "holder", "editor");
      const { workItemId } = await createReadyWorkItem(harness);
      const { body } = await claimWorkItem(harness, { cookie }, workItemId);
      const lease = leaseOf(body);
      expect(lease.expiresAt).toBe("2026-07-19T18:10:00Z");
      expect(lease.maxExpiresAt).toBe("2026-07-19T18:15:00Z");

      // Partial clamp: 18:10 + 10m capped at 18:15 — allowed.
      const first = await renew(harness, cookie, workItemId, lease.id, lease.token);
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { expiresAt: string; renewalCount: number };
      expect(firstBody.expiresAt).toBe("2026-07-19T18:15:00Z");
      expect(firstBody.renewalCount).toBe(1);

      // At the cap: no extension possible.
      const second = await renew(harness, cookie, workItemId, lease.id, lease.token);
      expect(second.status).toBe(409);
      expect(((await second.json()) as { code: string }).code).toBe("lease-max-total-exceeded");
      expect(await eventTypes(harness)).toContain("lease_renewed");
    } finally {
      harness.close();
    }
  });

  it("sweepExpiredLeases returns items to ready with events (eager path)", async () => {
    const { harness, workItemId } = await claimedHarness();
    try {
      harness.clock.advanceMs(31 * MINUTE);
      const result = await sweepExpiredLeases(harness.db, harness.clock);
      expect(result.expired).toBe(1);
      const item = await harness.repos.workItems.getById(workItemId);
      expect(item?.status).toBe("ready");
      expect(await eventTypes(harness)).toContain("lease_expired");
      // Idempotent: a second sweep finds nothing.
      expect((await sweepExpiredLeases(harness.db, harness.clock)).expired).toBe(0);
    } finally {
      harness.close();
    }
  });

  it("release by a maintainer (non-holder) works; by a rando does not", async () => {
    const { harness, workItemId } = await claimedHarness();
    try {
      const rando = await devLogin(harness, "rando", "editor");
      const denied = await harness.app.request(
        `/v1/projects/${harness.projectId}/work-items/${workItemId}/lease/release`,
        jsonRequest("POST", {}, { Cookie: rando }),
      );
      expect(denied.status).toBe(403);

      const maintainer = await devLogin(harness, "boss", "maintainer");
      const released = await harness.app.request(
        `/v1/projects/${harness.projectId}/work-items/${workItemId}/lease/release`,
        jsonRequest("POST", {}, { Cookie: maintainer }),
      );
      expect(released.status).toBe(200);
      expect((await harness.repos.workItems.getById(workItemId))?.status).toBe("ready");
    } finally {
      harness.close();
    }
  });
});

describe("lease config boot validation (contract §2)", () => {
  it("parses LEASE_* ISO durations and applies design §25 defaults", () => {
    expect(leaseConfigFromEnv({})).toEqual(DEFAULT_LEASE_CONFIG);
    const custom = leaseConfigFromEnv({
      LEASE_DURATION: "PT15M",
      LEASE_MAX_TOTAL_DURATION: "PT2H",
    });
    expect(custom.durationMs).toBe(15 * MINUTE);
    expect(custom.maxTotalDurationMs).toBe(2 * HOUR);
    expect(custom.renewalDurationMs).toBe(DEFAULT_LEASE_CONFIG.renewalDurationMs);
  });

  it("throws at boot on malformed or cross-field-invalid values", () => {
    expect(() => leaseConfigFromEnv({ LEASE_DURATION: "30 minutes" })).toThrow(/LEASE_DURATION/);
    expect(() => leaseConfigFromEnv({ LEASE_DURATION: "PT0M" })).toThrow(/LEASE_DURATION/);
    expect(() =>
      leaseConfigFromEnv({ LEASE_DURATION: "PT5H", LEASE_MAX_TOTAL_DURATION: "PT4H" }),
    ).toThrow(/invalid LEASE_/);
  });
});
