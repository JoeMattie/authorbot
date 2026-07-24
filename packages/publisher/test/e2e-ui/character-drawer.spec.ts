import { expect, test } from "@playwright/test";
import { chapterUrl } from "./helpers.js";

test("character links open the Web Awesome drawer with loaded details", async ({ page }) => {
  await page.goto(chapterUrl("baseline"));

  const characterLink = page.locator("[data-character-drawer-link]").first();
  await expect(characterLink).toBeVisible();
  await characterLink.click();

  const drawer = page.locator("[data-character-drawer]");
  await expect
    .poll(() => page.evaluate(() => customElements.get("wa-drawer") !== undefined))
    .toBe(true);
  await expect(drawer).toHaveAttribute("open");
  await expect(drawer.locator('dialog[part~="dialog"][open]')).toBeVisible();
  await expect(drawer.locator("[data-character-drawer-title]")).toHaveText("Dr. Mara Voss");
  await expect(drawer.locator(".character-detail")).toContainText(
    "Mara runs the deep-field interferometer",
  );
});
