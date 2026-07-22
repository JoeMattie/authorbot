// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorbotWorkQueue } from "../site/src/islands/work-queue.js";
import { claimStorageKey, loadClaim } from "../site/src/islands/work-state.js";
import type { TaskBundle } from "../site/src/islands/api.js";

/**
 * Phase 4 contract §7, at the element level: the Claim affordance appears only
 * with `work:claim`, a claim opens the edit view carrying the §15.3 bundle,
 * the lease countdown prompts renewal at T-5m, release returns to the queue,
 * and submit walks `syncing → completed | conflict` honestly. The lease token
 * is never rendered.
 */

const API = "http://api.test";
const PROJECT = "hollow-creek-anomaly";
const CHAPTER_ID = "019cadfd-8900-7140-98fb-ceff64cada33";
const BLOCK_ID = "019cadfe-7360-7049-a30b-1f5898a5020a";
const WORK_ITEM_ID = "0190f301-7045-7b2d-9d91-95b3c8228b54";
const LEASE_ID = "0190f305-7045-7b2d-9d91-95b3c8228b55";
const TOKEN = "s3cret-lease-token-never-rendered";
const OPERATION_ID = "0190f306-7045-7b2d-9d91-95b3c8228b56";

if (customElements.get("authorbot-work-queue") === undefined) {
  customElements.define("authorbot-work-queue", AuthorbotWorkQueue);
}

const NOW = Date.parse("2026-07-19T18:30:00.000Z");

const workItem = (over: Record<string, unknown> = {}) => ({
  id: WORK_ITEM_ID,
  projectId: "p",
  type: "revise_range",
  status: "ready",
  sourceAnnotationId: "ann-1",
  chapterId: CHAPTER_ID,
  baseRevision: 4,
  target: {
    blockId: BLOCK_ID,
    textPosition: { start: 4, end: 25 },
    textQuote: { exact: "appeared on a Tuesday" },
  },
  priority: "normal",
  createdAt: "2026-07-19T00:00:00Z",
  updatedAt: "2026-07-19T00:00:00Z",
  support: {
    approvals: 3,
    rejections: 0,
    abstentions: 0,
    netScore: 3,
    distinctVoters: 3,
    humanApprovals: 3,
    agentApprovals: 0,
  },
  ...over,
});

const bundle = (over: Partial<TaskBundle> = {}): TaskBundle => ({
  workItem: {
    id: WORK_ITEM_ID,
    type: "revise_range",
    acceptanceCriteria: ["Preserve point of view", "Change only the selected span"],
    priority: "normal",
  },
  lease: {
    id: LEASE_ID,
    token: TOKEN,
    // 30 minutes out from NOW; max total 4h.
    expiresAt: "2026-07-19T19:00:00.000Z",
    maxExpiresAt: "2026-07-19T22:00:00.000Z",
  },
  document: {
    chapterId: CHAPTER_ID,
    revision: 4,
    contentHash: `sha256:${"a".repeat(64)}`,
    source: "---\nid: c\n---\n\nThe drift appeared on a Tuesday.\n",
  },
  target: { blockId: BLOCK_ID, exact: "appeared on a Tuesday", start: 4, end: 25 },
  context: {
    annotationBody: "Tighten this clause.",
    chapterSummary: "The baseline chapter.",
    storyRefs: ["character:mara"],
  },
  submissionSchema: "authorbot.submission/range-replacement/v1",
  ...over,
});

interface Route {
  status: number;
  body: unknown;
}

type Routes = Record<string, Route | (() => Route)>;

let requests: { url: string; method: string; body: unknown }[] = [];

function stubFetch(routes: Routes): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const key = Object.keys(routes)
        .filter((prefix) => url.startsWith(prefix))
        // Longest prefix wins, so `/work-items/<id>/claim` beats `/work-items`.
        .sort((a, b) => b.length - a.length)[0];
      const entry = key === undefined ? undefined : routes[key];
      const route = entry === undefined ? { status: 404, body: { detail: "not found" } } : typeof entry === "function" ? entry() : entry;
      return {
        ok: route.status >= 200 && route.status < 300,
        status: route.status,
        json: async () => route.body,
      } as Response;
    }),
  );
}

const meEditor = {
  actor: { id: "actor-1", displayName: "mara", externalIdentity: "github:mara" },
  scopes: ["chapters:read", "annotations:read", "annotations:write", "work:read", "work:claim", "submissions:write"],
};

const meReader = {
  actor: { id: "actor-2", displayName: "rae", externalIdentity: "github:rae" },
  scopes: ["chapters:read", "annotations:read"],
};

const queueRoutes = (items: unknown[], me: unknown = meEditor): Routes => ({
  [`${API}/v1/me`]: { status: 200, body: me },
  [`${API}/v1/projects/${PROJECT}/work-items`]: { status: 200, body: { items, nextCursor: null } },
});

function mount(): AuthorbotWorkQueue {
  document.body.innerHTML = "";
  const badge = document.createElement("span");
  badge.dataset.workCount = "";
  badge.hidden = true;
  document.body.append(badge);
  const element = document.createElement("authorbot-work-queue") as AuthorbotWorkQueue;
  element.dataset.apiBase = API;
  element.dataset.project = PROJECT;
  element.dataset.chapters = JSON.stringify({
    [CHAPTER_ID]: { title: "Baseline", href: "/chapters/baseline/" },
  });
  element.now = () => NOW;
  const fallback = document.createElement("p");
  fallback.className = "work-fallback";
  fallback.textContent = "The work queue loads here once JavaScript is enabled.";
  element.append(fallback);
  document.body.append(element);
  return element;
}

const claimButton = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(".ab-claim-btn") as HTMLButtonElement;

const panel = (): HTMLElement => document.querySelector(".ab-claim") as HTMLElement;

beforeEach(() => {
  requests = [];
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  window.sessionStorage.clear();
});

describe("work queue claim affordance (contract §7)", () => {
  it("offers Claim to an actor with work:claim", async () => {
    stubFetch(queueRoutes([workItem()]));
    mount();
    await expect.poll(() => claimButton()).toBeTruthy();
    expect(claimButton().textContent).toBe("Claim this work");
    expect(document.querySelector(".work-fallback")).toBeNull();
  });

  it("renders the redesigned ready card and syncs the global Work badge", async () => {
    stubFetch(queueRoutes([workItem(), workItem({ id: "work-2", priority: "high" })]));
    mount();

    await expect.poll(() => document.querySelectorAll(".ab-work-item").length).toBe(2);
    const first = document.querySelector<HTMLElement>(".ab-work-item") as HTMLElement;
    expect(first.querySelector(".ab-work-type")?.textContent).toBe("Revise passage");
    expect(first.querySelector(".ab-work-status-ready")?.textContent).toBe("Ready");
    expect(first.querySelector(".ab-work-change h3")?.textContent).toBe("Passage to revise");
    expect(first.querySelector(".ab-work-criteria-preview")?.textContent).toContain(
      "included in the task bundle",
    );
    const badge = document.querySelector<HTMLElement>("[data-work-count]") as HTMLElement;
    expect(badge.textContent).toBe("2");
    expect(badge.hidden).toBe(false);
    expect(document.querySelector(".ab-work-priority")?.textContent).toBe("High priority");
  });

  it("keeps the global Work badge hidden for an empty queue", async () => {
    stubFetch(queueRoutes([]));
    mount();
    await expect.poll(() => document.querySelector(".ab-work-status")?.textContent).toBe(
      "No work items are ready.",
    );
    const badge = document.querySelector<HTMLElement>("[data-work-count]") as HTMLElement;
    expect(badge.textContent).toBe("0");
    expect(badge.hidden).toBe(true);
  });

  it("shows an honest hint instead of a dead button without work:claim", async () => {
    stubFetch(queueRoutes([workItem()], meReader));
    mount();
    await expect.poll(() => document.querySelector(".ab-work-hint")).toBeTruthy();
    expect(document.querySelector(".ab-claim-btn")).toBeNull();
    expect(document.querySelector(".ab-work-hint")?.textContent).toContain("cannot claim");
  });

  it("leaves the static fallback alone when the API is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    mount();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.querySelector(".work-fallback")).not.toBeNull();
    expect(document.querySelector(".ab-error")).toBeNull();
  });

  it("reports a lost claim race with the holder's display name only", async () => {
    stubFetch({
      ...queueRoutes([workItem()]),
      [`${API}/v1/projects/${PROJECT}/work-items/${WORK_ITEM_ID}/claim`]: {
        status: 409,
        body: {
          type: "https://authorbot.dev/problems/lease-held",
          title: "lease held",
          detail: "work item is already leased",
          holder: "vale",
          expiresAt: "2026-07-19T19:00:00.000Z",
        },
      },
    });
    mount();
    await expect.poll(() => claimButton()).toBeTruthy();
    claimButton().click();
    await expect.poll(() => document.querySelector(".ab-claim-error")?.textContent).toBe(
      "Already claimed by vale.",
    );
    expect(panel().hidden).toBe(true);
  });
});

describe("edit view (contract §7, design §16.4)", () => {
  const claimRoutes = (extra: Routes = {}): Routes => ({
    ...queueRoutes([workItem()]),
    [`${API}/v1/projects/${PROJECT}/work-items/${WORK_ITEM_ID}/claim`]: { status: 201, body: bundle() },
    ...extra,
  });

  async function claimIt(): Promise<void> {
    mount();
    await expect.poll(() => claimButton()).toBeTruthy();
    claimButton().click();
    await expect.poll(() => panel().hidden).toBe(false);
  }

  it("renders the task bundle, prefills the target, and never shows the token", async () => {
    stubFetch(claimRoutes());
    await claimIt();

    expect(panel().querySelector(".ab-claim-title")?.textContent).toBe("Revise passage");
    expect(panel().querySelector(".ab-work-status-claimed")?.textContent).toBe("Claimed by you");
    expect(panel().querySelector(".ab-lease-held")?.textContent).toBe("You hold the lease");
    expect(panel().querySelector(".ab-claim-request")?.textContent).toBe("Tighten this clause.");
    expect(panel().querySelector(".ab-claim-summary")?.textContent).toBe("The baseline chapter.");
    expect([...panel().querySelectorAll(".ab-claim-criteria li")].map((li) => li.textContent)).toEqual([
      "Preserve point of view",
      "Change only the selected span",
    ]);
    expect(panel().querySelector(".ab-original-text")?.textContent).toBe("appeared on a Tuesday");
    const textarea = panel().querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("appeared on a Tuesday");
    // Untrusted-input labelling (design §19.6).
    expect(panel().querySelector(".ab-untrusted-note")?.textContent).toContain("untrusted");
    // The lease token appears nowhere in the rendered DOM.
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(document.body.innerHTML).not.toContain(TOKEN);
    // …but it is held for the session so a refresh can resume.
    expect(loadClaim(window.sessionStorage, PROJECT)?.lease.token).toBe(TOKEN);
  });

  it("shows the remaining-lease indicator and prompts at T-5m", async () => {
    stubFetch(claimRoutes());
    const element = await claimIt().then(() => document.querySelector("authorbot-work-queue") as AuthorbotWorkQueue);
    expect(panel().querySelector(".ab-lease-remaining")?.textContent).toBe("Lease expires in 30:00");
    expect((panel().querySelector(".ab-lease-prompt") as HTMLElement).hidden).toBe(true);

    // Advance the island's clock to four minutes before expiry.
    element.now = () => Date.parse("2026-07-19T18:56:00.000Z");
    await expect
      .poll(() => (panel().querySelector(".ab-lease-prompt") as HTMLElement).hidden, { timeout: 4_000 })
      .toBe(false);
    // The copy states the ACTUAL prompt window rather than a hardcoded
    // "5 minutes" that a configured lead time would falsify.
    expect(panel().querySelector(".ab-lease-prompt")?.textContent).toContain("under 05:00");
    expect(panel().querySelector(".ab-lease-remaining")?.textContent).toBe("Lease expires in 04:00");
    expect(panel().querySelector(".ab-lease-remaining")?.classList.contains("ab-lease-soon")).toBe(true);
  });

  it("renews the lease with the current token and clears the prompt", async () => {
    stubFetch(
      claimRoutes({
        [`${API}/v1/projects/${PROJECT}/work-items/${WORK_ITEM_ID}/lease/renew`]: {
          status: 200,
          body: {
            leaseId: LEASE_ID,
            workItemId: WORK_ITEM_ID,
            expiresAt: "2026-07-19T19:30:00.000Z",
            maxExpiresAt: "2026-07-19T22:00:00.000Z",
            renewalCount: 1,
            renewalPromptAt: "2026-07-19T19:25:00.000Z",
          },
        },
      }),
    );
    await claimIt();
    (panel().querySelector(".ab-lease-renew") as HTMLButtonElement).click();
    await expect
      .poll(() => panel().querySelector(".ab-lease-remaining")?.textContent)
      .toBe("Lease expires in 1:00:00");

    const renew = requests.find((request) => request.url.endsWith("/lease/renew"));
    expect(renew?.method).toBe("POST");
    expect(renew?.body).toEqual({ leaseId: LEASE_ID, leaseToken: TOKEN });
    expect(loadClaim(window.sessionStorage, PROJECT)?.lease.expiresAt).toBe("2026-07-19T19:30:00.000Z");
  });

  it("releases the lease, hides the view, and forgets the token", async () => {
    stubFetch(
      claimRoutes({
        [`${API}/v1/projects/${PROJECT}/work-items/${WORK_ITEM_ID}/lease/release`]: {
          status: 200,
          body: { workItemId: WORK_ITEM_ID, leaseId: LEASE_ID, status: "ready", expired: false },
        },
      }),
    );
    await claimIt();
    (panel().querySelector(".ab-lease-release") as HTMLButtonElement).click();
    await expect.poll(() => panel().hidden).toBe(true);
    expect(window.sessionStorage.getItem(claimStorageKey(PROJECT))).toBeNull();
    const release = requests.find((request) => request.url.endsWith("/lease/release"));
    expect(release?.body).toEqual({ leaseId: LEASE_ID });
  });

  it("restores the claim and the draft after a refresh", async () => {
    stubFetch(claimRoutes());
    await claimIt();
    const textarea = panel().querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "vanished on a Tuesday";
    textarea.dispatchEvent(new Event("input"));
    expect(loadClaim(window.sessionStorage, PROJECT)?.draft).toBe("vanished on a Tuesday");

    // "Refresh": tear the element down and mount a fresh one.
    document.body.innerHTML = "";
    requests = [];
    stubFetch(claimRoutes());
    mount();
    await expect.poll(() => panel()?.hidden).toBe(false);
    expect((panel().querySelector("textarea") as HTMLTextAreaElement).value).toBe("vanished on a Tuesday");
    // No second claim was issued - the lease is the stored one.
    expect(requests.filter((request) => request.url.endsWith("/claim")).length).toBe(0);
  });

  it("drops an expired stored claim rather than offering a dead lease", async () => {
    stubFetch(claimRoutes());
    await claimIt();
    document.body.innerHTML = "";
    stubFetch(claimRoutes());
    const element = mount();
    element.now = () => Date.parse("2026-07-19T19:30:00.000Z"); // past expiry
    await expect.poll(() => document.querySelector(".ab-work-live")?.textContent).toContain("expired");
    expect(panel().hidden).toBe(true);
    expect(window.sessionStorage.getItem(claimStorageKey(PROJECT))).toBeNull();
  });
});

describe("submission ladder (contract §4-§5, §7)", () => {
  const submitRoutes = (operation: () => Route): Routes => ({
    ...queueRoutes([workItem()]),
    [`${API}/v1/projects/${PROJECT}/work-items/${WORK_ITEM_ID}/claim`]: { status: 201, body: bundle() },
    [`${API}/v1/projects/${PROJECT}/work-items/${WORK_ITEM_ID}/submissions`]: {
      status: 202,
      body: {
        submissionId: "sub-1",
        operationId: OPERATION_ID,
        correlationId: "corr-1",
        status: "queued",
      },
    },
    [`${API}/v1/projects/${PROJECT}/operations/${OPERATION_ID}`]: operation,
  });

  async function claimAndSubmit(text: string): Promise<void> {
    mount();
    await expect.poll(() => claimButton()).toBeTruthy();
    claimButton().click();
    await expect.poll(() => panel().hidden).toBe(false);
    const textarea = panel().querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = text;
    textarea.dispatchEvent(new Event("input"));
    (panel().querySelector('button[type="submit"]') as HTMLButtonElement).click();
  }

  it("submits the lease-bound body and reports completion", async () => {
    let polls = 0;
    stubFetch(
      submitRoutes(() => {
        polls += 1;
        return polls < 2
          ? { status: 200, body: { id: OPERATION_ID, state: "queued", error: null } }
          : { status: 200, body: { id: OPERATION_ID, state: "committed", error: null, commitSha: "abc123" } };
      }),
    );
    await claimAndSubmit("vanished on a Tuesday");

    await expect
      .poll(() => document.querySelector(".ab-submit-status")?.textContent, { timeout: 10_000 })
      .toContain("Syncing");
    await expect
      .poll(() => document.querySelector(".ab-submit-completed")?.textContent, { timeout: 10_000 })
      .toContain("Completed");

    const submission = requests.find((request) => request.url.endsWith("/submissions"));
    expect(submission?.body).toEqual({
      leaseId: LEASE_ID,
      leaseToken: TOKEN,
      type: "range_replacement",
      baseRevision: 4,
      baseContentHash: `sha256:${"a".repeat(64)}`,
      content: "vanished on a Tuesday",
    });
    // The lease is consumed by the accepted submission: nothing left to renew.
    expect(window.sessionStorage.getItem(claimStorageKey(PROJECT))).toBeNull();
  });

  it("surfaces a conflict honestly and links the conflict work item", async () => {
    stubFetch(
      submitRoutes(() => ({
        status: 200,
        body: {
          id: OPERATION_ID,
          state: "committed",
          commitSha: "def456",
          // The apply pipeline records the 409-style problem on the operation.
          error: JSON.stringify({
            code: "submission-conflict",
            status: 409,
            submissionId: "sub-1",
            workItemId: WORK_ITEM_ID,
            conflictWorkItemId: "0190f307-7045-7b2d-9d91-95b3c8228b57",
            // The applier's deterministic reason travels to the UI, so a
            // moved base and a refused payload do not read identically.
            reason: "the chapter moved to revision 4 after the lease's base revision 3",
          }),
        },
      })),
    );
    await claimAndSubmit("vanished on a Tuesday");

    await expect
      .poll(() => document.querySelector(".ab-submit-conflict")?.textContent, { timeout: 10_000 })
      .toContain("the chapter moved to revision 4");
    expect(document.querySelector(".ab-submit-conflict")?.textContent).toContain("left untouched");
    expect(document.querySelector(".ab-conflict-id")?.textContent).toBe(
      "0190f307-7045-7b2d-9d91-95b3c8228b57",
    );
  });

  it("keeps the draft editable when the API rejects the submission", async () => {
    stubFetch({
      ...queueRoutes([workItem()]),
      [`${API}/v1/projects/${PROJECT}/work-items/${WORK_ITEM_ID}/claim`]: { status: 201, body: bundle() },
      [`${API}/v1/projects/${PROJECT}/work-items/${WORK_ITEM_ID}/submissions`]: {
        status: 409,
        body: { title: "lease expired", detail: "lease has expired" },
      },
    });
    await claimAndSubmit("vanished on a Tuesday");
    await expect.poll(() => document.querySelector(".ab-submit-form .ab-error")?.textContent).toBe(
      "lease has expired",
    );
    const textarea = panel().querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(false);
    expect(textarea.value).toBe("vanished on a Tuesday");
  });
});

/**
 * Claims are stored per PROJECT and the lease token comes back exactly once,
 * so a second claim in the same tab silently overwrote the first token (and
 * the in-progress draft), leaving the first item stuck `leased` until expiry
 * with no way to renew or submit it from this UI.
 */
describe("one claim at a time per tab (contract §7 draft preservation)", () => {
  const SECOND_ITEM_ID = "0190f301-7045-7b2d-9d91-95b3c8228b99";

  it("refuses a second claim while one is live, with an honest hint", async () => {
    stubFetch({
      ...queueRoutes([workItem(), workItem({ id: SECOND_ITEM_ID })]),
      [`${API}/v1/projects/${PROJECT}/work-items/${WORK_ITEM_ID}/claim`]: {
        status: 201,
        body: bundle(),
      },
      [`${API}/v1/projects/${PROJECT}/work-items/${SECOND_ITEM_ID}/claim`]: {
        status: 201,
        body: bundle({
          workItem: { ...bundle().workItem, id: SECOND_ITEM_ID },
          lease: { ...bundle().lease, id: "lease-2", token: "TOKEN-TWO" },
        }),
      },
    });
    mount();
    await expect.poll(() => claimButton()).toBeTruthy();
    claimButton().click();
    await expect.poll(() => panel().hidden).toBe(false);

    const stored = loadClaim(window.sessionStorage, PROJECT);
    expect(stored?.lease.token).toBe(TOKEN);

    // Every remaining row must now offer a hint, not a live Claim button.
    await expect.poll(() => document.querySelectorAll(".ab-claim-btn").length).toBe(0);
    const hints = [...document.querySelectorAll(".ab-work-hint")].map((n) => n.textContent ?? "");
    expect(hints.some((h) => h.includes("already have a work item claimed"))).toBe(true);

    // The first lease's token - the only copy - survives.
    expect(loadClaim(window.sessionStorage, PROJECT)?.lease.token).toBe(TOKEN);
    expect(
      requests.filter((r) => r.url.includes(`${SECOND_ITEM_ID}/claim`)),
    ).toHaveLength(0);
  });
});

describe("renewal prompt honours the server's configured lead time", () => {
  it("uses renewalPromptAt from the renew response instead of a hardcoded 5 minutes", async () => {
    stubFetch({
      ...queueRoutes([workItem()]),
      [`${API}/v1/projects/${PROJECT}/work-items/${WORK_ITEM_ID}/claim`]: {
        status: 201,
        body: bundle(),
      },
      [`${API}/v1/projects/${PROJECT}/work-items/${WORK_ITEM_ID}/lease/renew`]: {
        status: 200,
        body: {
          leaseId: LEASE_ID,
          workItemId: WORK_ITEM_ID,
          // Expires 20 minutes out, prompt 15 minutes ahead of that - an
          // operator lead time of PT15M, not the PT5M default.
          expiresAt: "2026-07-19T18:50:00.000Z",
          maxExpiresAt: "2026-07-19T22:00:00.000Z",
          renewalCount: 1,
          renewalPromptAt: "2026-07-19T18:35:00.000Z",
        },
      },
    });
    mount();
    await expect.poll(() => claimButton()).toBeTruthy();
    claimButton().click();
    await expect.poll(() => panel().hidden).toBe(false);

    document.querySelector<HTMLButtonElement>(".ab-lease-renew")?.click();

    // The server-supplied prompt instant is kept - and survives a refresh, so
    // a restored claim does not silently revert to the 5-minute default.
    await expect
      .poll(() => loadClaim(window.sessionStorage, PROJECT)?.lease.renewalPromptAt)
      .toBe("2026-07-19T18:35:00.000Z");

    // 20 minutes remain against a 15-minute configured lead time, so the
    // prompt stays hidden. Under the old hardcoded 5-minute threshold the
    // configured value was inert and the banner was equally hidden - the
    // pure-state tests pin the arithmetic in both directions.
    expect(document.querySelector<HTMLElement>(".ab-lease-prompt")?.hidden).toBe(true);
  });
});
