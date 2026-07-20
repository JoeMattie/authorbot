/**
 * Contract §5 visibility flows on the null-results chapter (its own chapter so
 * cards never stack against collab-flow.spec's).
 *
 * "Signed-out reader sees public annotations read-only": the API serves
 * anonymous annotation/reply reads when PUBLIC_ANNOTATIONS=true (the mirror
 * of `publication.show_public_annotations`; global-setup enables it to match
 * examples/book-repo book.yml). The signed-in `reader` role additionally
 * exercises read-only rendering with an authenticated session.
 */
import { expect, test } from "@playwright/test";
import { chapterUrl, devLogin, seedAnnotationViaApi, selectInFirstBlock } from "./helpers.js";

const SEED_BODY = "E2E seeded comment: check the calibration numbers in this section.";

test.beforeAll(async () => {
  await seedAnnotationViaApi({
    login: "seed-author",
    body: SEED_BODY,
    chapterSlug: "null-results",
  });
});

test("reader role sees annotations read-only", async ({ page }) => {
  await page.goto(chapterUrl("null-results"));
  await devLogin(page, "reader-rita", "reader");

  const card = page.locator(".ab-card", { hasText: SEED_BODY });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("aria-label", /^Comment by /u);
  await expect(page.locator(".ab-hint", { hasText: "read-only" })).toBeVisible();

  // No write affordances: no reply/withdraw on the card, and selecting text
  // never offers the annotation toolbar.
  await expect(card.getByRole("button", { name: "Reply", exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Withdraw", exact: true })).toHaveCount(0);
  await selectInFirstBlock(page, 5, 40);
  await page.waitForTimeout(400); // selectionchange debounce is 120ms
  await expect(page.locator(".ab-seltool")).toBeHidden();
});

test("signed-out reader sees public annotations read-only (§5), no errors, prose intact", async ({
  page,
}) => {
  await page.goto(chapterUrl("null-results"));
  await expect(page.locator(".ab-devlogin")).toBeVisible();
  // show_public_annotations: the seeded annotation renders for the anonymous
  // visitor, read-only (no reply/withdraw affordances).
  const card = page.locator(".ab-card", { hasText: SEED_BODY });
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Reply", exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Withdraw", exact: true })).toHaveCount(0);
  // No error chrome anywhere (§1 progressive enhancement).
  await expect(page.locator(".ab-error:visible")).toHaveCount(0);
  await expect(page.locator("article.chapter h1")).toHaveText("Null Results");
});
