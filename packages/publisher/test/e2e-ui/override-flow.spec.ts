/**
 * Phase 6 contract §3.6 "Force-promote", end to end: a maintainer promotes a
 * suggestion that has NOT met the voting rule, and a work item exists against
 * a tally the UI showed them first.
 *
 * The tally assertion is the substance. The override's whole justification is
 * that the maintainer sees what they are overriding - for a solo author "the
 * thresholds only start mattering when other people arrive", which is only
 * safe if bypassing them is deliberate and visible rather than a quiet button.
 */
import { expect, test } from "@playwright/test";
import {
  chapterUrl,
  devLogin,
  loginCookie,
  seedRangeSuggestion,
  voteViaApi,
  waitForWorkItem,
} from "./helpers.js";

const SUGGESTION = "E2E override: this sentence could carry the drift more plainly.";
const REASON = "Promoting this myself: it is my book and the fix is obviously right.";

test("a maintainer promotes a suggestion to work against a visible tally", async ({ page }) => {
  // A suggestion with ONE approval - well short of the default rule (three
  // approvals, net ≥ 2, a human, and a human maintainer).
  const seeded = await seedRangeSuggestion({
    login: "override-author",
    body: SUGGESTION,
    exact: "Tuesday",
  });
  const voter = await loginCookie("override-voter", "contributor");
  await voteViaApi(voter, seeded.annotationId, "approve");

  await page.goto(chapterUrl("baseline"));
  await devLogin(page, "override-maintainer", "maintainer");

  const card = page.locator(".ab-card", { hasText: SUGGESTION }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.locator(".ab-card-head").click();
  await expect(card).toHaveClass(/ab-active/);

  // No work item yet: the rule is not met.
  await expect(card.locator(".ab-badge")).toHaveCount(0);

  // The override surface states the tally being overridden, including the
  // role-aware counts the Phase 6 amendment added.
  const override = card.locator(".ab-override");
  await expect(override).toBeVisible();
  await expect(override.locator(".ab-override-tally")).toContainText("1 approve");
  await expect(
    override.locator('.ab-override-role[data-count="human-maintainer-approvals"]'),
  ).toContainText("0");

  // Promoting requires a reason - an empty one is refused client-side, so the
  // override cannot be a single careless click.
  await override.locator('.ab-override-btn[data-override="promote"]').click();
  const form = override.locator(".ab-override-form");
  await expect(form).toBeVisible();
  await override.locator(".ab-override-confirm").click();
  await expect(override.locator(".ab-override-error")).toContainText(/reason/i);

  await override.locator("textarea.ab-override-reason").fill(REASON);
  await override.locator(".ab-override-confirm").click();
  // Surface a refused override as itself, rather than as a work-item timeout.
  await expect(override.locator(".ab-override-error")).toBeHidden();

  // A work item exists, created from this suggestion despite the tally.
  // Read it as a maintainer: the work queue is editor-and-above.
  const maintainer = await loginCookie("override-maintainer", "maintainer");
  const workItem = await waitForWorkItem(maintainer, seeded.annotationId);
  expect(workItem.sourceAnnotationId).toBe(seeded.annotationId);
  expect(workItem.status).toBe("ready");

  // And the card catches up to say so (the element refetches after an
  // override rather than guessing the new state).
  await expect(card.locator(".ab-badge")).toContainText("Queued as work item", {
    timeout: 30_000,
  });
});

test("a contributor is not offered the override", async ({ page }) => {
  const seeded = await seedRangeSuggestion({
    login: "override-author-2",
    body: "E2E override: a second suggestion, for the negative case.",
    exact: "fourth",
  });
  expect(seeded.annotationId).toBeTruthy();

  await page.goto(chapterUrl("baseline"));
  await devLogin(page, "override-contributor", "contributor");
  await expect(page.locator(".ab-card").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".ab-override")).toHaveCount(0);
});
