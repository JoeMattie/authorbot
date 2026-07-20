/**
 * Phase 4 contract §2/§4 database behavior: the partial-unique-index claim
 * race (two inserts, exactly one LeaseHeld), conditional renew/release/
 * expire UPDATE semantics across the expiry boundary, sweep correctness,
 * and the submission lifecycle's guarded state transitions.
 *
 * Timestamp vocabulary (all RFC 3339 UTC, fixed-width, so lexicographic
 * order is chronological): a lease is LIVE at `now` iff it is active
 * (released_at/revoked_at NULL) AND `expires_at > now` — expired means
 * `expires_at <= now`, the same boundary as human_sessions.
 */
import { describe, expect, it } from "vitest";
import { isConstraintError, isUniqueConstraintError } from "../src/sql.js";
import type {
  GitOperationRecord,
  LeaseRecord,
  SubmissionRecord,
  WorkItemRecord,
} from "../src/records.js";
import { NOW, seedBasics, uuidv7, type Seeded } from "./helpers.js";

const BEFORE_NOW = "2026-07-19T17:59:59Z"; // expired at NOW
const AFTER_NOW = "2026-07-19T18:00:01Z"; // live at NOW
const EXPIRES = "2026-07-19T18:30:00Z"; // issued NOW + PT30M
const RENEWED = "2026-07-19T19:00:00Z"; // + PT30M renewal
const MAX_EXPIRES = "2026-07-19T22:00:00Z"; // issued NOW + PT4H
const LATER = "2026-07-19T18:10:00Z";

function makeWorkItem(seeded: Seeded, overrides?: Partial<WorkItemRecord>): WorkItemRecord {
  return {
    id: uuidv7(),
    projectId: seeded.project.id,
    type: "revise_range",
    status: "ready",
    sourceAnnotationId: uuidv7(),
    chapterId: seeded.chapter.id,
    baseRevision: 1,
    target: null,
    priority: "normal",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeLease(
  seeded: Seeded,
  workItemId: string,
  overrides?: Partial<LeaseRecord>,
): LeaseRecord {
  return {
    id: uuidv7(),
    projectId: seeded.project.id,
    workItemId,
    actorId: seeded.actor.id,
    tokenHash: `sha256-hash-${uuidv7()}`, // hash only — never a plaintext token
    issuedAt: NOW,
    expiresAt: EXPIRES,
    maxExpiresAt: MAX_EXPIRES,
    renewalCount: 0,
    releasedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

async function seedWithWorkItem(): Promise<Seeded & { workItem: WorkItemRecord }> {
  const seeded = await seedBasics();
  const workItem = makeWorkItem(seeded);
  await seeded.repos.workItems.insert(workItem);
  return { ...seeded, workItem };
}

function makeSubmission(
  seeded: Seeded,
  workItemId: string,
  leaseId: string,
  overrides?: Partial<SubmissionRecord>,
): SubmissionRecord {
  return {
    id: uuidv7(),
    projectId: seeded.project.id,
    workItemId,
    leaseId,
    actorId: seeded.actor.id,
    type: "range_replacement",
    baseRevision: 1,
    baseContentHash: "sha256:abc123",
    content: "A tightened sentence.",
    summary: null,
    notes: null,
    state: "received",
    gitOperationId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("lease claim — one active lease per work item (contract §2)", () => {
  it("claims a free work item and reads it back as the active lease", async () => {
    const s = await seedWithWorkItem();
    const lease = makeLease(s, s.workItem.id);
    const result = await s.repos.leases.claim(lease);
    expect(result).toEqual({ status: "claimed", lease });
    expect(await s.repos.leases.getActiveByWorkItem(s.workItem.id)).toEqual(lease);
    expect(await s.repos.leases.getById(lease.id)).toEqual(lease);
  });

  it("two claims for the same work item: exactly one claimed, one typed lease_held", async () => {
    // Repeatable ×5 (contract §8 exit criterion 1) on fresh work items.
    for (let round = 0; round < 5; round += 1) {
      const s = await seedWithWorkItem();
      const a = makeLease(s, s.workItem.id);
      const b = makeLease(s, s.workItem.id);
      const results = [await s.repos.leases.claim(a), await s.repos.leases.claim(b)];
      const claimed = results.filter((r) => r.status === "claimed");
      const held = results.filter((r) => r.status === "lease_held");
      expect(claimed).toHaveLength(1);
      expect(held).toHaveLength(1);
      // The loser learns the winner — never a token, only the stored record.
      expect(held[0]).toMatchObject({ holder: { id: a.id } });
      const active = await s.repos.leases.getActiveByWorkItem(s.workItem.id);
      expect(active?.id).toBe(a.id);
    }
  });

  it("the index is per work item: claims on different items both succeed", async () => {
    const s = await seedWithWorkItem();
    const other = makeWorkItem(s);
    await s.repos.workItems.insert(other);
    expect((await s.repos.leases.claim(makeLease(s, s.workItem.id))).status).toBe("claimed");
    expect((await s.repos.leases.claim(makeLease(s, other.id))).status).toBe("claimed");
  });

  it("an ended lease frees the slot; many ended rows may coexist", async () => {
    const s = await seedWithWorkItem();
    const first = makeLease(s, s.workItem.id);
    await s.repos.leases.claim(first);
    expect(await s.repos.leases.release(first.id, LATER)).toBe(1);

    const second = makeLease(s, s.workItem.id, { expiresAt: BEFORE_NOW });
    expect((await s.repos.leases.claim(second)).status).toBe("claimed");
    expect(await s.repos.leases.expire(second.id, NOW)).toBe(1);

    const third = makeLease(s, s.workItem.id);
    expect((await s.repos.leases.claim(third)).status).toBe("claimed");
    expect((await s.repos.leases.getActiveByWorkItem(s.workItem.id))?.id).toBe(third.id);
  });

  it("an expired-but-unswept lease still holds the slot until expired in the claim batch", async () => {
    const s = await seedWithWorkItem();
    const stale = makeLease(s, s.workItem.id, { expiresAt: BEFORE_NOW });
    await s.repos.leases.claim(stale);

    // Lazy expiry is a query-time comparison: the slot is NOT free yet.
    const blocked = await s.repos.leases.claim(makeLease(s, s.workItem.id));
    expect(blocked).toMatchObject({ status: "lease_held", holder: { id: stale.id } });

    // The claim command expires the stale lease in the same batch (design
    // §12.2 step 1), then the INSERT wins.
    const fresh = makeLease(s, s.workItem.id);
    await s.db.batch([
      s.repos.leases.expireForWorkItemStatement(s.workItem.id, NOW),
      s.repos.leases.claimStatement(fresh),
      s.repos.workItems.updateStatusStatement(s.workItem.id, "leased", NOW),
    ]);
    expect((await s.repos.leases.getActiveByWorkItem(s.workItem.id))?.id).toBe(fresh.id);
    expect((await s.repos.leases.getById(stale.id))?.revokedAt).toBe(NOW);
    expect((await s.repos.workItems.getById(s.workItem.id))?.status).toBe("leased");
  });

  it("a losing claim batch aborts atomically: the work item stays ready", async () => {
    const s = await seedWithWorkItem();
    const holder = makeLease(s, s.workItem.id); // live — expireForWorkItem is a no-op
    await s.repos.leases.claim(holder);

    const loser = makeLease(s, s.workItem.id);
    let caught: unknown;
    try {
      await s.db.batch([
        s.repos.leases.expireForWorkItemStatement(s.workItem.id, NOW),
        s.repos.leases.claimStatement(loser),
        s.repos.workItems.updateStatusStatement(s.workItem.id, "leased", NOW),
      ]);
    } catch (error) {
      caught = error;
    }
    expect(isUniqueConstraintError(caught)).toBe(true);
    expect((await s.repos.workItems.getById(s.workItem.id))?.status).toBe("ready");
    expect(await s.repos.leases.getById(loser.id)).toBeNull();
    expect((await s.repos.leases.getActiveByWorkItem(s.workItem.id))?.id).toBe(holder.id);
  });
});

describe("lease renew — conditional UPDATE (contract §2)", () => {
  async function claimed(overrides?: Partial<LeaseRecord>) {
    const s = await seedWithWorkItem();
    const lease = makeLease(s, s.workItem.id, overrides);
    await s.repos.leases.claim(lease);
    return { ...s, lease };
  }

  it("renews a live lease: 1 row, new expiry, renewal_count bumped", async () => {
    const s = await claimed();
    expect(await s.repos.leases.renew(s.lease.id, RENEWED, NOW)).toBe(1);
    const after = await s.repos.leases.getById(s.lease.id);
    expect(after?.expiresAt).toBe(RENEWED);
    expect(after?.renewalCount).toBe(1);
  });

  it("caps the new expiry at max_expires_at in SQL", async () => {
    const s = await claimed({ expiresAt: "2026-07-19T21:45:00Z" });
    expect(await s.repos.leases.renew(s.lease.id, "2026-07-19T22:15:00Z", NOW)).toBe(1);
    expect((await s.repos.leases.getById(s.lease.id))?.expiresAt).toBe(MAX_EXPIRES);
  });

  it("rejects a renewal with no headroom (expires_at already at max): 0 rows", async () => {
    const s = await claimed({ expiresAt: MAX_EXPIRES });
    expect(await s.repos.leases.renew(s.lease.id, "2026-07-19T22:30:00Z", NOW)).toBe(0);
    expect((await s.repos.leases.getById(s.lease.id))?.renewalCount).toBe(0);
  });

  it("rejects renewing an expired lease, including exactly at the boundary", async () => {
    const before = await claimed({ expiresAt: BEFORE_NOW });
    expect(await before.repos.leases.renew(before.lease.id, RENEWED, NOW)).toBe(0);
    // expires_at == now is expired (a lease is valid until, not at, expiry).
    const boundary = await claimed({ expiresAt: NOW });
    expect(await boundary.repos.leases.renew(boundary.lease.id, RENEWED, NOW)).toBe(0);
    // One second of life remains: renewable.
    const live = await claimed({ expiresAt: AFTER_NOW });
    expect(await live.repos.leases.renew(live.lease.id, RENEWED, NOW)).toBe(1);
  });

  it("rejects renewing a released, revoked, or unknown lease: 0 rows", async () => {
    const released = await claimed();
    await released.repos.leases.release(released.lease.id, NOW);
    expect(await released.repos.leases.renew(released.lease.id, RENEWED, NOW)).toBe(0);

    const revoked = await claimed({ expiresAt: BEFORE_NOW });
    await revoked.repos.leases.expire(revoked.lease.id, NOW);
    expect(await revoked.repos.leases.renew(revoked.lease.id, RENEWED, NOW)).toBe(0);

    expect(await released.repos.leases.renew(uuidv7(), RENEWED, NOW)).toBe(0);
  });
});

describe("lease release and expire — conditional UPDATEs (contract §2)", () => {
  it("release ends an active lease once: 1 then 0", async () => {
    const s = await seedWithWorkItem();
    const lease = makeLease(s, s.workItem.id);
    await s.repos.leases.claim(lease);
    expect(await s.repos.leases.release(lease.id, LATER)).toBe(1);
    expect((await s.repos.leases.getById(lease.id))?.releasedAt).toBe(LATER);
    expect(await s.repos.leases.release(lease.id, LATER)).toBe(0);
    expect(await s.repos.leases.getActiveByWorkItem(s.workItem.id)).toBeNull();
  });

  it("release works on an expired-but-unswept lease (holder tidying up)", async () => {
    const s = await seedWithWorkItem();
    const lease = makeLease(s, s.workItem.id, { expiresAt: BEFORE_NOW });
    await s.repos.leases.claim(lease);
    expect(await s.repos.leases.release(lease.id, NOW)).toBe(1);
  });

  it("expire only ends a lease that is actually expired at `now`", async () => {
    const s = await seedWithWorkItem();
    const live = makeLease(s, s.workItem.id, { expiresAt: AFTER_NOW });
    await s.repos.leases.claim(live);
    expect(await s.repos.leases.expire(live.id, NOW)).toBe(0); // still live
    expect(await s.repos.leases.expire(live.id, AFTER_NOW)).toBe(1); // boundary: expired
    expect((await s.repos.leases.getById(live.id))?.revokedAt).toBe(AFTER_NOW);
    expect(await s.repos.leases.expire(live.id, AFTER_NOW)).toBe(0); // already ended
  });

  it("expire never touches a released lease (no revoked_at overwrite)", async () => {
    const s = await seedWithWorkItem();
    const lease = makeLease(s, s.workItem.id, { expiresAt: BEFORE_NOW });
    await s.repos.leases.claim(lease);
    await s.repos.leases.release(lease.id, NOW);
    expect(await s.repos.leases.expire(lease.id, NOW)).toBe(0);
    expect((await s.repos.leases.getById(lease.id))?.revokedAt).toBeNull();
  });

  it("expireForWorkItem frees only an expired holder", async () => {
    const s = await seedWithWorkItem();
    const live = makeLease(s, s.workItem.id, { expiresAt: AFTER_NOW });
    await s.repos.leases.claim(live);
    expect(await s.repos.leases.expireForWorkItem(s.workItem.id, NOW)).toBe(0);
    expect(await s.repos.leases.expireForWorkItem(s.workItem.id, AFTER_NOW)).toBe(1);
    expect(await s.repos.leases.getActiveByWorkItem(s.workItem.id)).toBeNull();
  });
});

describe("sweep query — correctness across the expiry boundary (contract §2)", () => {
  it("lists exactly the active leases with expires_at <= now, oldest first", async () => {
    const s = await seedBasics();
    const items = [0, 1, 2, 3, 4].map(() => makeWorkItem(s));
    for (const item of items) await s.repos.workItems.insert(item);

    const expiredEarly = makeLease(s, items[0]!.id, { expiresAt: BEFORE_NOW });
    const expiredAtBoundary = makeLease(s, items[1]!.id, { expiresAt: NOW });
    const stillLive = makeLease(s, items[2]!.id, { expiresAt: AFTER_NOW });
    const alreadyReleased = makeLease(s, items[3]!.id, { expiresAt: BEFORE_NOW });
    const alreadyRevoked = makeLease(s, items[4]!.id, { expiresAt: BEFORE_NOW });
    for (const lease of [expiredEarly, expiredAtBoundary, stillLive, alreadyReleased, alreadyRevoked]) {
      await s.repos.leases.claim(lease);
    }
    await s.repos.leases.release(alreadyReleased.id, NOW);
    await s.repos.leases.expire(alreadyRevoked.id, NOW);

    const due = await s.repos.leases.listExpired(NOW);
    expect(due.map((l) => l.id)).toEqual([expiredEarly.id, expiredAtBoundary.id]);
  });

  it("sweeping expires each due lease exactly once and frees the slots", async () => {
    const s = await seedWithWorkItem();
    const stale = makeLease(s, s.workItem.id, { expiresAt: NOW });
    await s.repos.leases.claim(stale);

    const due = await s.repos.leases.listExpired(NOW);
    expect(due).toHaveLength(1);
    // The conditional UPDATE makes sweep + lazy expiry race-safe: only one
    // path observes 1 row, so `lease_expired` is emitted once.
    expect(await s.repos.leases.expire(stale.id, NOW)).toBe(1);
    expect(await s.repos.leases.expire(stale.id, NOW)).toBe(0);

    expect(await s.repos.leases.listExpired(NOW)).toEqual([]);
    expect((await s.repos.leases.claim(makeLease(s, s.workItem.id))).status).toBe("claimed");
  });

  it("advancing the clock moves leases across the boundary", async () => {
    const s = await seedWithWorkItem();
    const lease = makeLease(s, s.workItem.id, { expiresAt: AFTER_NOW });
    await s.repos.leases.claim(lease);
    expect(await s.repos.leases.listExpired(NOW)).toEqual([]);
    expect((await s.repos.leases.listExpired(AFTER_NOW)).map((l) => l.id)).toEqual([lease.id]);
  });
});

describe("submissions — lifecycle (contract §4)", () => {
  async function seedWithSubmission() {
    const s = await seedWithWorkItem();
    const lease = makeLease(s, s.workItem.id);
    await s.repos.leases.claim(lease);
    const submission = makeSubmission(s, s.workItem.id, lease.id, {
      summary: "Tightened the opening sentence.",
      notes: "Read aloud twice.",
    });
    await s.repos.submissions.insert(submission);
    return { ...s, lease, submission };
  }

  it("round-trips a submission record", async () => {
    const s = await seedWithSubmission();
    expect(await s.repos.submissions.getById(s.submission.id)).toEqual(s.submission);
  });

  it("rejects invalid type and state values in-schema", async () => {
    const s = await seedWithSubmission();
    for (const bad of [
      { type: "prose_rewrite" as SubmissionRecord["type"] },
      { state: "pending" as SubmissionRecord["state"] },
    ]) {
      let caught: unknown;
      try {
        await s.repos.submissions.insert(
          makeSubmission(s, s.workItem.id, s.lease.id, bad),
        );
      } catch (error) {
        caught = error;
      }
      expect(isConstraintError(caught)).toBe(true);
    }
  });

  it("guarded transitions follow received → applying → applied", async () => {
    const s = await seedWithSubmission();
    const { submissions } = s.repos;
    // Wrong from-state: no-op.
    expect(await submissions.transitionState(s.submission.id, "applying", "applied", LATER)).toBe(0);
    expect(await submissions.transitionState(s.submission.id, "received", "applying", LATER)).toBe(1);
    // Double-apply race: exactly one transition wins.
    expect(await submissions.transitionState(s.submission.id, "applying", "applied", LATER)).toBe(1);
    expect(await submissions.transitionState(s.submission.id, "applying", "applied", LATER)).toBe(0);
    const after = await submissions.getById(s.submission.id);
    expect(after?.state).toBe("applied");
    expect(after?.updatedAt).toBe(LATER);
  });

  it("supports the conflicted and rejected outcomes", async () => {
    const s = await seedWithSubmission();
    await s.repos.submissions.transitionState(s.submission.id, "received", "applying", LATER);
    expect(
      await s.repos.submissions.transitionState(s.submission.id, "applying", "conflicted", LATER),
    ).toBe(1);

    const rejected = makeSubmission(s, s.workItem.id, s.lease.id);
    await s.repos.submissions.insert(rejected);
    expect(
      await s.repos.submissions.transitionState(rejected.id, "received", "rejected", LATER),
    ).toBe(1);
  });

  it("links the git operation driving the apply", async () => {
    const s = await seedWithSubmission();
    const operation: GitOperationRecord = {
      id: uuidv7(),
      projectId: s.project.id,
      correlationId: uuidv7(),
      expectedHead: null,
      state: "queued",
      attempts: 0,
      commitSha: null,
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    await s.repos.gitOperations.insert(operation);
    expect(await s.repos.submissions.setGitOperation(s.submission.id, operation.id, LATER)).toBe(true);
    expect((await s.repos.submissions.getById(s.submission.id))?.gitOperationId).toBe(operation.id);
    expect(await s.repos.submissions.setGitOperation(uuidv7(), operation.id, LATER)).toBe(false);
  });

  it("lists by work item (cursor) and by project+state", async () => {
    const s = await seedWithSubmission();
    const more = [makeSubmission(s, s.workItem.id, s.lease.id), makeSubmission(s, s.workItem.id, s.lease.id)];
    for (const record of more) await s.repos.submissions.insert(record);

    const all = await s.repos.submissions.listByWorkItem(s.workItem.id);
    expect(all.map((r) => r.id)).toEqual([...all.map((r) => r.id)].sort());
    expect(all).toHaveLength(3);
    const afterFirst = await s.repos.submissions.listByWorkItem(s.workItem.id, {
      afterId: all[0]!.id,
    });
    expect(afterFirst).toHaveLength(2);

    await s.repos.submissions.transitionState(more[0]!.id, "received", "applying", LATER);
    const received = await s.repos.submissions.listByProjectState(s.project.id, "received");
    expect(received.map((r) => r.id)).not.toContain(more[0]!.id);
    expect(received).toHaveLength(2);
  });
});
