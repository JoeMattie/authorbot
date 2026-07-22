/**
 * Phase 4 contract §7/§8: the human path through a `revise_range` work item,
 * end to end against the real dev API and a real git repo.
 *
 *  1. claim → edit → submit → "Completed" → the committed chapter carries the
 *     new prose, and the published page shows it after a rebuild + refresh;
 *  2. the renewal prompt appears on its own with the short-lease test config
 *     (global-setup runs the API with LEASE_DURATION=PT5M10S against the
 *     PT5M prompt threshold), renews, and releases;
 *  3. the conflict path: an edit whose chapter moved underneath it is
 *     surfaced honestly, the chapter is left byte-intact, and the created
 *     `resolve_conflict` work item is named in the UI.
 *
 * The agent path over the same work-item type lives in `agent-script.spec.ts`
 * (contract §27.5: both interfaces complete the same task type).
 */
import { expect, test, type Page } from "@playwright/test";
import {
  chapterFileText,
  chapterUrl,
  devLogin,
  gitLogContains,
  loginCookie,
  rebuildSite,
  seedRangeSuggestion,
  voteToThreshold,
  waitForWorkItem,
  workUrl,
} from "./helpers.js";

/** Sign in through the chapter page (the /work/ page has no login form). */
async function signIn(page: Page, login: string, role = "editor"): Promise<void> {
  await page.goto(chapterUrl("baseline"));
  await devLogin(page, login, role);
}

/** Claim the queue entry for `workItemId` and wait for the edit view. */
async function claimInUi(page: Page, workItemId: string): Promise<void> {
  await page.goto(workUrl());
  const item = page.locator(`.ab-work-item[data-work-item-id="${workItemId}"]`);
  await expect(item).toBeVisible({ timeout: 20_000 });
  // Keyboard-complete (Phase 2b §4): claiming is a real button reached and
  // activated from the keyboard, never a mouse-only affordance.
  await item.locator(".ab-claim-btn").press("Enter");
  await expect(page.locator(".ab-claim")).toBeVisible({ timeout: 20_000 });
}

test("human completes a range_replacement: claim → edit → submit → completed → published", async ({
  browser,
}) => {
  const original = "where nobody respectable ever looks";
  const replacement = "where only the patient ever look";

  const seed = await seedRangeSuggestion({
    login: "work-seeder",
    body: "This clause could be sharper.",
    exact: original,
    chapterSlug: "baseline",
  });
  await voteToThreshold(seed.annotationId, "work-voter");
  const maintainer = await loginCookie("work-maxine", "maintainer");
  const item = await waitForWorkItem(maintainer, seed.annotationId);
  expect(item.type).toBe("revise_range");

  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, "work-hera", "editor");
  await page.setViewportSize({ width: 390, height: 844 });
  await claimInUi(page, item.id);

  await expect(page.locator('.site-nav a[aria-current="page"]')).toContainText("Work");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const nav = document.querySelector(".site-nav")?.getBoundingClientRect();
        const active = document
          .querySelector('.site-nav a[aria-current="page"]')
          ?.getBoundingClientRect();
        return (
          nav !== undefined &&
          active !== undefined &&
          active.left >= nav.left - 1 &&
          active.right <= nav.right + 1
        );
      }),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);

  // ---- the edit view carries the §15.3 task bundle -------------------------
  const panel = page.locator(".ab-claim");
  await expect(panel.locator(".ab-claim-title")).toHaveText("Revise passage");
  await expect(panel.locator(".ab-claim-request")).toHaveText("This clause could be sharper.");
  await expect(panel.locator(".ab-claim-criteria li").first()).toBeVisible();
  await expect(panel.locator(".ab-original-text")).toHaveText(original);
  await expect(panel.locator(".ab-untrusted-note")).toContainText("untrusted");
  // A live remaining-lease indicator, and no renewal nagging at the start.
  await expect(panel.locator(".ab-lease-remaining")).toContainText("Lease expires in");
  await expect(panel.locator(".ab-lease-prompt")).toBeHidden();

  // The textarea starts prefilled with the target and already holds focus, so
  // a keyboard user lands in the writing surface with no extra navigation.
  const textarea = panel.locator("textarea");
  await expect(textarea).toHaveValue(original);
  await expect(textarea).toBeFocused();
  await textarea.fill(replacement);
  await panel.locator('input[name="summary"]').fill("Sharpen the closing clause");

  // ---- submit → syncing → completed ---------------------------------------
  await panel.locator('button[type="submit"]').press("Enter");
  await expect(panel.locator(".ab-submit-status")).toContainText(/Submitting|Syncing/);
  await expect(panel.locator(".ab-submit-completed")).toContainText("Completed", {
    timeout: 60_000,
  });
  // The lease is spent: no renew/release affordance remains.
  await expect(panel.locator(".ab-lease-renew")).toBeHidden();

  // ---- one commit, in the real repository ---------------------------------
  const chapterText = await chapterFileText("001-baseline.md");
  expect(chapterText).toContain(replacement);
  expect(chapterText).not.toContain(original);
  expect(chapterText).toContain("revision: 4");
  expect(await gitLogContains(process.env["AB_E2E_REPO_DIR"] as string, replacement)).toBe(true);

  // ---- the published page shows the new prose after a rebuild -------------
  await rebuildSite();
  await page.goto(chapterUrl("baseline"));
  await expect(page.locator("main .prose")).toContainText(replacement);
  await expect(page.locator("main .prose")).not.toContainText(original);

  await context.close();
});

test("lease countdown prompts renewal near expiry, renews, and releases", async ({ browser }) => {
  const seed = await seedRangeSuggestion({
    login: "renew-seeder",
    body: "Tighten this comparison.",
    exact: "better data before canceling the picnic",
    chapterSlug: "null-results",
  });
  await voteToThreshold(seed.annotationId, "renew-voter");
  const maintainer = await loginCookie("renew-maxine", "maintainer");
  const item = await waitForWorkItem(maintainer, seed.annotationId);

  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, "renew-holder", "editor");
  await claimInUi(page, item.id);

  const panel = page.locator(".ab-claim");
  const prompt = panel.locator(".ab-lease-prompt");
  await expect(prompt).toBeHidden();

  // The API issued a 5m10s lease; the prompt fires at T-5m, i.e. about ten
  // seconds in. No mocked clocks - this is the real countdown.
  await expect(prompt).toBeVisible({ timeout: 60_000 });
  // The copy states the real prompt window (mm:ss) rather than a hardcoded
  // "5 minutes" that a configured LEASE_RENEWAL_PROMPT_BEFORE would falsify.
  await expect(prompt).toContainText("under 05:00");
  await expect(panel.locator(".ab-lease-remaining")).toHaveClass(/ab-lease-soon/);

  // Renewing extends the lease and silences the prompt.
  await panel.locator(".ab-lease-renew").click();
  await expect(prompt).toBeHidden({ timeout: 20_000 });
  await expect(panel.locator(".ab-lease-remaining")).not.toHaveClass(/ab-lease-soon/);

  // Releasing hands the item back to the queue.
  await panel.locator(".ab-lease-release").click();
  await expect(panel).toBeHidden({ timeout: 20_000 });
  await expect(
    page.locator(`.ab-work-item[data-work-item-id="${item.id}"] .ab-claim-btn`),
  ).toBeVisible({ timeout: 20_000 });

  await context.close();
});

test("conflict path: a moved chapter is surfaced honestly and never clobbered", async ({
  browser,
}) => {
  // A published chapter (the-window is a draft and has no page).
  const contested = "which is to say";

  // Two suggestions over the SAME span → two work items with the same target.
  const first = await seedRangeSuggestion({
    login: "conflict-seeder-a",
    body: "Make this more direct.",
    exact: contested,
    chapterSlug: "null-results",
  });
  await voteToThreshold(first.annotationId, "conflict-voter-a");
  const second = await seedRangeSuggestion({
    login: "conflict-seeder-b",
    body: "Soften this instead.",
    exact: contested,
    chapterSlug: "null-results",
  });
  await voteToThreshold(second.annotationId, "conflict-voter-b");

  const maintainer = await loginCookie("conflict-maxine", "maintainer");
  const itemA = await waitForWorkItem(maintainer, first.annotationId);
  const itemB = await waitForWorkItem(maintainer, second.annotationId);

  // Hera claims B against the current revision and starts writing.
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, "conflict-hera", "editor");
  await claimInUi(page, itemB.id);
  const panel = page.locator(".ab-claim");
  await panel.locator("textarea").fill("meaning");

  // Meanwhile A lands, replacing exactly the span B is holding.
  const winner = "which means";
  await completeViaApi(itemA.id, winner);
  const afterWinner = await chapterFileText("002-null-results.md");
  expect(afterWinner).toContain(winner);

  // B submits: the pipeline commits a conflict record, not the edit.
  await panel.locator('button[type="submit"]').click();
  // The message carries the pipeline's OWN reason end-to-end rather than
  // asserting a cause the UI cannot know: the conflict path also catches
  // payloads the patch engine refused on an unmoved base, and reporting those
  // as "the chapter changed underneath it" was simply false.
  await expect(panel.locator(".ab-submit-conflict")).toContainText("could not be applied", {
    timeout: 60_000,
  });
  await expect(panel.locator(".ab-submit-conflict")).toContainText("target_missing");
  await expect(panel.locator(".ab-submit-conflict")).toContainText("left untouched");
  await expect(panel.locator(".ab-conflict-line")).toContainText("Conflict work item");
  const conflictId = await panel.locator(".ab-conflict-id").textContent();
  expect(conflictId).toMatch(/^[0-9a-f-]{36}$/);

  // The newer chapter is byte-intact: B's text never reached the file.
  expect(await chapterFileText("002-null-results.md")).toBe(afterWinner);
  expect(afterWinner).not.toContain("meaning");

  await rebuildSite();
  await context.close();
});

/**
 * Drive a work item to completion through the documented API only (the
 * "other editor" in the conflict test): claim → submit → wait for commit.
 */
async function completeViaApi(workItemId: string, replacement: string): Promise<void> {
  const api = process.env["AB_E2E_API_URL"] as string;
  const origin = process.env["AB_E2E_SITE_URL"] as string;
  const cookie = await loginCookie("conflict-rival", "editor");
  const base = `${api}/v1/projects/hollow-creek-anomaly/work-items/${workItemId}`;
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    origin,
    cookie,
  };

  const claimed = await fetch(`${base}/claim`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: "{}",
  });
  if (claimed.status !== 201) {
    throw new Error(`rival claim failed: ${claimed.status} ${await claimed.text()}`);
  }
  const bundle = (await claimed.json()) as {
    lease: { id: string; token: string };
    document: { revision: number; contentHash: string };
  };
  const submitted = await fetch(`${base}/submissions`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      leaseId: bundle.lease.id,
      leaseToken: bundle.lease.token,
      type: "range_replacement",
      baseRevision: bundle.document.revision,
      baseContentHash: bundle.document.contentHash,
      content: replacement,
    }),
  });
  if (submitted.status !== 202) {
    throw new Error(`rival submission failed: ${submitted.status} ${await submitted.text()}`);
  }
  const { operationId } = (await submitted.json()) as { operationId: string };
  const deadline = Date.now() + 60_000;
  for (;;) {
    const response = await fetch(
      `${api}/v1/projects/hollow-creek-anomaly/operations/${operationId}`,
      { headers: { cookie } },
    );
    if (response.ok) {
      const operation = (await response.json()) as { state: string; error: string | null };
      if (operation.state === "committed" || operation.state === "verified") {
        if (operation.error !== null) {
          throw new Error(`rival edit did not apply cleanly: ${operation.error}`);
        }
        return;
      }
      if (operation.state === "failed") {
        throw new Error(`rival edit failed: ${operation.error ?? "unknown"}`);
      }
    }
    if (Date.now() > deadline) {
      throw new Error("rival edit did not settle within 60s");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
