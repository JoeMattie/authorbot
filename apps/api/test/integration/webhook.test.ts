/**
 * Webhook trio (contract §7.4) against the real repository: bad signature
 * 401, duplicate delivery ignored, valid push triggers a projection rebuild
 * that picks up commits made to the work tree.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hmacSha256Hex } from "../../src/crypto.js";
import {
  CHAPTER_3,
  WEBHOOK_SECRET,
  cloneExampleBookRepo,
  devLogin,
  git,
  makeIntegrationApp,
  type BookRepoClone,
  type IntegrationApp,
} from "./helpers.js";

describe("GitHub webhook (integration)", () => {
  let clone: BookRepoClone;
  let app: IntegrationApp;
  let cookie: string;

  beforeAll(async () => {
    clone = await cloneExampleBookRepo();
    app = await makeIntegrationApp({ workTreePath: clone.workTreePath });
    cookie = await devLogin(app, "reba", "reader");
  });

  afterAll(async () => {
    app.close();
    await clone.cleanup();
  });

  const deliver = async (options: {
    deliveryId: string;
    event?: string;
    signature?: string;
  }): Promise<Response> => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const signature =
      options.signature ?? `sha256=${await hmacSha256Hex(WEBHOOK_SECRET, body)}`;
    return app.app.request("/v1/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": options.event ?? "push",
        "X-GitHub-Delivery": options.deliveryId,
        "X-Hub-Signature-256": signature,
      },
      body,
    });
  };

  it("rejects a bad signature with 401", async () => {
    const response = await deliver({
      deliveryId: "delivery-bad-sig",
      signature: `sha256=${"0".repeat(64)}`,
    });
    expect(response.status).toBe(401);
  });

  it("a valid push rebuilds the projection from the current work tree", async () => {
    // Commit a revision bump to chapter 003 directly in the work tree.
    const chapterPath = join(clone.workTreePath, "chapters", "003-the-window.md");
    const source = await readFile(chapterPath, "utf8");
    await writeFile(chapterPath, source.replace("revision: 1", "revision: 2"), "utf8");
    await git(clone.workTreePath, "add", "chapters/003-the-window.md");
    await git(clone.workTreePath, "commit", "--quiet", "--no-verify", "-m", "chapter 003 rev 2");

    const response = await deliver({ deliveryId: "delivery-push-1" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      duplicate: boolean;
      rebuilt: boolean;
      counts: { chapters: number };
    };
    expect(body.duplicate).toBe(false);
    expect(body.rebuilt).toBe(true);
    expect(body.counts.chapters).toBe(3);

    const chapter = (await (
      await app.app.request(`/v1/projects/${app.projectId}/chapters/${CHAPTER_3.id}`, {
        headers: { Cookie: cookie },
      })
    ).json()) as { revision: number };
    expect(chapter.revision).toBe(2);
  });

  it("ignores a duplicate delivery id", async () => {
    const first = await deliver({ deliveryId: "delivery-dupe" });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { duplicate: boolean }).duplicate).toBe(false);

    const second = await deliver({ deliveryId: "delivery-dupe" });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { duplicate: boolean; rebuilt: boolean };
    expect(body.duplicate).toBe(true);
    expect(body.rebuilt).toBe(false);
  });

  it("records non-push events without rebuilding", async () => {
    const response = await deliver({ deliveryId: "delivery-ping", event: "ping" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { duplicate: boolean; rebuilt: boolean };
    expect(body.rebuilt).toBe(false);
  });
});
