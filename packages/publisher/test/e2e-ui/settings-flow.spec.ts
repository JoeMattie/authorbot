/**
 * Phase 6 contract §3.6, end to end: a settings change round-trips, and a
 * guarded field refuses to change until the maintainer has been told what it
 * breaks.
 *
 * Both tests restore what they changed. The e2e stack shares one book repo
 * across specs, and a settings commit is a real edit to `book.yml` — leaving
 * `chapter_url` rewritten would move every chapter for whatever runs next.
 */
import { expect, test, type Page } from "@playwright/test";
import { chapterUrl, devLogin, siteUrl } from "./helpers.js";

const ORIGINAL_TITLE = "The Hollow Creek Anomaly";
const NEW_TITLE = "The Hollow Creek Anomaly (Revised)";
const ORIGINAL_CHAPTER_URL = "/chapters/{slug}/";
const NEW_CHAPTER_URL = "/parts/{slug}/";

/** Sign in as a maintainer and land on the settings view, loaded. */
async function openSettings(page: Page, login: string): Promise<void> {
  await page.goto(chapterUrl("baseline"));
  await devLogin(page, login, "maintainer");
  await page.goto(`${siteUrl()}/settings/`);
  await expect(page.locator(".ab-settings-form")).toBeVisible({ timeout: 30_000 });
}

/**
 * Save and wait for the commit to land. A settings write is queued through the
 * same outbox as any other mutation, and the API refuses a second change while
 * one is in flight — so the next test step has to wait for it, not race it.
 */
async function saveAndSettle(page: Page): Promise<void> {
  await page.locator("button.ab-settings-save").click();
  await expect(page.locator("p.ab-settings-error")).toBeHidden();
  await expect(page.locator("p.ab-settings-status")).not.toBeEmpty({ timeout: 30_000 });
  await expect(async () => {
    await page.reload();
    await expect(page.locator("p.ab-settings-pending")).toHaveCount(0);
    await expect(page.locator("button.ab-settings-save")).toBeVisible();
  }).toPass({ timeout: 60_000 });
}

test("a settings change round-trips through book.yml", async ({ page }) => {
  await openSettings(page, "settings-e2e");

  const title = page.locator("input.ab-settings-title");
  await expect(title).toHaveValue(ORIGINAL_TITLE);
  await title.fill(NEW_TITLE);
  await saveAndSettle(page);

  // Round trip: the value came back from the API, not from the form state.
  await expect(page.locator("input.ab-settings-title")).toHaveValue(NEW_TITLE);

  // Put it back, so nothing downstream inherits a renamed book.
  await page.locator("input.ab-settings-title").fill(ORIGINAL_TITLE);
  await saveAndSettle(page);
  await expect(page.locator("input.ab-settings-title")).toHaveValue(ORIGINAL_TITLE);
});

test("a guarded field states what it breaks before the change is accepted", async ({ page }) => {
  await openSettings(page, "guarded-e2e");

  const chapterUrlField = page.locator("input.ab-settings-chapter-url");
  await expect(chapterUrlField).toHaveValue(ORIGINAL_CHAPTER_URL);
  await chapterUrlField.fill(NEW_CHAPTER_URL);

  // The consequence is stated as soon as the field differs — before any save.
  // Each guarded field has its own, shown only once that field is modified, so
  // the visible one is precisely the field being changed.
  const consequence = page.locator("p.ab-guarded-consequence:not([hidden])");
  await expect(consequence).toHaveCount(1);
  await expect(consequence).toContainText(/chapter_url/);
  await expect(consequence).toContainText(/break/i);

  // Saving does NOT apply it. The API demands confirmation and says why, and
  // the confirmation is never pre-ticked: a maintainer has to act.
  await page.locator("button.ab-settings-save").click();
  const confirm = page.locator(".ab-settings-confirm");
  await expect(confirm).toBeVisible({ timeout: 30_000 });
  await expect(confirm.locator("p.ab-confirm-breaks")).toContainText(/link/i);
  const check = confirm.locator("input.ab-confirm-check");
  await expect(check).not.toBeChecked();
  const confirmButton = confirm.locator("button.ab-confirm-btn");
  await expect(confirmButton).toBeDisabled();

  // Reloading now proves the unconfirmed change was never stored.
  await page.reload();
  await expect(page.locator("input.ab-settings-chapter-url")).toHaveValue(ORIGINAL_CHAPTER_URL);

  // Confirm explicitly, and it applies.
  await page.locator("input.ab-settings-chapter-url").fill(NEW_CHAPTER_URL);
  await page.locator("button.ab-settings-save").click();
  await expect(page.locator(".ab-settings-confirm")).toBeVisible({ timeout: 30_000 });
  await page.locator("input.ab-confirm-check").check();
  await expect(page.locator("button.ab-confirm-btn")).toBeEnabled();
  await page.locator("button.ab-confirm-btn").click();
  await expect(async () => {
    await page.reload();
    await expect(page.locator("p.ab-settings-pending")).toHaveCount(0);
    await expect(page.locator("input.ab-settings-chapter-url")).toHaveValue(NEW_CHAPTER_URL);
  }).toPass({ timeout: 60_000 });

  // Restore, through the same guarded path (which is itself a second proof
  // that the confirmation is required every time, not once per session).
  await page.locator("input.ab-settings-chapter-url").fill(ORIGINAL_CHAPTER_URL);
  await page.locator("button.ab-settings-save").click();
  await expect(page.locator(".ab-settings-confirm")).toBeVisible({ timeout: 30_000 });
  await page.locator("input.ab-confirm-check").check();
  await page.locator("button.ab-confirm-btn").click();
  await expect(async () => {
    await page.reload();
    await expect(page.locator("p.ab-settings-pending")).toHaveCount(0);
    await expect(page.locator("input.ab-settings-chapter-url")).toHaveValue(ORIGINAL_CHAPTER_URL);
  }).toPass({ timeout: 60_000 });
});

test("governance reads in author-facing language, and never-editable fields are absent", async ({
  page,
}) => {
  await openSettings(page, "governance-e2e");

  // §3.6: the thresholds are offered as "how many approvals before a
  // suggestion becomes work?", with each requirement EXPLAINED.
  const governance = page.locator(".ab-settings-governance");
  await expect(governance).toContainText("How many approvals before a suggestion becomes work?");
  const governanceText = await governance.innerText();
  for (const identifier of [
    "human_maintainer_approvals",
    "maintainer_approvals",
    "net_score",
    "distinct_voters",
    "gte",
  ]) {
    expect(governanceText, "rules read as prose, not as rule syntax").not.toContain(identifier);
  }
  // The human-maintainer requirement is explained rather than merely rendered,
  // and it is removable — the author's veto is theirs to keep or drop.
  await expect(page.locator("input.ab-require-human-maintainer")).toBeVisible();

  // §3.6 exit criterion: never-editable fields are ABSENT from the interface,
  // not present-and-disabled. No control anywhere binds to one.
  const controls = page.locator(".ab-settings-form input, .ab-settings-form select, .ab-settings-form textarea");
  const names = await controls.evaluateAll((nodes) =>
    nodes.map((node) => `${node.getAttribute("name") ?? ""} ${node.getAttribute("id") ?? ""}`),
  );
  for (const forbidden of ["raw_html", "chapters_glob", "default_branch", "api_url"]) {
    expect(names.join(" "), `${forbidden} has no form control`).not.toContain(forbidden);
  }
  // The book id is a UUID and must never be shown as a value.
  expect(await page.locator(".ab-settings-form").innerText()).not.toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
});
