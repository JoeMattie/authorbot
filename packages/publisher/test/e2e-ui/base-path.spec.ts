/**
 * ADR-0019 §6 - a book served under a subpath of a larger site, end to end in
 * a real browser.
 *
 * This is the test that makes "same origin only" tolerable as a prescription:
 * the constraint is one ORIGIN, not the root of a domain. Three things have to
 * agree for that to be true, and they either all do or none do -
 *
 *   1. the emitted asset tree is nested under the prefix, so the URLs Astro
 *      writes point at files that actually exist there;
 *   2. `publication.api_url` makes the islands call `/my-book/v1/...`;
 *   3. the Worker's `API_BASE_PATH` serves the API under the same prefix.
 *
 * Getting (1) wrong publishes a site whose every asset 404s while an unlinked
 * root copy is the only reachable tree. Getting (2) or (3) wrong publishes a
 * site that reads fine and whose every collaboration call 404s - which is
 * precisely the failure a build-time check cannot see and a unit test does not
 * model. Hence a browser test: it exercises the pairing the way a reader does.
 *
 * The base-path deployment is a wholly separate stack (own repo, own database,
 * own API process, own origin - see global-setup), so nothing here can pass by
 * accidentally talking to the root deployment.
 */
import { expect, test } from "@playwright/test";
import { BASE_PATH, basePathSiteUrl, baseSiteUrl, devLogin } from "./helpers.js";

const SUGGESTION_BODY = "E2E base-path: the collaboration island reached the API under the prefix.";

test("a book published under a base path reads, and its islands work", async ({ page }) => {
  // Every request the browser makes, so a 404 on an asset or an API call is
  // caught here rather than as a mystery timeout below.
  const notFound: string[] = [];
  page.on("response", (response) => {
    if (response.status() === 404) {
      notFound.push(`${response.status()} ${response.url()}`);
    }
  });

  const chapter = `${basePathSiteUrl()}/chapters/baseline/`;
  await page.goto(chapter);

  // (1) The page reads: prose is present and the stylesheet + island bundle
  // resolved under the prefix rather than at the origin root.
  await expect(page.locator("main .prose")).not.toBeEmpty();
  const assetUrls = await page.evaluate(() => ({
    styles: [...document.querySelectorAll('link[rel="stylesheet"]')].map((n) =>
      n.getAttribute("href"),
    ),
    scripts: [...document.querySelectorAll("script[src]")].map((n) => n.getAttribute("src")),
  }));
  expect(assetUrls.scripts.length).toBeGreaterThan(0);
  for (const href of [...assetUrls.styles, ...assetUrls.scripts]) {
    expect(href, "every asset URL is nested under the base path").toMatch(
      new RegExp(`^${BASE_PATH}/`),
    );
  }

  // (2)+(3) The islands hydrated and reached the API under the prefix: the
  // dev-login form is rendered by the island (not the page), and submitting it
  // requires `POST /my-book/v1/dev/login` to have resolved.
  await devLogin(page, "base-path-e2e", "contributor");

  // A full write round-trip through the prefixed API, so this is not merely a
  // successful GET: create a suggestion and watch its card appear.
  // Focus + Enter rather than a click: the per-block affordance rests hidden
  // until hover on a pointer device, and this path is keyboard-complete anyway.
  const annotate = page.locator(".ab-annotate").first();
  await annotate.focus();
  await page.keyboard.press("Enter");
  const composer = page.locator(".ab-composer");
  await expect(composer).toBeVisible();
  await composer.locator("textarea").fill(SUGGESTION_BODY);
  await composer.getByRole("button", { name: "Post" }).click();

  const card = page.locator(".ab-card", { hasText: SUGGESTION_BODY });
  await expect(card).toBeVisible();
  await expect(card.locator(".ab-status-open")).toBeVisible();

  // It persists across a reload - the read path is prefixed too, not just the
  // write path that happened to be relative to the current page.
  await page.reload();
  await expect(page.locator(".ab-card", { hasText: SUGGESTION_BODY })).toBeVisible();

  expect(notFound, "no request 404'd under the base path").toEqual([]);
});

test("the base-path deployment serves nothing at the origin root", async ({ page }) => {
  // The mirror image of the asset assertion above: if the tree were emitted
  // un-nested, the root would serve a copy of the book that no link points at
  // - the exact bug ADR-0019 §6 and the nested `siteOutDir` exist to prevent.
  const response = await page.goto(`${baseSiteUrl()}/chapters/baseline/`, {
    waitUntil: "commit",
  });
  expect(response?.status()).toBe(404);
});
