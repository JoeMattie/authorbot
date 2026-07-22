/**
 * Phase 7, end to end: the author-facing access control surface (contract
 * "Author-facing access control", exit criteria 6-10 as far as a browser can
 * see them).
 *
 * Four flows, one per thing an author actually needs to be able to do without
 * a database or a CLI: change the annotation policy and have it *take effect*,
 * clear the approval queue and watch an approved comment become public, remove
 * someone and be told what that does (and does not do), and freeze the book
 * while the published site keeps serving.
 *
 * ## Why the `zz-` prefix
 *
 * Playwright runs these specs serially against ONE book repo and ONE database
 * (workers: 1), in filename order. Everything in this file changes state that
 * is global to the book - the annotation policy decides whether every other
 * spec's comments publish or queue, and a freeze refuses every write in the
 * suite. Running last means a restore that somehow fails cannot take the rest
 * of the run down with it, and the `afterAll` below still puts the book back
 * the way it found it.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  PROJECT,
  apiUrl,
  chapterFacts,
  chapterUrl,
  devLogin,
  loginCookie,
  siteUrl,
} from "./helpers.js";

const CHAPTER = "null-results";
const MAINTAINER = "phase7-owner";
/** The collaborator test C removes. Created by signing them in once. */
const DEPARTING = "phase7-departing";
/** The outside contributor whose comment must be queued, then approved. */
const OUTSIDER = "phase7-outsider";

const QUEUED_COMMENT =
  "E2E queued comment: this passage needs a citation before it can stand.";

type AccessSection = "policy" | "collaborators" | "emergency" | "moderation" | "activity";

/** Open one focused section of the settings console. */
async function openSection(page: Page, section: AccessSection): Promise<void> {
  await expect(page.locator(".ab-access-body")).toBeAttached({ timeout: 30_000 });
  await page.locator(`[data-settings-target="${section}"]`).click();
  await expect(page.locator(`[data-console-section="${section}"]`)).toBeVisible({
    timeout: 30_000,
  });
}

/** Sign in as this book's maintainer and land on the requested access surface. */
async function openAccess(
  page: Page,
  section: AccessSection,
  login = MAINTAINER,
): Promise<void> {
  await page.goto(chapterUrl(CHAPTER));
  await devLogin(page, login, "maintainer");
  await page.goto(`${siteUrl()}/settings/`);
  await openSection(page, section);
}

/** Post a comment straight at the API and return the raw response. */
async function commentViaApi(
  cookie: string,
  body: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const facts = await chapterFacts(CHAPTER);
  const response = await fetch(
    `${apiUrl()}/v1/projects/${PROJECT}/chapters/${facts.chapterId}/annotations`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: siteUrl(),
        cookie,
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        kind: "comment",
        scope: "block",
        chapterRevision: facts.revision,
        target: { blockId: facts.blockId },
        body,
      }),
    },
  );
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

/** The book's current access state, read straight from the API. */
async function accessState(cookie: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${apiUrl()}/v1/projects/${PROJECT}/access`, {
    headers: { cookie },
  });
  return (await response.json()) as Record<string, unknown>;
}

/**
 * Set the annotation policy through the UI and wait for the commit to land.
 *
 * The wait is not politeness. The policy lives in `book.yml`, so changing it is
 * a commit, and the projection the enforcement gate reads updates only once
 * that commit lands - which is exactly why the interface refuses to claim the
 * new mode is already in force. A test that asserted enforcement immediately
 * would be asserting a lie the code deliberately does not tell.
 */
async function setPolicy(page: Page, policy: string, cookie: string): Promise<void> {
  await expect(async () => {
    await page.reload();
    await openSection(page, "policy");
    await expect(page.locator(".ab-policy-pending")).toHaveCount(0);
    await expect(page.locator(".ab-policy-apply")).toBeVisible();
  }).toPass({ timeout: 60_000 });

  const radio = page.locator(`input.ab-policy-radio[value="${policy}"]`);
  if (await radio.isChecked()) {
    return;
  }
  await radio.check();
  await expect(page.locator("button.ab-policy-apply")).toBeEnabled();
  await page.locator("button.ab-policy-apply").click();
  await expect(page.locator("p.ab-access-error")).toBeHidden();

  await expect(async () => {
    expect((await accessState(cookie))["annotationPolicy"]).toBe(policy);
  }).toPass({ timeout: 60_000 });
}

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  // Put the book back: an open policy and no freeze. Done against the API
  // rather than the UI so a failed test earlier in the file cannot leave the
  // repository in a state the next run inherits.
  const cookie = await loginCookie(MAINTAINER, "maintainer");
  const headers = {
    "content-type": "application/json",
    origin: siteUrl(),
    cookie,
    "idempotency-key": crypto.randomUUID(),
  };
  await fetch(`${apiUrl()}/v1/projects/${PROJECT}/access/unfreeze`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ reason: "e2e teardown" }),
  });
  await fetch(`${apiUrl()}/v1/projects/${PROJECT}/access/resume-agents`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ reason: "e2e teardown" }),
  });
  await fetch(`${apiUrl()}/v1/projects/${PROJECT}/settings`, {
    method: "PATCH",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ collaboration: { annotation_policy: null } }),
  });
});

// ===========================================================================
// A - the policy changes, and the change is enforced by the server
// ===========================================================================

test("a maintainer changes the annotation policy and the change takes effect", async ({ page }) => {
  const maintainerCookie = await loginCookie(MAINTAINER, "maintainer");
  await openAccess(page, "policy");

  // All four modes are offered at once, as the progression they are, each with
  // what it actually means - and `locked` says the book stays the author's,
  // never that collaboration is switched off.
  const policy = page.locator(".ab-access-policy");
  await expect(policy.locator("input.ab-policy-radio")).toHaveCount(4);
  const policyText = await policy.innerText();
  expect(policyText).toMatch(/Locked/);
  expect(policyText).toMatch(/Only maintainers may write/);
  expect(policyText).toMatch(/keep their membership/i);
  expect(policyText.toLowerCase()).not.toContain("turn off");
  // Anonymous writing is unavailable in every mode, `open` included.
  expect(policyText).toMatch(/anonymous/i);

  await setPolicy(page, "approval-gated", maintainerCookie);

  // Enforced SERVER-SIDE, not merely reflected in the interface: an outside
  // contributor's comment is queued rather than published.
  const outsiderCookie = await loginCookie(OUTSIDER, "contributor");
  const queued = await commentViaApi(outsiderCookie, QUEUED_COMMENT);
  expect(queued.status).toBe(202);
  expect(queued.json["status"]).toBe("pending_review");
  expect(queued.json["annotationId"]).toBeNull();

  // And the interface now shows the queue the mode produces.
  await page.reload();
  await openSection(page, "moderation");
  await expect(page.locator(".ab-access-moderation")).toBeVisible({ timeout: 30_000 });
});

// ===========================================================================
// B - the queue, and what approval actually does
// ===========================================================================

test("the approval queue shows a pending comment, and approving it makes it public", async ({
  page,
}) => {
  await openAccess(page, "moderation");
  const card = page.locator(".ab-pending", { hasText: QUEUED_COMMENT });
  await expect(card).toBeVisible({ timeout: 30_000 });

  // The contract's four things: the comment, its target passage, the author's
  // history with this book, and approve / reject.
  await expect(card.locator(".ab-pending-body")).toHaveText(QUEUED_COMMENT);
  await expect(card.locator(".ab-pending-target")).toContainText(/Null Results/i);
  await expect(card.locator(".ab-pending-history")).not.toBeEmpty();
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeVisible();

  // Nothing queued has reached Git - said plainly, because it is the whole
  // point of gating.
  await expect(page.locator(".ab-access-moderation")).toContainText(/reached your repository/i);

  await card.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.locator("p.ab-access-error")).toBeHidden();
  await expect(page.locator(".ab-access-status")).toContainText(/appears to readers/i, {
    timeout: 30_000,
  });

  // Approval mirrors it to Git as a normal annotation - so a SIGNED-OUT reader
  // sees it on the published chapter, which is the observable form of "it
  // appears publicly".
  const reader = await page.context().browser()?.newContext();
  const readerPage = await reader!.newPage();
  await expect(async () => {
    await readerPage.goto(chapterUrl(CHAPTER));
    await expect(readerPage.locator(".ab-card", { hasText: QUEUED_COMMENT })).toBeVisible({
      timeout: 5_000,
    });
  }).toPass({ timeout: 60_000 });
  await reader!.close();

  // The queue is now empty, and it says so rather than rendering an empty list.
  await page.reload();
  await openSection(page, "moderation");
  await expect(page.locator(".ab-pending", { hasText: QUEUED_COMMENT })).toHaveCount(0);
});

// ===========================================================================
// C - removal, confirmed with the consequence stated
// ===========================================================================

test("removing a collaborator is confirmed with the consequence stated", async ({ page }) => {
  // Give the book someone to remove.
  await loginCookie(DEPARTING, "contributor");
  await openAccess(page, "collaborators");

  const row = page.locator(".ab-collaborator", { hasText: DEPARTING });
  await expect(row).toBeVisible({ timeout: 30_000 });
  // Seeing: role, joined, added by, last acted - all four, in words.
  await expect(row).toContainText("Contributor");
  await expect(row.locator(".ab-access-facts")).toContainText("Joined");
  await expect(row.locator(".ab-access-facts")).toContainText("Last acted");

  await row.getByRole("button", { name: `Remove ${DEPARTING}` }).click();
  const confirm = row.locator(".ab-access-confirm");
  await expect(confirm).toBeVisible();

  // The consequence, stated before anything happens: access ends on the NEXT
  // REQUEST, claimed work returns to the queue…
  await expect(confirm).toContainText(/next request/i);
  await expect(confirm).toContainText(/returns to the queue/i);
  // …and - the sentence the contract makes non-negotiable - their existing
  // contributions and attribution remain.
  await expect(confirm).toContainText(/attribution stay exactly as they are/i);
  await expect(confirm).toContainText(/not erasing them/i);

  // Never default-yes: unticked, disabled, and the easy escape is the safe one.
  const check = confirm.locator("input.ab-confirm-check");
  await expect(check).not.toBeChecked();
  await expect(confirm.locator("button.ab-confirm-go")).toBeDisabled();
  await expect(confirm.locator("button.ab-confirm-cancel")).toHaveText("Keep access");

  // Backing out changes nothing at all.
  await confirm.locator("button.ab-confirm-cancel").click();
  await expect(row.locator(".ab-access-confirm")).toHaveCount(0);
  await page.reload();
  await openSection(page, "collaborators");
  await expect(page.locator(".ab-collaborator", { hasText: DEPARTING })).toBeVisible({
    timeout: 30_000,
  });

  // Confirm deliberately, and it happens - with the interface reporting what
  // the API actually did rather than a bare "done".
  const again = page.locator(".ab-collaborator", { hasText: DEPARTING });
  await again.getByRole("button", { name: `Remove ${DEPARTING}` }).click();
  await again.locator("input.ab-confirm-check").check();
  await expect(again.locator("button.ab-confirm-go")).toBeEnabled();
  await again.locator("button.ab-confirm-go").click();

  await expect(page.locator(".ab-access-status")).toContainText(/no longer has access/i, {
    timeout: 30_000,
  });
  await expect(page.locator(".ab-access-status")).toContainText(/not erasing them/i);
  await page.reload();
  await openSection(page, "collaborators");
  await expect(page.locator(".ab-collaborator", { hasText: DEPARTING })).toHaveCount(0, {
    timeout: 30_000,
  });

  // Removal is recorded, and the activity log says so in words.
  await openSection(page, "activity");
  await expect(page.locator(".ab-audit-list")).toContainText(/removed a collaborator/i);
});

// ===========================================================================
// D - freeze stops writes; the reading site is untouched
// ===========================================================================

test("freeze visibly stops writes while the reading site still serves", async ({ page }) => {
  const maintainerCookie = await loginCookie(MAINTAINER, "maintainer");
  await openAccess(page, "emergency");

  // Freeze is presented as an emergency control, and it is described honestly:
  // it stops the author too, and it leaves readers alone.
  const emergency = page.locator(".ab-access-emergency");
  await expect(emergency).toBeVisible();
  await expect(emergency).toContainText(/including you/i);
  await expect(emergency).toContainText(/readers are unaffected/i);
  // Pausing agents is a SEPARATE control, not the same switch.
  await expect(page.locator(".ab-access-agents")).toBeVisible();
  await expect(page.locator(".ab-access-freeze")).toBeVisible();

  // A reason and explicit acknowledgement are required in the confirmation.
  await page.locator("button.ab-access-freeze-btn").click();
  const freezeConfirm = page.getByRole("dialog", { name: "Freeze this book?" });
  await expect(freezeConfirm).toBeVisible();
  await freezeConfirm.locator("#ab-freeze-reason").fill("E2E: checking the emergency stop");
  await expect(freezeConfirm.locator("button.ab-confirm-go")).toBeDisabled();
  await freezeConfirm.locator("input.ab-confirm-check").check();
  await freezeConfirm.locator("button.ab-confirm-go").click();
  await expect(page.locator("p.ab-access-error")).toBeHidden();
  await expect(page.locator(".ab-access-status")).toContainText(/frozen/i, { timeout: 30_000 });

  // The state is visible, not merely reported once: a reload still says so, and
  // the reason a maintainer gave is shown to whoever reads it next.
  await page.reload();
  await openSection(page, "emergency");
  await expect(page.locator(".ab-access-is-frozen")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".ab-access-freeze")).toContainText(
    "E2E: checking the emergency stop",
  );

  // Writes are refused for EVERYONE, the maintainer who froze it included.
  const refused = await commentViaApi(maintainerCookie, "E2E: this must not be accepted.");
  expect(refused.status).toBe(423);
  expect(JSON.stringify(refused.json)).toMatch(/frozen/i);

  // Reads are unaffected and the published site keeps serving.
  const served = await fetch(chapterUrl(CHAPTER));
  expect(served.status).toBe(200);
  expect(await served.text()).toContain("Null Results");
  const readerContext = await page.context().browser()?.newContext();
  const readerPage = await readerContext!.newPage();
  await readerPage.goto(chapterUrl(CHAPTER));
  await expect(readerPage.locator("article.chapter h1")).toHaveText("Null Results");
  // No error chrome for a reader: a frozen book reads exactly like an open one.
  await expect(readerPage.locator(".ab-error:visible")).toHaveCount(0);
  await readerContext!.close();

  // Lift it, and writing resumes.
  await page.locator("button.ab-access-unfreeze").click();
  await expect(page.locator(".ab-access-status")).toContainText(/lifted/i, { timeout: 30_000 });
  await expect(async () => {
    expect((await accessState(maintainerCookie))["freeze"]).toMatchObject({ state: "open" });
  }).toPass({ timeout: 30_000 });
});
