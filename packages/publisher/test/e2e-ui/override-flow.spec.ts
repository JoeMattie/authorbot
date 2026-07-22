/**
 * Phase 11 one-click promotion, end to end: a maintainer promotes a
 * suggestion that has NOT met the voting rule, and a work item exists against
 * a tally the UI showed them first.
 *
 * The open card shows its current support, while the settled card collapses to
 * the accepted diff and no longer carries governance controls.
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

  // Promotion is the maintainer's explicit one-click acceptance into Work.
  await override.locator('.ab-override-btn[data-override="promote"]').click();

  // A work item exists, created from this suggestion despite the tally.
  // Read it as a maintainer: the work queue is editor-and-above.
  const maintainer = await loginCookie("override-maintainer", "maintainer");
  const workItem = await waitForWorkItem(maintainer, seeded.annotationId);
  expect(workItem.sourceAnnotationId).toBe(seeded.annotationId);
  expect(workItem.status).toBe("ready");

  // The optimistic response settles the card immediately. The old queue/tally
  // chrome is gone; only the accepted diff remains.
  await expect(card).toHaveClass(/ab-promoted/, { timeout: 30_000 });
  await expect(card.locator(".ab-accepted-badge")).toHaveText("Accepted");
  await expect(card.locator(".ab-suggestion-diff")).toBeVisible();
  await expect(card.locator(".ab-votes")).toHaveCount(0);
  await expect(card.locator(".ab-override")).toHaveCount(0);
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
