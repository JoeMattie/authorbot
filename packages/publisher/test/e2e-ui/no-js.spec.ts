/**
 * Contract §5: progressive enhancement — with JavaScript disabled the
 * collab-enabled chapter page renders its prose with zero collaboration
 * chrome — and the Phase 1 regression, now conditional: an api-url-less
 * build ships zero <script> and no JS assets at all.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { chapterUrl, plainDir } from "./helpers.js";

test.describe("JS disabled", () => {
  test.use({ javaScriptEnabled: false });

  test("chapter prose renders with zero collaboration chrome", async ({ page }) => {
    await page.goto(chapterUrl("baseline"));
    await expect(page.locator("article.chapter h1")).toHaveText("Baseline");
    // Real prose is present and readable.
    const blocks = page.locator('main .prose [id^="b-"]');
    expect(await blocks.count()).toBeGreaterThan(0);
    await expect(blocks.first()).toBeVisible();
    // The mount element stays inert and empty; no island UI exists.
    await expect(page.locator("authorbot-collab")).toHaveCount(1);
    expect(await page.locator("authorbot-collab").evaluate((el) => el.childElementCount)).toBe(0);
    for (const selector of [
      ".ab-gutter",
      ".ab-drawer",
      ".ab-card",
      ".ab-devlogin",
      ".ab-signin",
      ".ab-annotate",
      ".ab-seltool",
      ".ab-composer",
    ]) {
      await expect(page.locator(selector), selector).toHaveCount(0);
    }
  });
});

test("api-url-less build remains script-free (regression, contract §5)", async () => {
  const dir = plainDir();
  const files: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else {
        files.push(abs);
      }
    }
  };
  await walk(dir);
  expect(files.length).toBeGreaterThan(0);
  expect(files.filter((file) => file.endsWith(".js"))).toEqual([]);
  expect(files.filter((file) => file.includes("authorbot-collab"))).toEqual([]);
  for (const file of files.filter((f) => f.endsWith(".html"))) {
    const html = await readFile(file, "utf8");
    expect(html, file).not.toContain("<script");
    expect(html, file).not.toContain("<authorbot-collab");
  }
});
