/**
 * Contract §5 core flow: dev-login → select text → suggest → gutter card
 * appears anchored to the right block → reply → reload → both persist
 * (API-backed, via `GET .../replies`) → withdraw → card gone. The reply's
 * durable git commit is additionally asserted against the temp work tree.
 */
import { expect, test } from "@playwright/test";
import { chapterUrl, devLogin, gitLogContains, repoDir, selectInFirstBlock } from "./helpers.js";

const SUGGESTION_BODY = "E2E suggestion: tighten the opening sentence of this paragraph.";
const REPLY_BODY = "E2E reply: agreed, the second clause can go.";

test("annotation lifecycle: create, anchor, reply, persist, withdraw", async ({ page }) => {
  await page.goto(chapterUrl("baseline"));
  await devLogin(page, "mara-e2e", "contributor");

  // The desktop notes rail shares the page's vertical scroll. A nested
  // scrollbar makes trackpad and wheel navigation stick inside the sidebar.
  const rail = page.locator(".ab-gutter");
  await expect(rail).toBeVisible();
  await expect
    .poll(() => rail.evaluate((node) => getComputedStyle(node).overflowY))
    .toBe("visible");

  // Select text inside the first block → the selection toolbar offers
  // Comment / Suggest an edit (contract §2.2).
  await selectInFirstBlock(page, 5, 40);
  const selTool = page.locator(".ab-seltool");
  await expect(selTool).toBeVisible();
  await selTool.getByRole("button", { name: "Suggest an edit" }).click();

  // Composer: quote captured from the selection, body, post.
  const composer = page.locator(".ab-composer");
  await expect(composer).toBeVisible();
  await expect(composer.locator(".ab-quote")).not.toBeEmpty();
  await composer.locator("textarea").fill(SUGGESTION_BODY);
  await composer.getByRole("button", { name: "Post" }).click();

  // Card appears in the gutter, honest about state (§2.5): syncing → open.
  const card = page.locator(".ab-card", { hasText: SUGGESTION_BODY });
  await expect(card).toBeVisible();
  await expect(card.locator(".ab-status-open")).toBeVisible();
  await expect(card).toHaveAttribute("aria-label", /^Suggestion by mara-e2e on “/u);

  // The exact selected text is highlighted and wired to its card in the
  // sticky notes rail. Focusing the active card still exposes the broader
  // block outline for keyboard and low-vision readers.
  const firstBlock = page.locator('main .prose [id^="b-"]').first();
  const highlight = firstBlock.locator(".ab-inline-highlight");
  await expect(highlight).toHaveText("rift appeared on a Tuesday, in the");
  await expect(card).toBeVisible();
  await highlight.click();
  await expect(card).toHaveClass(/ab-active/);
  await card.focus();
  await expect(firstBlock).toHaveClass(/ab-target/);

  // Reply (threaded, §2.3).
  await card.getByRole("button", { name: "Reply", exact: true }).click();
  const replyForm = card.locator(".ab-reply-form");
  await replyForm.locator("textarea").fill(REPLY_BODY);
  await replyForm.getByRole("button", { name: "Post reply" }).click();
  await expect(card.locator(".ab-reply", { hasText: REPLY_BODY })).toBeVisible();

  // Reload → BOTH persist API-backed (contract §5): the annotation card and
  // its reply re-render from the API. Git durability is asserted too.
  await expect(async () => {
    expect(await gitLogContains(repoDir(), SUGGESTION_BODY)).toBe(true);
    expect(await gitLogContains(repoDir(), REPLY_BODY)).toBe(true);
  }).toPass({ timeout: 15_000 });
  await page.reload();
  const persisted = page.locator(".ab-card", { hasText: SUGGESTION_BODY });
  await expect(persisted).toBeVisible();
  await expect(persisted.locator(".ab-status-open")).toBeVisible();
  await expect(persisted.locator(".ab-quote")).not.toBeEmpty();
  await expect(persisted.locator(".ab-reply", { hasText: REPLY_BODY })).toBeVisible();

  // Withdraw (author-only, two-step) → card gone, durably.
  await persisted.getByRole("button", { name: "Withdraw", exact: true }).click();
  await persisted.getByRole("button", { name: "Confirm withdraw" }).click();
  await expect(page.locator(".ab-card", { hasText: SUGGESTION_BODY })).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".ab-me", { hasText: "Signed in as mara-e2e" })).toBeVisible();
  await expect(page.locator(".ab-card", { hasText: SUGGESTION_BODY })).toHaveCount(0);
});
