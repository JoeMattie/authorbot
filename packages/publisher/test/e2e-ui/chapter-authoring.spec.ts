/**
 * Phase 6 contract §3.5, end to end: a maintainer signs in, clicks "New
 * chapter", writes a title and prose, saves a draft, publishes it, and the
 * chapter appears on the site - **never having seen a UUID or a block
 * marker**.
 *
 * That last clause is the point of the section, so it is asserted rather than
 * assumed: the composer is a plain title-and-prose box, and every id, slug,
 * order and marker the chapter file needs is the server's to generate. A test
 * that only checked the chapter landed would pass just as happily against a
 * UI that made the author paste a UUID.
 */
import { expect, test, type Page } from "@playwright/test";
import { chapterUrl, devLogin, gitLogContains, rebuildSite, repoDir, siteUrl } from "./helpers.js";

const TITLE = "The Signal Returns";
const PROSE = [
  "Mara had promised herself she would not open the folder again.",
  "",
  "She opened the folder again. The drift was still there, patient as arithmetic.",
].join("\n");

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Everything the author can actually read on the page right now. */
async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

/**
 * The two things §3.5 promises an author never has to look at. Checked at
 * every step rather than once at the end, because "no UUID in the final state"
 * would still allow a composer that showed one along the way.
 */
async function assertNoIdsOrMarkers(page: Page, step: string): Promise<void> {
  const text = await visibleText(page);
  expect(text, `${step}: no UUID is shown to the author`).not.toMatch(UUID);
  expect(text, `${step}: no block marker syntax is shown to the author`).not.toContain(
    "authorbot:block",
  );
  const composed = await page.locator("textarea.ab-chapter-text").inputValue();
  expect(composed, `${step}: the prose box holds Markdown only`).not.toContain("authorbot:block");
  expect(composed, `${step}: the prose box holds no frontmatter`).not.toMatch(/^---/);
}

test("a maintainer writes a new chapter, reviews the draft from home, and publishes it", async ({
  page,
  browser,
}) => {
  // Sign in on a chapter page - the "New chapter" button is an affordance for
  // actors who may use it, not a login prompt, so it renders nothing until the
  // API says who this is.
  await page.goto(chapterUrl("baseline"));
  await devLogin(page, "author-e2e", "maintainer");

  // From the home page: the entry point is visible now that the viewer may
  // author. (A book with no chapters at all has only this page - which is why
  // the button lives here.)
  await page.goto(`${siteUrl()}/`);
  const newChapter = page.locator("a.ab-new-chapter");
  await expect(newChapter).toBeVisible();
  await expect(newChapter).toHaveText("New chapter");
  await newChapter.click();

  // A plain title-and-prose composer: Markdown, no frontmatter, no markers.
  const form = page.locator("form.ab-chapter-form");
  await expect(form).toBeVisible();
  await assertNoIdsOrMarkers(page, "empty composer");

  await page.locator("input.ab-chapter-title").fill(TITLE);
  await page.locator("textarea.ab-chapter-text").fill(PROSE);
  await assertNoIdsOrMarkers(page, "composed");

  // Saving creates a DRAFT. Publishing is a separate, explicit action, so it
  // must not have happened yet.
  await page.locator("button.ab-chapter-save").click();
  const status = page.locator("p.ab-chapter-status");
  await expect(status).toContainText(/draft/i, { timeout: 30_000 });
  await expect(page.locator("p.ab-chapter-error")).toBeHidden();
  await assertNoIdsOrMarkers(page, "saved draft");

  // The prose is in Git, with markers the SERVER assigned.
  await expect(async () => {
    expect(await gitLogContains(repoDir(), "patient as arithmetic")).toBe(true);
  }).toPass({ timeout: 30_000 });

  // A draft is not on the site yet: publishing is what puts it there. Checked
  // in a second tab so the composer keeps the chapter it just made - the
  // author never has to carry an id from one page to another.
  const reader = await page.context().newPage();
  await rebuildSite();
  await reader.goto(`${siteUrl()}/`);
  await expect(reader.locator(".chapter-index")).not.toContainText(TITLE);

  // The signed-in maintainer still sees the unpublished chapter in a private
  // home-page workspace and can reopen the existing composer from there.
  const drafts = reader.locator(".ab-drafts");
  await expect(drafts).toContainText(TITLE);
  const submittedDraft = drafts.locator(".ab-draft-item").filter({ hasText: TITLE });
  await expect(submittedDraft.locator(".ab-chip")).toHaveText("draft");
  await submittedDraft.getByRole("button", { name: `Review draft: ${TITLE}` }).click();
  await expect(submittedDraft.locator("textarea.ab-chapter-text")).toHaveValue(PROSE);

  // A fresh, signed-out browser gets neither the draft title nor its prose.
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await visitor.goto(`${siteUrl()}/`);
  await expect(visitor.locator("body")).not.toContainText(TITLE);
  await expect(visitor.locator("authorbot-draft-chapters")).toBeEmpty();
  await visitorContext.close();

  // Publish - the separate, explicit action, offered to a maintainer once the
  // chapter exists.
  const publish = page.locator("button.ab-chapter-publish");
  await expect(publish).toBeVisible();
  await expect(publish).toHaveText(/^Publish$/);
  await publish.click();
  await expect(page.locator("p.ab-chapter-status")).toContainText(/publish/i, { timeout: 30_000 });
  await assertNoIdsOrMarkers(page, "published");
  await reader.close();

  // Republish the site, as a real deployment does after Authorbot commits, and
  // the chapter is simply there - reachable from the index, prose intact, with
  // no marker syntax leaking into the reading surface.
  await rebuildSite();
  await page.goto(`${siteUrl()}/`);
  await expect(page.locator(".chapter-index")).toContainText(TITLE);

  await page.getByRole("link", { name: TITLE }).click();
  await expect(page.locator("main .prose")).toContainText("patient as arithmetic");
  const published = await visibleText(page);
  expect(published).not.toMatch(UUID);
  expect(published).not.toContain("authorbot:block");
});
