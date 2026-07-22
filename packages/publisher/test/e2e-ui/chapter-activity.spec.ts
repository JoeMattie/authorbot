import { expect, test } from "@playwright/test";
import {
  PROJECT,
  chapterUrl,
  loginCookie,
  siteUrl,
} from "./helpers.js";

const BASELINE_ID = "019cadfd-8900-7140-98fb-ceff64cada33";
const NULL_RESULTS_ID = "019d0bc2-a980-734d-b0c1-aa819448d107";

const activity = {
  openSuggestions: 12,
  openBlockComments: 11,
  openChapterComments: 10,
  openReplies: 9,
  openWorkItems: 8,
};

const chapters = [
  {
    id: BASELINE_ID,
    projectId: "project-1",
    path: "chapters/001-baseline.md",
    slug: "baseline",
    title: "Baseline",
    status: "published",
    revision: 3,
    updatedAt: "2026-07-22T12:00:00Z",
    activity,
  },
  {
    id: NULL_RESULTS_ID,
    projectId: "project-1",
    path: "chapters/002-null-results.md",
    slug: "null-results",
    title: "Null Results",
    status: "published",
    revision: 2,
    updatedAt: "2026-07-22T12:00:00Z",
    activity,
  },
];

for (const width of [320, 390]) {
  test(`chapter activity stays inside ${width}px navigation`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const cookie = await loginCookie(`activity-${width}`, "maintainer");
    const separator = cookie.indexOf("=");
    await context.addCookies([
      {
        name: cookie.slice(0, separator),
        value: cookie.slice(separator + 1),
        url: siteUrl(),
      },
    ]);
    const page = await context.newPage();
    await page.route(
      `**/v1/projects/${PROJECT}/chapters?**`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: chapters, nextCursor: null }),
        });
      },
    );

    await page.goto(siteUrl());
    await expect(page.locator(".chapter-index .ab-chapter-activity")).toHaveCount(2);
    await expect(page.locator(".chapter-index .ab-chapter-activity-badge")).toHaveCount(10);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    await page.goto(chapterUrl("baseline"));
    await expect(page.locator(".chapter-header .ab-chapter-activity-badge")).toHaveCount(5);
    await expect(page.locator(".chapter-nav .ab-chapter-activity-badge")).toHaveCount(5);
    const layout = await page.evaluate(() => {
      const viewport = window.innerWidth;
      const boxes = [...document.querySelectorAll<HTMLElement>(
        ".chapter-nav, .chapter-nav [data-chapter-activity-slot], .chapter-nav .ab-chapter-activity",
      )].map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      });
      return {
        pageFits: document.documentElement.scrollWidth <= viewport,
        boxesFit: boxes.every((box) => box.left >= 0 && box.right <= viewport),
      };
    });
    expect(layout).toEqual({ pageFits: true, boxesFit: true });
    await context.close();
  });
}
