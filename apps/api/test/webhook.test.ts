import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hmacSha256Hex } from "../src/crypto.js";
import {
  devLogin,
  makeHarness,
  WEBHOOK_SECRET,
  type TestHarness,
} from "./helpers.js";

describe("POST /v1/webhooks/github", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  async function deliver(options: {
    body?: string;
    signature?: string | null;
    deliveryId?: string | null;
    event?: string;
  } = {}): Promise<Response> {
    const body = options.body ?? JSON.stringify({ ref: "refs/heads/main" });
    const signature =
      options.signature === undefined
        ? `sha256=${await hmacSha256Hex(WEBHOOK_SECRET, body)}`
        : options.signature;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (signature !== null) {
      headers["X-Hub-Signature-256"] = signature;
    }
    const deliveryId = options.deliveryId === undefined ? "delivery-1" : options.deliveryId;
    if (deliveryId !== null) {
      headers["X-GitHub-Delivery"] = deliveryId;
    }
    headers["X-GitHub-Event"] = options.event ?? "push";
    return h.app.request("/v1/webhooks/github", { method: "POST", headers, body });
  }

  it("401 on missing or invalid signature", async () => {
    const missing = await deliver({ signature: null });
    expect(missing.status).toBe(401);
    const invalid = await deliver({ signature: `sha256=${"0".repeat(64)}` });
    expect(invalid.status).toBe(401);
  });

  it("400 on missing delivery id", async () => {
    const res = await deliver({ deliveryId: null });
    expect(res.status).toBe(400);
  });

  it("valid push triggers a projection rebuild", async () => {
    // change the projected revision in the fake repo, then push
    const chapter = h.reader.snapshot.chapters[0];
    if (chapter === undefined) {
      throw new Error("fixture chapter missing");
    }
    chapter.frontmatter.revision = 4;

    const res = await deliver({ deliveryId: "delivery-rebuild" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rebuilt: boolean };
    expect(body.rebuilt).toBe(true);

    const projected = await h.repos.chapters.getById(chapter.frontmatter.id);
    expect(projected?.revision).toBe(4);

    const delivery = await h.repos.webhookDeliveries.getByDeliveryId("delivery-rebuild");
    expect(delivery?.status).toBe("processed");
  });

  it("ignores duplicate delivery ids", async () => {
    const first = await deliver({ deliveryId: "dup-1" });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { duplicate: boolean }).duplicate).toBe(false);

    const second = await deliver({ deliveryId: "dup-1" });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { duplicate: boolean; rebuilt: boolean };
    expect(body.duplicate).toBe(true);
    expect(body.rebuilt).toBe(false);
  });

  it("redelivery of a FAILED delivery re-runs the rebuild instead of deduping", async () => {
    // Regression: a delivery whose rebuild failed used to be permanently
    // swallowed as {duplicate: true} on redelivery, leaving the projection
    // stale until an unrelated future push.
    const brokenReader = h.reader.readSnapshot.bind(h.reader);
    h.reader.readSnapshot = async () => {
      throw new Error("malformed chapter frontmatter");
    };
    const first = await deliver({ deliveryId: "retry-1" });
    expect(first.status).toBe(500);
    expect((await h.repos.webhookDeliveries.getByDeliveryId("retry-1"))?.status).toBe("failed");

    // The repo problem is fixed; GitHub redelivers the SAME delivery id.
    h.reader.readSnapshot = brokenReader;
    const chapter = h.reader.snapshot.chapters[0];
    if (chapter === undefined) {
      throw new Error("fixture chapter missing");
    }
    chapter.frontmatter.revision = 9;

    const second = await deliver({ deliveryId: "retry-1" });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { duplicate: boolean; rebuilt: boolean };
    expect(body.duplicate).toBe(false);
    expect(body.rebuilt).toBe(true);
    expect((await h.repos.webhookDeliveries.getByDeliveryId("retry-1"))?.status).toBe(
      "processed",
    );
    expect((await h.repos.chapters.getById(chapter.frontmatter.id))?.revision).toBe(9);

    // A third delivery of the now-processed id is a true duplicate again.
    const third = await deliver({ deliveryId: "retry-1" });
    expect(((await third.json()) as { duplicate: boolean }).duplicate).toBe(true);
  });

  it("non-push events are recorded and ignored", async () => {
    const res = await deliver({ deliveryId: "ping-1", event: "ping" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rebuilt: boolean }).rebuilt).toBe(false);
    const delivery = await h.repos.webhookDeliveries.getByDeliveryId("ping-1");
    expect(delivery?.status).toBe("ignored");
  });

  it("push without a configured reader is recorded and ignored", async () => {
    const noReader = await makeHarness({ reader: null });
    try {
      const body = JSON.stringify({ ref: "refs/heads/main" });
      const res = await noReader.app.request("/v1/webhooks/github", {
        method: "POST",
        headers: {
          "X-Hub-Signature-256": `sha256=${await hmacSha256Hex(WEBHOOK_SECRET, body)}`,
          "X-GitHub-Delivery": "no-reader-1",
          "X-GitHub-Event": "push",
        },
        body,
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { rebuilt: boolean }).rebuilt).toBe(false);
    } finally {
      noReader.close();
    }
  });

  it("rebuild survives across requests: new revision is served immediately", async () => {
    const cookie = await devLogin(h, "watcher", "reader");
    const chapter = h.reader.snapshot.chapters[0];
    if (chapter === undefined) {
      throw new Error("fixture chapter missing");
    }
    chapter.frontmatter.revision = 5;
    chapter.blockIds = [...chapter.blockIds, "01900000-0000-7000-8000-000000000103"];
    await deliver({ deliveryId: "delivery-serve" });

    const res = await h.app.request(
      `/v1/projects/${h.projectId}/chapters/${chapter.frontmatter.id}`,
      { headers: { Cookie: cookie } },
    );
    const body = (await res.json()) as { revision: number; blockIds: string[] };
    expect(body.revision).toBe(5);
    expect(body.blockIds).toContain("01900000-0000-7000-8000-000000000103");
  });
});
