/**
 * Phase 5 contract §6 + §7, design §17.3: the signed CI publication callback
 * and the integrated-versus-deployed view.
 *
 * The property under test is not "we can store a row" - it is that the API
 * never *invents* publication state. Several tests below deliberately commit
 * and project work, then assert that nothing about deployment changed, because
 * the whole point of §17.3 is that a successful Git commit is not a deployment.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hmacSha256Hex } from "../src/crypto.js";
import { uuidv7 } from "../src/ids.js";
import {
  PUBLICATION_DELIVERY_HEADER,
  PUBLICATION_SIGNATURE_HEADER,
  PUBLICATION_TIMESTAMP_HEADER,
  publicationSigningMaterial,
} from "../src/publications.js";
import { devLogin, makeHarness, WEBHOOK_SECRET, type TestHarness } from "./helpers.js";

const COMMIT_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const COMMIT_B = "b1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

interface CallbackOptions {
  body?: unknown;
  raw?: string;
  signature?: string | null;
  deliveryId?: string | null;
  timestamp?: string | null;
}

async function callback(h: TestHarness, options: CallbackOptions = {}): Promise<Response> {
  const raw =
    options.raw ??
    JSON.stringify(
      options.body ?? { integratedCommit: COMMIT_A, buildStatus: "succeeded" },
    );
  const deliveryId = options.deliveryId === undefined ? uuidv7() : options.deliveryId;
  const timestamp =
    options.timestamp === undefined ? new Date().toISOString() : options.timestamp;
  // The MAC covers delivery id + timestamp + body, so the delivery id cannot
  // be swapped on a captured request (contract §6 replay suppression).
  const signature =
    options.signature === undefined
      ? `sha256=${await hmacSha256Hex(
          WEBHOOK_SECRET,
          publicationSigningMaterial(deliveryId ?? "", timestamp ?? "", raw),
        )}`
      : options.signature;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signature !== null) {
    headers[PUBLICATION_SIGNATURE_HEADER] = signature;
  }
  if (deliveryId !== null) {
    headers[PUBLICATION_DELIVERY_HEADER] = deliveryId;
  }
  if (timestamp !== null) {
    headers[PUBLICATION_TIMESTAMP_HEADER] = timestamp;
  }
  return h.app.request("/v1/publications", { method: "POST", headers, body: raw });
}

describe("POST /v1/publications (contract §6)", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  it("accepts a correctly signed callback and stores the reported state", async () => {
    const response = await callback(h, {
      body: {
        integratedCommit: COMMIT_A,
        buildStatus: "succeeded",
        deployedCommit: COMMIT_A,
        publicUrl: "https://causal-projector.joemattie.com",
        deployedAt: "2026-07-19T10:00:00Z",
        publisherVersion: "publisher/1.4.2",
      },
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      applied: boolean;
      duplicate: boolean;
      publicationId: string;
    };
    expect(body).toMatchObject({ applied: true, duplicate: false });

    const stored = await h.repos.publications.getById(body.publicationId);
    expect(stored).toMatchObject({
      integratedCommit: COMMIT_A,
      buildStatus: "succeeded",
      deployedCommit: COMMIT_A,
      publicUrl: "https://causal-projector.joemattie.com",
      deployedAt: "2026-07-19T10:00:00Z",
      publisherVersion: "publisher/1.4.2",
    });
  });

  it("rejects a bad signature without touching the database", async () => {
    const bad = await callback(h, { signature: `sha256=${"0".repeat(64)}` });
    expect(bad.status).toBe(401);
    const missing = await callback(h, { signature: null });
    expect(missing.status).toBe(401);

    expect(await h.repos.publications.getLatest(h.projectId)).toBeNull();
    const deliveries = await h.db.prepare(`SELECT * FROM publication_deliveries`).all();
    expect(deliveries).toHaveLength(0);
  });

  /**
   * Regression: the HMAC used to cover the raw body ALONE. The delivery id -
   * the sole replay-suppression key - travelled in an unsigned header, and
   * nothing bound the request to a point in time. Anyone holding one validly
   * signed (body, signature) pair could resubmit it forever under fresh
   * delivery ids: the UNIQUE index never fires, and every replay reaches the
   * upsert, flipping the reported buildStatus and re-emitting
   * `publication.reported` audit rows. `POST /v1/publications` is by design
   * the only writer of publication state (design §17.3), so the signature has
   * to cover everything the handler acts on.
   */
  it("refuses a captured request replayed under a fresh delivery id", async () => {
    const raw = JSON.stringify({ integratedCommit: COMMIT_A, buildStatus: "succeeded" });
    const deliveryId = uuidv7();
    const timestamp = new Date().toISOString();
    const signature = `sha256=${await hmacSha256Hex(
      WEBHOOK_SECRET,
      publicationSigningMaterial(deliveryId, timestamp, raw),
    )}`;

    const accepted = await callback(h, { raw, deliveryId, timestamp, signature });
    expect(accepted.status).toBe(201);

    // The attacker's move: same bytes, same signature, a delivery id nobody
    // has used, so the dedupe ledger cannot help.
    const replayed = await callback(h, {
      raw,
      deliveryId: uuidv7(),
      timestamp,
      signature,
    });
    expect(replayed.status).toBe(401);

    const deliveries = await h.db.prepare(`SELECT * FROM publication_deliveries`).all();
    expect(deliveries).toHaveLength(1);
  });

  it("refuses a correctly signed callback whose timestamp has aged out", async () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const response = await callback(h, { timestamp: stale });
    expect(response.status).toBe(401);
    expect(await h.repos.publications.getLatest(h.projectId)).toBeNull();
  });

  it("refuses a callback with no timestamp at all", async () => {
    const response = await callback(h, { timestamp: null });
    expect(response.status).toBe(400);
  });

  it("rejects a signature computed over a DIFFERENT body", async () => {
    // The classic mistake: signing a canonicalized or re-serialized payload.
    // The HMAC must cover the exact bytes received.
    const signed = JSON.stringify({ integratedCommit: COMMIT_A, buildStatus: "succeeded" });
    const sent = JSON.stringify({ integratedCommit: COMMIT_B, buildStatus: "succeeded" });
    const response = await callback(h, {
      raw: sent,
      signature: `sha256=${await hmacSha256Hex(WEBHOOK_SECRET, signed)}`,
    });
    expect(response.status).toBe(401);
  });

  it("suppresses a replayed delivery id", async () => {
    const deliveryId = "ci-delivery-1";
    const first = await callback(h, {
      body: { integratedCommit: COMMIT_A, buildStatus: "queued" },
      deliveryId,
    });
    expect(first.status).toBe(201);

    // Same delivery id, DIFFERENT content: a replay must not advance state,
    // even one that would otherwise look like legitimate progress.
    const replay = await callback(h, {
      body: { integratedCommit: COMMIT_A, buildStatus: "succeeded", deployedCommit: COMMIT_A },
      deliveryId,
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()) as { duplicate: boolean }).toMatchObject({
      duplicate: true,
      applied: false,
    });

    const stored = await h.repos.publications.getByCommit(h.projectId, COMMIT_A);
    expect(stored?.buildStatus).toBe("queued");
    expect(stored?.deployedCommit).toBeNull();
  });

  it("advances one row through the build lifecycle without losing deploy fields", async () => {
    await callback(h, { body: { integratedCommit: COMMIT_A, buildStatus: "queued" } });
    await callback(h, { body: { integratedCommit: COMMIT_A, buildStatus: "building" } });
    await callback(h, {
      body: {
        integratedCommit: COMMIT_A,
        buildStatus: "succeeded",
        deployedCommit: COMMIT_A,
        publicUrl: "https://example.test/book",
        deployedAt: "2026-07-19T11:00:00Z",
      },
    });
    // A later callback that says nothing about deployment must NOT erase it.
    await callback(h, { body: { integratedCommit: COMMIT_A, buildStatus: "succeeded" } });

    const rows = await h.repos.publications.listByProject(h.projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      buildStatus: "succeeded",
      deployedCommit: COMMIT_A,
      publicUrl: "https://example.test/book",
      deployedAt: "2026-07-19T11:00:00Z",
    });
  });

  it("400s on a missing delivery id", async () => {
    const response = await callback(h, { deliveryId: null });
    expect(response.status).toBe(400);
  });

  it("422-style validation rejects unknown build statuses and non-http URLs", async () => {
    const badStatus = await callback(h, {
      body: { integratedCommit: COMMIT_A, buildStatus: "vibes" },
    });
    expect(badStatus.status).toBe(400);

    const badUrl = await callback(h, {
      body: {
        integratedCommit: COMMIT_A,
        buildStatus: "succeeded",
        publicUrl: "javascript:alert(1)",
      },
    });
    expect(badUrl.status).toBe(400);
  });

  it("rejects a callback naming a different project", async () => {
    const response = await callback(h, {
      body: {
        projectSlug: "some-other-book",
        integratedCommit: COMMIT_A,
        buildStatus: "succeeded",
      },
    });
    expect(response.status).toBe(404);
  });

  it("audits the report and appends an event", async () => {
    await callback(h);
    const audit = await h.db
      .prepare(`SELECT * FROM audit_events WHERE action = 'publication.reported'`)
      .all();
    expect(audit).toHaveLength(1);
    const events = await h.db
      .prepare(`SELECT * FROM events WHERE type = 'publication_updated'`)
      .all();
    expect(events).toHaveLength(1);
  });
});

describe("integrated versus deployed (design §17.3)", () => {
  let h: TestHarness;
  let cookie: string;

  beforeEach(async () => {
    h = await makeHarness();
    cookie = await devLogin(h, "operator", "maintainer");
  });
  afterEach(() => h.close());

  async function projectView(): Promise<{
    publication: {
      integratedCommit: string | null;
      deployedCommit: string | null;
      buildStatus: string | null;
      inSync: boolean;
      publicUrl: string | null;
    };
    projection: { commit: string | null; stale: boolean };
  }> {
    const response = await h.app.request(`/v1/projects/${h.projectId}`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    return (await response.json()) as never;
  }

  it("a successful integration alone never reads as deployed", async () => {
    // Authorbot integrated COMMIT_A. CI has said nothing.
    h.reader.snapshot.headCommit = COMMIT_A;
    await h.api.rebuild();

    const view = await projectView();
    expect(view.publication.integratedCommit).toBe(COMMIT_A);
    expect(view.publication.deployedCommit).toBeNull();
    expect(view.publication.inSync).toBe(false);
  });

  it("surfaces the gap when the deployed commit is behind the integrated one", async () => {
    // CI deployed the older commit…
    await callback(h, {
      body: {
        integratedCommit: COMMIT_A,
        buildStatus: "succeeded",
        deployedCommit: COMMIT_A,
        publicUrl: "https://example.test/book",
        deployedAt: "2026-07-19T09:00:00Z",
      },
    });
    // …then Authorbot integrated a newer one.
    h.reader.snapshot.headCommit = COMMIT_B;
    await h.api.rebuild();

    const view = await projectView();
    expect(view.publication.integratedCommit).toBe(COMMIT_B);
    expect(view.publication.deployedCommit).toBe(COMMIT_A);
    expect(view.publication.inSync).toBe(false);
  });

  it("a newer build that is only BUILDING does not hide the live deployment", async () => {
    await callback(h, {
      body: {
        integratedCommit: COMMIT_A,
        buildStatus: "succeeded",
        deployedCommit: COMMIT_A,
        publicUrl: "https://example.test/book",
        deployedAt: "2026-07-19T09:00:00Z",
      },
    });
    await callback(h, { body: { integratedCommit: COMMIT_B, buildStatus: "building" } });

    const view = await projectView();
    // The public page is still serving A, and that is what we report.
    expect(view.publication.deployedCommit).toBe(COMMIT_A);
    expect(view.publication.publicUrl).toBe("https://example.test/book");
    // …while the newest build state is visible too.
    expect(view.publication.buildStatus).toBe("building");
  });

  it("reports inSync only when both commits are known and equal", async () => {
    h.reader.snapshot.headCommit = COMMIT_A;
    await h.api.rebuild();
    await callback(h, {
      body: {
        integratedCommit: COMMIT_A,
        buildStatus: "succeeded",
        deployedCommit: COMMIT_A,
        deployedAt: "2026-07-19T09:00:00Z",
      },
    });

    const view = await projectView();
    expect(view.publication.inSync).toBe(true);
    expect(view.projection.commit).toBe(COMMIT_A);
  });

  it("lists publication history to members", async () => {
    await callback(h, { body: { integratedCommit: COMMIT_A, buildStatus: "succeeded" } });
    await callback(h, { body: { integratedCommit: COMMIT_B, buildStatus: "failed" } });

    const response = await h.app.request(`/v1/projects/${h.projectId}/publications`, {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: { integratedCommit: string }[] };
    expect(body.items.map((i) => i.integratedCommit).sort()).toEqual([COMMIT_A, COMMIT_B].sort());
  });

  it("refuses publication history to anonymous callers", async () => {
    const response = await h.app.request(`/v1/projects/${h.projectId}/publications`);
    expect(response.status).toBe(401);
  });
});
