/**
 * Contract §5 + §4: keyboard-only annotation creation via the per-block
 * "Annotate" affordance (§16.6). Sign-in itself uses the form fill (it is not
 * part of the flow under test); from the reading surface on, every step is a
 * key press: Tab to the block's Annotate button, Enter to open the composer
 * (focus lands in the textarea), type the body, Tab to Post, Enter to submit,
 * and focus lands on the created card.
 */
import { expect, test } from "@playwright/test";
import { chapterUrl, devLogin } from "./helpers.js";

const KB_BODY = "E2E keyboard-only comment: this block reads well aloud.";
const TOUCH_BODY = "E2E mobile inline note: keep this beside its paragraph.";

test("keyboard-only annotation creation", async ({ page }) => {
  await page.goto(chapterUrl("baseline"));
  await devLogin(page, "kb-kai", "contributor");

  // Park focus at the top of the document, then Tab to the first per-block
  // Annotate button.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  let reachedAnnotate = false;
  for (let presses = 0; presses < 80; presses += 1) {
    await page.keyboard.press("Tab");
    reachedAnnotate = await page.evaluate(
      () => document.activeElement?.classList.contains("ab-annotate") ?? false,
    );
    if (reachedAnnotate) {
      break;
    }
  }
  expect(reachedAnnotate).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const rect = (document.activeElement as HTMLElement).getBoundingClientRect();
        return rect.bottom > 57 && rect.top < window.innerHeight;
      }),
    )
    .toBe(true);

  // Enter opens the block composer with focus in the textarea (§16.6).
  await page.keyboard.press("Enter");
  await expect(page.locator(".ab-composer")).toBeVisible();
  await expect(page.locator(".ab-composer textarea")).toBeFocused();

  await page.keyboard.type(KB_BODY);
  await page.keyboard.press("Tab"); // → Post
  const post = page.locator(".ab-composer button", { hasText: "Post" }).first();
  await expect(post).toBeFocused();
  await page.keyboard.press("Enter");

  // The card appears and receives focus so the keyboard user is taken to it.
  const card = page.locator(".ab-card", { hasText: KB_BODY });
  await expect(card).toBeVisible();
  await expect(card).toBeFocused();
  await expect(card).toHaveAttribute("aria-label", /^Comment by kb-kai /u);
  await expect(card.locator(".ab-status-open")).toBeVisible();
});

test("touch readers can discover the per-block annotation affordance", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true });
  const page = await context.newPage();
  await page.goto(chapterUrl("baseline"));
  await devLogin(page, "touch-tess", "contributor");
  await page.setViewportSize({ width: 390, height: 844 });

  const annotate = page.locator(".ab-annotate").first();
  await expect(annotate).toBeVisible();
  await expect(annotate).toHaveCSS("opacity", "1");

  const block = page.locator('main .prose [id^="b-"]').first();
  await annotate.focus();
  await expect(block).toHaveClass(/ab-note-target-preview/);
  await expect(page.getByRole("tooltip", { name: "Note on this block" })).toBeVisible();
  await annotate.click();
  const composer = page.locator(".ab-composer");
  await composer.locator("textarea").fill(TOUCH_BODY);
  await composer.getByRole("button", { name: "Post" }).click();

  const card = page.locator(".ab-inline-notes-block .ab-card", { hasText: TOUCH_BODY });
  await expect(card).toBeVisible();
  await expect(page.locator(".ab-drawer")).toHaveCount(0);
  await expect(page.locator(".ab-inline-notes .ab-discussion-boundary")).toHaveCount(0);
  const targetId = await block.getAttribute("id");
  await expect
    .poll(() =>
      card.evaluate((node) => {
        const host = node.closest(".ab-inline-notes-block");
        const blockUi = host?.previousElementSibling;
        return blockUi?.previousElementSibling?.id ?? null;
      }),
    )
    .toBe(targetId);
  await context.close();
});
