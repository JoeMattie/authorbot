/**
 * Phase 11 Slice 6: chapter-wide comments live below the manuscript, use the
 * shared optimistic annotation/reply store, and promote to revise_chapter.
 */
import { expect, test } from "@playwright/test";
import {
  chapterUrl,
  devLogin,
  gitLogContains,
  loginCookie,
  repoDir,
  waitForWorkItem,
} from "./helpers.js";

const THREAD = "E2E discussion: does the final beat land before the chapter closes?";
const ROOT_REPLY = "E2E discussion reply: the setup lands, but the pause could breathe.";
const CHILD_REPLY = "E2E nested reply: agreed, one more sentence should do it.";

test("chapter Discussion creates a nested thread and promotes it to chapter Work", async ({
  page,
}) => {
  await page.goto(chapterUrl("baseline"));
  await devLogin(page, "discussion-maintainer", "maintainer");

  const discussion = page.locator(".ab-discussion-boundary");
  await expect(discussion).toBeVisible();
  const chapterRevision = Number(
    await page.locator("authorbot-collab").getAttribute("data-chapter-revision"),
  );
  expect(await discussion.evaluate((node) => {
    const reading = document.querySelector(".chapter-reading-layout");
    return reading !== null && Boolean(
      reading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  })).toBe(true);

  // Hold the request at the browser boundary. The form must clear and close,
  // and the optimistic thread must render, before the server response exists.
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  let threadRequest: Record<string, unknown> | null = null;
  await page.route("**/v1/projects/*/chapters/*/annotations", async (route) => {
    if (route.request().method() === "POST") {
      threadRequest = route.request().postDataJSON() as Record<string, unknown>;
      if (threadRequest["scope"] === "chapter") await createGate;
    }
    await route.continue();
  });

  await discussion.getByRole("button", { name: "Start a discussion" }).click();
  const composer = discussion.locator(".ab-discussion-composer form");
  await composer.locator("textarea").fill(THREAD);
  await composer.getByRole("button", { name: "Post" }).click();
  await expect(composer).toHaveCount(0);
  const thread = discussion.locator(".ab-discussion-thread", { hasText: THREAD });
  await expect(thread).toBeVisible();
  expect(threadRequest).toEqual({
    kind: "comment",
    scope: "chapter",
    chapterRevision,
    body: THREAD,
  });
  await expect(page.locator(".ab-gutter", { hasText: THREAD })).toHaveCount(0);
  releaseCreate();
  await expect(thread.locator(".ab-status-open")).toBeVisible({ timeout: 30_000 });

  // The same immediate-close rule applies to replies. A second reply targets
  // the first, proving the existing nested reply tree is reused.
  let releaseReply!: () => void;
  const replyGate = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  let delayedReply = true;
  await page.route("**/v1/projects/*/annotations/*/replies", async (route) => {
    if (route.request().method() === "POST" && delayedReply) {
      delayedReply = false;
      await replyGate;
    }
    await route.continue();
  });
  await thread.getByRole("button", { name: "Reply", exact: true }).click();
  const rootForm = thread.locator(".ab-reply-form");
  await rootForm.locator("textarea").fill(ROOT_REPLY);
  await rootForm.getByRole("button", { name: "Post reply" }).click();
  await expect(rootForm).toHaveCount(0);
  await expect(thread.locator(".ab-reply", { hasText: ROOT_REPLY })).toBeVisible();
  releaseReply();

  const rootReply = thread.locator(".ab-reply", { hasText: ROOT_REPLY }).first();
  await expect(rootReply.locator(".ab-status-syncing")).toHaveCount(0, { timeout: 30_000 });
  await rootReply.getByRole("button", { name: "Reply", exact: true }).click();
  const childForm = thread.locator(".ab-reply-form");
  await childForm.locator("textarea").fill(CHILD_REPLY);
  await childForm.getByRole("button", { name: "Post reply" }).click();
  await expect(rootReply.locator(".ab-replies .ab-reply", { hasText: CHILD_REPLY })).toBeVisible();

  await expect(async () => {
    expect(await gitLogContains(repoDir(), THREAD)).toBe(true);
    expect(await gitLogContains(repoDir(), ROOT_REPLY)).toBe(true);
    expect(await gitLogContains(repoDir(), CHILD_REPLY)).toBe(true);
  }).toPass({ timeout: 30_000 });

  await page.reload();
  const persisted = page.locator(".ab-discussion-thread", { hasText: THREAD });
  await expect(persisted).toBeVisible();
  await expect(
    persisted.locator(".ab-reply", { hasText: ROOT_REPLY }).first()
      .locator(".ab-replies .ab-reply", { hasText: CHILD_REPLY }),
  ).toBeVisible();

  await persisted.locator("[data-override='promote']").click();
  await expect(persisted).toHaveClass(/ab-promoted/, { timeout: 30_000 });
  await expect(persisted.locator(".ab-accepted-badge")).toHaveText("Accepted");
  await expect(persisted.locator(".ab-replies, .ab-actions, .ab-override")).toHaveCount(0);

  const cookie = await loginCookie("discussion-maintainer", "maintainer");
  const annotationId = await persisted.getAttribute("data-annotation-id");
  expect(annotationId).not.toBeNull();
  const work = await waitForWorkItem(cookie, annotationId!);
  expect(work.type).toBe("revise_chapter");
});
