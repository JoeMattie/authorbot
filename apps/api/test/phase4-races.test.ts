/**
 * Phase 4 cross-isolate interleaving regressions (contract §2, §4, §8.1-8.2).
 *
 * The per-project `serialize()` queue orders commands inside ONE process; the
 * deployed D1/Workers topology runs many isolates, and the database
 * constraints are the real arbiter (serializer.ts: "DB unique indexes and
 * NULL-abort compare-and-swap statements are the cross-isolate backstops").
 * The in-process suites therefore cannot reach the states these tests need -
 * the serializer hides them, which is exactly why the defects here survived a
 * green suite.
 *
 * {@link interleaveBeforeBatch} supplies the missing primitive: it runs a
 * rival mutation immediately BEFORE a command's `db.batch` commits, which is
 * precisely what a second isolate winning the race looks like from the first
 * isolate's point of view. The rival's writes go through `.run()` rather than
 * `batch`, so they do not re-enter the hook.
 */
import { describe, expect, it } from "vitest";
import type { SqlRunResult, SqlStatement } from "@authorbot/database";
import { sweepExpiredLeases } from "../src/index.js";
import { contentSafetyFindings } from "../src/phase4.js";
import { uuidv7 } from "../src/ids.js";
import { devLogin, jsonRequest } from "./helpers.js";
import {
  claimWorkItem,
  createReadyWorkItem,
  makePhase4Harness,
  type Phase4Harness,
} from "./phase4-helpers.js";

const MINUTE = 60 * 1000;

interface LeaseBundle {
  id: string;
  token: string;
  expiresAt: string;
  maxExpiresAt: string;
}

function leaseOf(bundle: Record<string, unknown>): LeaseBundle {
  return bundle["lease"] as LeaseBundle;
}

async function eventTypes(harness: Phase4Harness): Promise<string[]> {
  const events = await harness.repos.events.listAfter(harness.projectId, 0, 500);
  return events.map((e) => e.type);
}

/**
 * Run `rival` immediately before the Nth `db.batch` (default: the first),
 * then restore the original. Simulates another isolate committing between a
 * handler's reads and its write.
 */
function interleaveBeforeBatch(
  harness: Phase4Harness,
  rival: () => Promise<void>,
  options: { onBatch?: number } = {},
): void {
  const target = options.onBatch ?? 1;
  const db = harness.db as unknown as {
    batch(statements: SqlStatement[]): Promise<SqlRunResult[]>;
  };
  const original = db.batch.bind(harness.db);
  let seen = 0;
  db.batch = async (statements: SqlStatement[]): Promise<SqlRunResult[]> => {
    seen += 1;
    if (seen === target) {
      db.batch = original;
      await rival();
    }
    return original(statements);
  };
}

/** Insert an active lease for `workItemId` held by a fresh actor. */
async function rivalClaim(
  harness: Phase4Harness,
  workItemId: string,
  displayName: string,
): Promise<string> {
  const now = harness.clock.now();
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const actorId = uuidv7(now);
  await harness.repos.actors.insert({
    id: actorId,
    type: "human",
    displayName,
    externalIdentity: `github:${displayName}`,
    ownerActorId: null,
    status: "active",
    createdAt: timestamp,
  });
  const leaseId = uuidv7(now);
  await harness.repos.leases.claimStatement({
    id: leaseId,
    projectId: harness.projectId,
    workItemId,
    actorId,
    tokenHash: "0".repeat(64),
    issuedAt: timestamp,
    expiresAt: new Date(now.getTime() + 30 * MINUTE).toISOString().replace(/\.\d{3}Z$/, "Z"),
    maxExpiresAt: new Date(now.getTime() + 4 * 60 * MINUTE).toISOString().replace(/\.\d{3}Z$/, "Z"),
    renewalCount: 0,
    releasedAt: null,
    revokedAt: null,
  }).run();
  await harness.db
    .prepare(`UPDATE work_items SET status = 'leased' WHERE id = ?`)
    .bind(workItemId)
    .run();
  return leaseId;
}

/**
 * Rotate only the capability hash, as the atomic core of a recovery committed
 * by another isolate. Calling the real route here would re-enter this test
 * process's serializer while the losing command still owns it.
 */
async function rivalRecoveryRotation(
  harness: Phase4Harness,
  leaseId: string,
): Promise<string> {
  const lease = await harness.repos.leases.getById(leaseId);
  if (lease === null) {
    throw new Error("cannot rotate a missing lease");
  }
  const replacementHash = "f".repeat(64);
  await harness.repos.leases
    .rotateTokenCasStatement(
      lease.id,
      lease.tokenHash,
      lease.expiresAt,
      lease.renewalCount,
      replacementHash,
      harness.clock.now().toISOString().replace(/\.\d{3}Z$/, "Z"),
    )
    .run();
  return replacementHash;
}

describe("claim races across isolates (contract §2, §8.1)", () => {
  it("the loser of a cross-isolate claim race gets 409 lease-held, never 500", async () => {
    const harness = await makePhase4Harness();
    try {
      const cookie = await devLogin(harness, "loser", "editor");
      const { workItemId } = await createReadyWorkItem(harness);

      // Isolate 1 commits its claim while isolate 2 is mid-handler.
      interleaveBeforeBatch(harness, async () => {
        await rivalClaim(harness, workItemId, "winner");
      });

      const result = await claimWorkItem(harness, { cookie }, workItemId);
      expect(result.status).toBe(409);
      expect(result.body["code"]).toBe("lease-held");
      // Holder-safe info only: a display name, never a token.
      expect(result.body["holder"]).toBe("winner");
      expect(JSON.stringify(result.body)).not.toContain("token");

      // Exactly one active lease survives - the winner's.
      const active = await harness.repos.leases.getActiveByWorkItem(workItemId);
      expect(active?.tokenHash).toBe("0".repeat(64));
    } finally {
      harness.close();
    }
  });

  it("a claim racing a sweep still succeeds (the item is free) instead of 500", async () => {
    const harness = await makePhase4Harness();
    try {
      const first = await devLogin(harness, "first", "editor");
      const second = await devLogin(harness, "second", "editor");
      const { workItemId } = await createReadyWorkItem(harness);
      expect((await claimWorkItem(harness, { cookie: first }, workItemId)).status).toBe(201);

      // The first lease has expired; the second actor claims it over. The
      // sweep timer fires inside the handler, revoking the lease and putting
      // the item back to `ready` - so the handler's `leased → leased` CAS
      // aborts on a claim that is entirely legal.
      harness.clock.advanceMs(31 * MINUTE);
      interleaveBeforeBatch(harness, async () => {
        await sweepExpiredLeases(harness.db, harness.clock);
      });

      const takeover = await claimWorkItem(harness, { cookie: second }, workItemId);
      expect(takeover.status).toBe(201);
      const active = await harness.repos.leases.getActiveByWorkItem(workItemId);
      expect(active?.id).toBe(leaseOf(takeover.body).id);
      expect((await harness.repos.workItems.getById(workItemId))?.status).toBe("leased");
      // The expiry is reported exactly once, by whichever path won it.
      const expired = (await eventTypes(harness)).filter((t) => t === "lease_expired");
      expect(expired).toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  it("claim self-heals a work item stranded `leased` with no active lease", async () => {
    const harness = await makePhase4Harness();
    try {
      const first = await devLogin(harness, "first", "editor");
      const second = await devLogin(harness, "second", "editor");
      const { workItemId } = await createReadyWorkItem(harness);
      const claimed = await claimWorkItem(harness, { cookie: first }, workItemId);
      expect(claimed.status).toBe(201);

      // What an interrupted expiry or a bare administrative revocation leaves
      // behind: the slot is empty but the item still reads `leased`. This used
      // to be permanently unclaimable, unreleasable, and unsweepable.
      await harness.db
        .prepare(`UPDATE leases SET revoked_at = ? WHERE id = ?`)
        .bind("2026-07-19T18:05:00Z", leaseOf(claimed.body).id)
        .run();
      expect(await harness.repos.leases.getActiveByWorkItem(workItemId)).toBeNull();
      expect((await harness.repos.workItems.getById(workItemId))?.status).toBe("leased");

      const recovered = await claimWorkItem(harness, { cookie: second }, workItemId);
      expect(recovered.status).toBe(201);
      expect((await harness.repos.workItems.getById(workItemId))?.status).toBe("leased");
    } finally {
      harness.close();
    }
  });
});

describe("expiry atomicity (contract §2, §8.2)", () => {
  it("a failed expiry write leaves NOTHING applied - no half-expired lease", async () => {
    const harness = await makePhase4Harness();
    try {
      const cookie = await devLogin(harness, "holder", "editor");
      const { workItemId } = await createReadyWorkItem(harness);
      const claimed = await claimWorkItem(harness, { cookie }, workItemId);
      const leaseId = leaseOf(claimed.body).id;
      harness.clock.advanceMs(31 * MINUTE);

      // The expiry must be ONE transaction. Splitting the revocation from the
      // work-item reset stranded the item `leased` with an empty lease slot,
      // no `lease_expired` event, and no way back through any interface.
      const db = harness.db as unknown as {
        batch(statements: SqlStatement[]): Promise<SqlRunResult[]>;
      };
      const original = db.batch.bind(harness.db);
      db.batch = async (): Promise<SqlRunResult[]> => {
        db.batch = original;
        throw new Error("simulated crash mid-expiry");
      };

      await expect(sweepExpiredLeases(harness.db, harness.clock)).rejects.toThrow(
        "simulated crash mid-expiry",
      );

      // Nothing partially applied: the lease is still active and sweepable.
      const lease = await harness.repos.leases.getById(leaseId);
      expect(lease?.revokedAt).toBeNull();
      expect(await eventTypes(harness)).not.toContain("lease_expired");

      const retry = await sweepExpiredLeases(harness.db, harness.clock);
      expect(retry.expired).toBe(1);
      expect((await harness.repos.workItems.getById(workItemId))?.status).toBe("ready");
      expect((await eventTypes(harness)).filter((t) => t === "lease_expired")).toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  it("a sweep racing a lazy expiry emits `lease_expired` exactly once", async () => {
    const harness = await makePhase4Harness();
    try {
      const cookie = await devLogin(harness, "holder", "editor");
      const { workItemId } = await createReadyWorkItem(harness);
      const claimed = await claimWorkItem(harness, { cookie }, workItemId);
      const { id: leaseId, token } = leaseOf(claimed.body);
      harness.clock.advanceMs(31 * MINUTE);

      // Both paths run against the SAME frozen clock, so a timestamp-based
      // "did I win?" test would let both claim the expiry.
      await Promise.all([
        sweepExpiredLeases(harness.db, harness.clock),
        harness.app.request(
          `/v1/projects/${harness.projectId}/work-items/${workItemId}/lease/renew`,
          jsonRequest("POST", { leaseId, leaseToken: token }, { Cookie: cookie }),
        ),
      ]);

      expect((await eventTypes(harness)).filter((t) => t === "lease_expired")).toHaveLength(1);
      expect((await harness.repos.workItems.getById(workItemId))?.status).toBe("ready");
    } finally {
      harness.close();
    }
  });
});

describe("recovery races across isolates (contract §2, §8.2)", () => {
  it("rejects recovery when a concurrent renewal changes its response snapshot", async () => {
    const harness = await makePhase4Harness();
    try {
      const cookie = await devLogin(harness, "holder", "editor");
      const { workItemId } = await createReadyWorkItem(harness);
      const claimed = await claimWorkItem(harness, { cookie }, workItemId);
      const leaseId = leaseOf(claimed.body).id;
      const before = await harness.repos.leases.getById(leaseId);
      expect(before).not.toBeNull();
      const renewedExpiresAt = new Date(
        Date.parse(before?.expiresAt ?? "") + 30 * MINUTE,
      ).toISOString().replace(/\.\d{3}Z$/, "Z");

      // Another isolate renews after recovery has built its response but
      // before token rotation and idempotency storage commit.
      interleaveBeforeBatch(harness, async () => {
        await harness.repos.leases
          .renewCasStatement(
            leaseId,
            before?.tokenHash ?? "missing",
            renewedExpiresAt,
            harness.clock.now().toISOString().replace(/\.\d{3}Z$/, "Z"),
          )
          .run();
      });

      const response = await harness.app.request(
        `/v1/projects/${harness.projectId}/work-items/${workItemId}/lease/recover`,
        jsonRequest(
          "POST",
          { leaseId },
          { Cookie: cookie, "Idempotency-Key": uuidv7() },
        ),
      );
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("state-conflict");

      const after = await harness.repos.leases.getById(leaseId);
      expect(after?.expiresAt).toBe(renewedExpiresAt);
      expect(after?.renewalCount).toBe(1);
      expect(after?.tokenHash).toBe(before?.tokenHash);
      expect(await eventTypes(harness)).not.toContain("lease_recovered");
      const audits = await harness.db
        .prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'lease.recover'`)
        .first();
      expect(Number(audits?.["n"])).toBe(0);
    } finally {
      harness.close();
    }
  });
});

describe("renew races across isolates (contract §2, §8.2)", () => {
  it("a renewal that loses the race is rejected - no false 200, event, or audit row", async () => {
    const harness = await makePhase4Harness();
    try {
      const cookie = await devLogin(harness, "holder", "editor");
      const { workItemId } = await createReadyWorkItem(harness);
      const claimed = await claimWorkItem(harness, { cookie }, workItemId);
      const { id: leaseId, token } = leaseOf(claimed.body);

      // Another isolate releases the lease after this handler's liveness
      // checks and before its write.
      interleaveBeforeBatch(harness, async () => {
        await harness.repos.leases.release(leaseId, "2026-07-19T18:10:00Z");
      });

      const response = await harness.app.request(
        `/v1/projects/${harness.projectId}/work-items/${workItemId}/lease/renew`,
        jsonRequest("POST", { leaseId, leaseToken: token }, { Cookie: cookie }),
      );
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("lease-inactive");

      // The renewal did not happen, so nothing may claim it did.
      const lease = await harness.repos.leases.getById(leaseId);
      expect(lease?.renewalCount).toBe(0);
      expect(await eventTypes(harness)).not.toContain("lease_renewed");
      const audits = await harness.db
        .prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'lease.renew'`)
        .first();
      expect(Number(audits?.["n"])).toBe(0);
    } finally {
      harness.close();
    }
  });

  it("recovery invalidates an old-token renewal that was already past verification", async () => {
    const harness = await makePhase4Harness();
    try {
      const cookie = await devLogin(harness, "holder", "editor");
      const { workItemId } = await createReadyWorkItem(harness);
      const claimed = await claimWorkItem(harness, { cookie }, workItemId);
      const { id: leaseId, token } = leaseOf(claimed.body);
      const before = await harness.repos.leases.getById(leaseId);
      expect(before).not.toBeNull();

      // This handler has already verified `token` against the old hash when
      // the rival recovery rotates it immediately before the renew batch.
      let replacementHash = "";
      interleaveBeforeBatch(harness, async () => {
        replacementHash = await rivalRecoveryRotation(harness, leaseId);
      });

      const response = await harness.app.request(
        `/v1/projects/${harness.projectId}/work-items/${workItemId}/lease/renew`,
        jsonRequest("POST", { leaseId, leaseToken: token }, { Cookie: cookie }),
      );
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe("lease-token-invalid");

      const after = await harness.repos.leases.getById(leaseId);
      expect(after?.tokenHash).toBe(replacementHash);
      expect(after?.expiresAt).toBe(before?.expiresAt);
      expect(after?.renewalCount).toBe(0);
      expect(await eventTypes(harness)).not.toContain("lease_renewed");
      const audits = await harness.db
        .prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'lease.renew'`)
        .first();
      expect(Number(audits?.["n"])).toBe(0);
    } finally {
      harness.close();
    }
  });
});

describe("submission races across isolates (contract §4, §8.2)", () => {
  it("an expired lease's edit cannot land after the item was re-claimed", async () => {
    const harness = await makePhase4Harness();
    try {
      const cookie = await devLogin(harness, "author", "editor");
      const { workItemId } = await createReadyWorkItem(harness);
      const claimed = await claimWorkItem(harness, { cookie }, workItemId);
      const bundle = claimed.body;
      const { id: leaseId, token } = leaseOf(bundle);
      const document = bundle["document"] as { revision: number; contentHash: string };

      // While this submission is in flight, another isolate expires the lease
      // and hands the item to a fresh claimant. The item is `leased` again -
      // by someone else - so a work-item-status CAS alone cannot tell.
      let rivalLeaseId = "";
      interleaveBeforeBatch(harness, async () => {
        await harness.db
          .prepare(`UPDATE leases SET revoked_at = ? WHERE id = ?`)
          .bind("2026-07-19T18:20:00Z", leaseId)
          .run();
        rivalLeaseId = await rivalClaim(harness, workItemId, "successor");
      });

      const response = await harness.app.request(
        `/v1/projects/${harness.projectId}/work-items/${workItemId}/submissions`,
        jsonRequest(
          "POST",
          {
            leaseId,
            leaseToken: token,
            type: "range_replacement",
            baseRevision: document.revision,
            baseContentHash: document.contentHash,
            content: "drifted in over",
          },
          { Cookie: cookie, "Idempotency-Key": uuidv7() },
        ),
      );

      expect(response.status).toBe(409);
      // Nothing of the submission persisted.
      const submissions = await harness.db.prepare(`SELECT COUNT(*) AS n FROM submissions`).first();
      expect(Number(submissions?.["n"])).toBe(0);
      const outbox = await harness.db
        .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'submission.apply'`)
        .first();
      expect(Number(outbox?.["n"])).toBe(0);
      // The successor still holds a live lease on an item still `leased`.
      const active = await harness.repos.leases.getActiveByWorkItem(workItemId);
      expect(active?.id).toBe(rivalLeaseId);
      expect((await harness.repos.workItems.getById(workItemId))?.status).toBe("leased");
    } finally {
      harness.close();
    }
  });

  it("recovery invalidates an old-token submission that was already past verification", async () => {
    const harness = await makePhase4Harness();
    try {
      const cookie = await devLogin(harness, "author", "editor");
      const { workItemId } = await createReadyWorkItem(harness);
      const claimed = await claimWorkItem(harness, { cookie }, workItemId);
      const bundle = claimed.body;
      const { id: leaseId, token } = leaseOf(bundle);
      const document = bundle["document"] as { revision: number; contentHash: string };

      // Recovery wins after this handler verifies the old plaintext but before
      // its submission/operation/outbox batch reaches D1.
      let replacementHash = "";
      interleaveBeforeBatch(harness, async () => {
        replacementHash = await rivalRecoveryRotation(harness, leaseId);
      });

      const response = await harness.app.request(
        `/v1/projects/${harness.projectId}/work-items/${workItemId}/submissions`,
        jsonRequest(
          "POST",
          {
            leaseId,
            leaseToken: token,
            type: "range_replacement",
            baseRevision: document.revision,
            baseContentHash: document.contentHash,
            content: "drifted in over",
          },
          { Cookie: cookie, "Idempotency-Key": uuidv7() },
        ),
      );
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe("lease-token-invalid");

      // The token rotation survives, while every part of the stale submission
      // batch rolls back atomically.
      const active = await harness.repos.leases.getActiveByWorkItem(workItemId);
      expect(active?.id).toBe(leaseId);
      expect(active?.tokenHash).toBe(replacementHash);
      expect(active?.releasedAt).toBeNull();
      expect((await harness.repos.workItems.getById(workItemId))?.status).toBe("leased");
      const submissions = await harness.db.prepare(`SELECT COUNT(*) AS n FROM submissions`).first();
      expect(Number(submissions?.["n"])).toBe(0);
      const outbox = await harness.db
        .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'submission.apply'`)
        .first();
      expect(Number(outbox?.["n"])).toBe(0);
      expect(await eventTypes(harness)).not.toContain("submission_received");
      const audits = await harness.db
        .prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'submission.create'`)
        .first();
      expect(Number(audits?.["n"])).toBe(0);
    } finally {
      harness.close();
    }
  });
});

describe("submission content validation (contract §4 step 9)", () => {
  it("a leading frontmatter fence does not hide unsafe content from the scan", () => {
    // `remark-frontmatter` swallows everything up to the closing `---` into an
    // opaque `yaml` node the safety scan never visits, so a payload merely
    // STARTING with a fence was accepted verbatim.
    const findings = contentSafetyFindings(
      "---\n<script>alert(1)</script>\n[x](javascript:alert(2))\n---\n\nHello world.\n",
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join(" ")).toContain("raw HTML");
    expect(findings.join(" ")).toContain("javascript");
    // Without the fence the same payload was always caught - proving the
    // fence was the sole cause.
    expect(contentSafetyFindings("<script>alert(1)</script>\n")).not.toHaveLength(0);
  });

  it("rejects fenced unsafe content with 422 instead of accepting it with 202", async () => {
    const harness = await makePhase4Harness();
    try {
      const cookie = await devLogin(harness, "author", "editor");
      const { workItemId } = await createReadyWorkItem(harness, { type: "revise_chapter" });
      const claimed = await claimWorkItem(harness, { cookie }, workItemId);
      const { id: leaseId, token } = leaseOf(claimed.body);
      const document = claimed.body["document"] as { revision: number; contentHash: string };

      const response = await harness.app.request(
        `/v1/projects/${harness.projectId}/work-items/${workItemId}/submissions`,
        jsonRequest(
          "POST",
          {
            leaseId,
            leaseToken: token,
            type: "chapter_replacement",
            baseRevision: document.revision,
            baseContentHash: document.contentHash,
            content: "---\n<script>alert(1)</script>\n---\n\nA new body.\n",
          },
          { Cookie: cookie, "Idempotency-Key": uuidv7() },
        ),
      );
      expect(response.status).toBe(422);
      expect(((await response.json()) as { code: string }).code).toBe("unsafe-content");
      const submissions = await harness.db.prepare(`SELECT COUNT(*) AS n FROM submissions`).first();
      expect(Number(submissions?.["n"])).toBe(0);
    } finally {
      harness.close();
    }
  });

  it("rejects a multi-line range replacement up front, not as a fake conflict", async () => {
    const harness = await makePhase4Harness();
    try {
      const cookie = await devLogin(harness, "author", "editor");
      const { workItemId } = await createReadyWorkItem(harness);
      const claimed = await claimWorkItem(harness, { cookie }, workItemId);
      const { id: leaseId, token } = leaseOf(claimed.body);
      const document = claimed.body["document"] as { revision: number; contentHash: string };

      const response = await harness.app.request(
        `/v1/projects/${harness.projectId}/work-items/${workItemId}/submissions`,
        jsonRequest(
          "POST",
          {
            leaseId,
            leaseToken: token,
            type: "range_replacement",
            baseRevision: document.revision,
            baseContentHash: document.contentHash,
            content: "drifted in\nover the ridge",
          },
          { Cookie: cookie, "Idempotency-Key": uuidv7() },
        ),
      );
      // The base did NOT move, so a conflict would have been a lie - and it
      // would have burned the work item and committed a conflict artifact.
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("validation-failed");
      expect((await harness.repos.workItems.getById(workItemId))?.status).toBe("leased");
      expect(harness.writer.commits).toHaveLength(0);
    } finally {
      harness.close();
    }
  });
});

describe("task bundle fidelity (contract §3)", () => {
  it("a resolve_conflict bundle carries merge criteria and no range target", async () => {
    const harness = await makePhase4Harness();
    try {
      const cookie = await devLogin(harness, "merger", "editor");
      const { workItemId } = await createReadyWorkItem(harness, { type: "resolve_conflict" });
      const claimed = await claimWorkItem(harness, { cookie }, workItemId);
      expect(claimed.status).toBe(201);

      const workItem = claimed.body["workItem"] as { acceptanceCriteria: string[] };
      // The Git artifact for this type says "merge, never discard either
      // silently"; the bundle must not tell the same claimant to change only
      // a selected span while demanding a whole-chapter submission.
      expect(workItem.acceptanceCriteria.join(" ")).toContain("Merge the submitted change");
      expect(workItem.acceptanceCriteria.join(" ")).not.toContain("Change only the selected span");
      // Chapter scope ⇒ no `target` (contract §3), even though the row
      // inherits the originating range selector.
      expect(claimed.body["submissionSchema"]).toBe(
        "authorbot.submission/chapter-replacement/v1",
      );
      expect(claimed.body).not.toHaveProperty("target");
    } finally {
      harness.close();
    }
  });

  it("claimable types with no submission flow report submissionSchema null", async () => {
    const harness = await makePhase4Harness();
    try {
      const cookie = await devLogin(harness, "planner", "editor");
      for (const type of ["write_chapter", "planning"] as const) {
        const { workItemId } = await createReadyWorkItem(harness, { type });
        const claimed = await claimWorkItem(harness, { cookie }, workItemId);
        expect(claimed.status).toBe(201);
        // Published as nullable in the OpenAPI TaskBundle schema.
        expect(claimed.body).toHaveProperty("submissionSchema");
        expect(claimed.body["submissionSchema"]).toBeNull();
      }
    } finally {
      harness.close();
    }
  });
});
