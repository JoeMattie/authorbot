/**
 * Whole-chapter claim snapshots contain complete manuscript source. They are
 * useful only while the exact lease remains active and must disappear in the
 * same transaction that releases, expires, replaces, or revokes that lease.
 */
import { describe, expect, it } from "vitest";
import type { SqlRunResult, SqlStatement } from "@authorbot/database";
import { sweepExpiredLeases } from "../src/index.js";
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
}

function leaseOf(bundle: Record<string, unknown>): LeaseBundle {
  return bundle["lease"] as LeaseBundle;
}

/** Simulate a second Worker committing immediately before this one's batch. */
function interleaveBeforeNextBatch(
  harness: Phase4Harness,
  rival: () => Promise<void>,
): void {
  const db = harness.db as unknown as {
    batch(statements: SqlStatement[]): Promise<SqlRunResult[]>;
  };
  const original = db.batch.bind(harness.db);
  db.batch = async (statements: SqlStatement[]): Promise<SqlRunResult[]> => {
    db.batch = original;
    await rival();
    return original(statements);
  };
}

describe("whole-chapter lease document snapshot lifecycle", () => {
  it("deletes retained manuscript source in the voluntary release batch", async () => {
    const harness = await makePhase4Harness();
    try {
      const cookie = await devLogin(harness, "chapter-editor", "editor");
      const { workItemId } = await createReadyWorkItem(harness, {
        type: "revise_chapter",
      });
      const claimed = await claimWorkItem(harness, { cookie }, workItemId);
      expect(claimed.status).toBe(201);
      const lease = leaseOf(claimed.body);
      expect(await harness.repos.leaseDocumentSnapshots.getByLeaseId(lease.id)).not.toBeNull();

      const released = await harness.app.request(
        `/v1/projects/${harness.projectId}/work-items/${workItemId}/lease/release`,
        jsonRequest("POST", { leaseId: lease.id }, { Cookie: cookie }),
      );

      expect(released.status).toBe(200);
      expect(await harness.repos.leaseDocumentSnapshots.getByLeaseId(lease.id)).toBeNull();
      expect((await harness.repos.leases.getById(lease.id))?.releasedAt).not.toBeNull();
    } finally {
      harness.close();
    }
  });

  it("deletes retained manuscript source during lazy expiry", async () => {
    const harness = await makePhase4Harness();
    try {
      const cookie = await devLogin(harness, "chapter-editor", "editor");
      const { workItemId } = await createReadyWorkItem(harness, {
        type: "revise_chapter",
      });
      const claimed = await claimWorkItem(harness, { cookie }, workItemId);
      const lease = leaseOf(claimed.body);
      expect(await harness.repos.leaseDocumentSnapshots.getByLeaseId(lease.id)).not.toBeNull();
      harness.clock.advanceMs(30 * MINUTE);

      const renewal = await harness.app.request(
        `/v1/projects/${harness.projectId}/work-items/${workItemId}/lease/renew`,
        jsonRequest(
          "POST",
          { leaseId: lease.id, leaseToken: lease.token },
          { Cookie: cookie },
        ),
      );

      expect(renewal.status).toBe(409);
      expect(await harness.repos.leaseDocumentSnapshots.getByLeaseId(lease.id)).toBeNull();
      expect((await harness.repos.leases.getById(lease.id))?.revokedAt).not.toBeNull();
      expect((await harness.repos.workItems.getById(workItemId))?.status).toBe("ready");
    } finally {
      harness.close();
    }
  });

  it("deletes the expired base while atomically replacing it with a fresh claim", async () => {
    const harness = await makePhase4Harness();
    try {
      const first = await devLogin(harness, "first-editor", "editor");
      const second = await devLogin(harness, "second-editor", "editor");
      const { workItemId } = await createReadyWorkItem(harness, {
        type: "revise_chapter",
      });
      const originalClaim = await claimWorkItem(harness, { cookie: first }, workItemId);
      const original = leaseOf(originalClaim.body);
      expect(await harness.repos.leaseDocumentSnapshots.getByLeaseId(original.id)).not.toBeNull();
      harness.clock.advanceMs(31 * MINUTE);

      const replacementClaim = await claimWorkItem(harness, { cookie: second }, workItemId);
      expect(replacementClaim.status).toBe(201);
      const replacement = leaseOf(replacementClaim.body);

      expect(replacement.id).not.toBe(original.id);
      expect(await harness.repos.leaseDocumentSnapshots.getByLeaseId(original.id)).toBeNull();
      expect(await harness.repos.leaseDocumentSnapshots.getByLeaseId(replacement.id)).not.toBeNull();
      expect((await harness.repos.leases.getById(original.id))?.revokedAt).not.toBeNull();
      expect((await harness.repos.leases.getActiveByWorkItem(workItemId))?.id).toBe(replacement.id);
    } finally {
      harness.close();
    }
  });

  it("deletes retained manuscript source when the holder loses project access", async () => {
    const harness = await makePhase4Harness();
    try {
      const editorCookie = await devLogin(harness, "departing-editor", "editor");
      const maintainerCookie = await devLogin(harness, "maintainer", "maintainer");
      const editor = await harness.repos.actors.getByExternalIdentity("github:departing-editor");
      expect(editor).not.toBeNull();
      const { workItemId } = await createReadyWorkItem(harness, {
        type: "revise_chapter",
      });
      const claimed = await claimWorkItem(harness, { cookie: editorCookie }, workItemId);
      const lease = leaseOf(claimed.body);
      expect(await harness.repos.leaseDocumentSnapshots.getByLeaseId(lease.id)).not.toBeNull();

      const removed = await harness.app.request(
        `/v1/projects/${harness.projectId}/collaborators/${editor?.id ?? "missing"}`,
        jsonRequest(
          "DELETE",
          { reason: "access removed" },
          { Cookie: maintainerCookie, "Idempotency-Key": uuidv7() },
        ),
      );

      expect(removed.status).toBe(200);
      expect(await harness.repos.leaseDocumentSnapshots.getByLeaseId(lease.id)).toBeNull();
      expect((await harness.repos.leases.getById(lease.id))?.revokedAt).not.toBeNull();
      expect((await harness.repos.workItems.getById(workItemId))?.status).toBe("ready");
    } finally {
      harness.close();
    }
  });

  it("preserves the base when a stale expiry loses to a live renewal", async () => {
    const harness = await makePhase4Harness();
    try {
      const cookie = await devLogin(harness, "renewing-editor", "editor");
      const { workItemId } = await createReadyWorkItem(harness, {
        type: "revise_chapter",
      });
      const claimed = await claimWorkItem(harness, { cookie }, workItemId);
      const lease = leaseOf(claimed.body);
      const before = await harness.repos.leaseDocumentSnapshots.getByLeaseId(lease.id);
      expect(before).not.toBeNull();

      // The sweep selects the old 18:30 expiry at 18:31. A renewal that began
      // at 18:29 commits before its batch and extends the same lease to 19:00.
      // The expiry must lose without deleting the renewed holder's base.
      harness.clock.advanceMs(31 * MINUTE);
      interleaveBeforeNextBatch(harness, async () => {
        expect(
          await harness.repos.leases.renew(
            lease.id,
            "2026-07-19T19:00:00Z",
            "2026-07-19T18:29:00Z",
          ),
        ).toBe(1);
      });

      expect((await sweepExpiredLeases(harness.db, harness.clock)).expired).toBe(0);
      expect(await harness.repos.leaseDocumentSnapshots.getByLeaseId(lease.id)).toEqual(before);
      const active = await harness.repos.leases.getActiveByWorkItem(workItemId);
      expect(active?.id).toBe(lease.id);
      expect(active?.expiresAt).toBe("2026-07-19T19:00:00Z");
      expect(active?.renewalCount).toBe(1);
      expect((await harness.repos.workItems.getById(workItemId))?.status).toBe("leased");
    } finally {
      harness.close();
    }
  });
});
