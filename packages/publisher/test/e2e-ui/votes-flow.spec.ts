/**
 * Phase 3 contract §7 / §7.7: three dev actors (distinct sessions) vote a
 * suggestion over the default threshold → the "Queued as work item" badge
 * appears on an already-open page without a reload (live event feed, with the
 * poll fallback the dev bridge forces) → the `/work/` page lists the ready
 * item. Plus: a signed-out reader sees tallies but no controls, and a
 * keyboard-only voting round trip.
 *
 * Default rule (design §25): approvals ≥ 3, net ≥ 2, human_approvals ≥ 1 —
 * so three human contributors approving crosses it exactly.
 */
import { expect, test } from "@playwright/test";
import {
  chapterUrl,
  devLogin,
  loginCookie,
  seedAnnotationViaApi,
  siteUrl,
  voteViaApi,
  waitForAnnotationOpen,
} from "./helpers.js";

const SUGGESTION_BODY = "E2E votes: this passage should be tightened before publication.";

let annotationId: string;

test.beforeAll(async () => {
  const seed = await loginCookie("seed-suggester", "contributor");
  const seeded = await seedAnnotationViaApi({
    login: "seed-suggester",
    body: SUGGESTION_BODY,
    kind: "suggestion",
    chapterSlug: "baseline",
  });
  annotationId = seeded.annotationId;
  // The suggestion must be committed (`open`) before it can be voted on.
  await waitForAnnotationOpen(annotationId, seed);
});

test("threshold crossing: badge appears live and the item reaches /work/", async ({ browser }) => {
  // Actor A votes through the UI and keeps the page open (the live watcher).
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await pageA.goto(chapterUrl("baseline"));
  await devLogin(pageA, "vote-alice", "contributor");

  const card = pageA.locator(".ab-card", { hasText: SUGGESTION_BODY });
  await expect(card).toBeVisible();
  const approve = card.locator('.ab-vote-btn[data-vote="approve"]');
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(approve).toHaveAttribute("aria-pressed", "true");
  await expect(card.locator(".ab-vote-tally")).toContainText("1 approve");
  // No decision yet at one approval.
  await expect(card.locator(".ab-badge")).toHaveCount(0);

  // Actors B and C approve via distinct API sessions; C's vote crosses.
  const bob = await loginCookie("vote-bob", "contributor");
  await voteViaApi(bob, annotationId, "approve");
  const carol = await loginCookie("vote-carol", "contributor");
  await voteViaApi(carol, annotationId, "approve");

  // Alice's still-open page shows the badge with NO reload — delivered by the
  // event feed (SSE, or its poll fallback). Generous timeout: the poll
  // fallback engages after the stream's open timeout.
  await expect(card.locator(".ab-badge", { hasText: "Queued as work item" })).toBeVisible({
    timeout: 25_000,
  });
  await expect(card.locator(".ab-vote-tally")).toContainText("3 approve");

  // /work/ lists the ready item (work:read is editor+, so use a maintainer).
  const ctxM = await browser.newContext();
  const pageM = await ctxM.newPage();
  await pageM.goto(chapterUrl("baseline"));
  await devLogin(pageM, "vote-max", "maintainer");
  await pageM.goto(`${siteUrl()}/work/`);
  const items = pageM.locator(".ab-work-item");
  await expect(items.first()).toBeVisible({ timeout: 15_000 });
  await expect(
    pageM.locator(".ab-work-item .ab-work-chapter", { hasText: "Baseline" }).first(),
  ).toBeVisible();
  await expect(pageM.locator(".ab-work-item .ab-work-base").first()).toContainText("Base revision");
  await expect(pageM.locator(".ab-work-item .ab-work-support").first()).toContainText("approve");

  await ctxA.close();
  await ctxM.close();
});

test("signed-out reader sees the tally but has no enabled controls (§7)", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(chapterUrl("baseline"));

  // show_public_annotations: the suggestion renders for the anonymous reader.
  const card = page.locator(".ab-card", { hasText: SUGGESTION_BODY });
  await expect(card).toBeVisible();
  // Tallies are visible to everyone (counts only).
  await expect(card.locator(".ab-vote-tally")).toContainText("approve");
  // The segments exist but are all disabled (enabled only with votes:write).
  await expect(card.locator(".ab-vote-btn")).toHaveCount(3);
  await expect(card.locator(".ab-vote-btn:not([disabled])")).toHaveCount(0);
  await expect(card.locator(".ab-vote-hint")).toContainText("Sign in to vote");
  // No error chrome anywhere (progressive enhancement).
  await expect(page.locator(".ab-error:visible")).toHaveCount(0);

  await ctx.close();
});

test("keyboard-only voting round trip", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(chapterUrl("baseline"));
  await devLogin(page, "kb-voter", "contributor");

  const card = page.locator(".ab-card", { hasText: SUGGESTION_BODY });
  await expect(card).toBeVisible();
  const approve = card.locator('.ab-vote-btn[data-vote="approve"]');
  const abstain = card.locator('.ab-vote-btn[data-vote="abstain"]');

  // Cast approve with the keyboard: the segment is focusable, and Enter on a
  // real <button> activates it. `locator.press` focuses then presses, so it is
  // robust to a background live refetch re-rendering the card.
  await approve.focus();
  await expect(approve).toBeFocused();
  await approve.press("Enter");
  await expect(approve).toHaveAttribute("aria-pressed", "true");

  // Change the vote with the keyboard: abstain now pressed, approve released.
  await abstain.press("Enter");
  await expect(abstain).toHaveAttribute("aria-pressed", "true");
  await expect(approve).toHaveAttribute("aria-pressed", "false");

  // Toggle the current vote off with the keyboard (clear).
  await abstain.press("Enter");
  await expect(abstain).toHaveAttribute("aria-pressed", "false");

  await ctx.close();
});
