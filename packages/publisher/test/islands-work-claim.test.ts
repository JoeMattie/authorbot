// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorbotWorkQueue } from "../site/src/islands/work-queue.js";
import {
  claimStorageKey,
  loadClaim,
  toStoredClaim,
} from "../site/src/islands/work-state.js";
import type { TaskBundle } from "../site/src/islands/api.js";
import {
  getProjectStore,
  resetProjectStoresForTests,
} from "../site/src/islands/project-store.js";

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

const completedWorkItem = (over: Record<string, unknown> = {}) => ({
  ...workItem({ status: "completed" }),
  source: {
    kind: "suggestion",
    scope: "range",
    body: "Tighten this passage without changing the point of view.",
    status: "work_item_created",
  },
  chapter: { id: CHAPTER_ID, title: "Baseline", slug: "baseline" },
  completedBy: {
    actorId: "actor-3",
    type: "agent",
    displayName: "Marin",
    externalIdentity: null,
  },
  completedAt: "2026-07-21T19:00:00.000Z",
  resultingRevision: 5,
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  revisionProposalId: "revision-1",
  approvedBy: {
    actorId: "actor-1",
    type: "human",
    displayName: "mara",
    externalIdentity: "github:mara",
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

let requests: { url: string; method: string; body: unknown; headers: Headers }[] = [];

function stubFetch(routes: Routes): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers: new Headers(init?.headers),
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

const queueRoutes = (
  items: unknown[],
  me: unknown = meEditor,
  completed: Route | (() => Route) = {
    status: 200,
    body: { items: [], nextCursor: null },
  },
): Routes => ({
  [`${API}/v1/me`]: { status: 200, body: me },
  [`${API}/v1/projects/${PROJECT}/work-items/completed`]: completed,
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
  resetProjectStoresForTests();
  requests = [];
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  window.sessionStorage.clear();
});

describe("work queue claim affordance (contract §7)", () => {
  it("does not let a superseded mount retain the project feed", async () => {
    let resolveSession!: (value: Response) => void;
    const pendingSession = new Promise<Response>((resolve) => {
      resolveSession = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/me")) return pendingSession;
      if (url.includes("/work-items?status=ready")) {
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/work-items/completed?")) {
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = getProjectStore({ apiBase: API, project: PROJECT });
    const release = vi.fn();
    const retain = vi
      .spyOn(store.getState(), "retainConnection")
      .mockReturnValue(release);
    const element = mount();

    await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
    element.remove();
    document.body.append(element);
    resolveSession(
      new Response(JSON.stringify(meEditor), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect.poll(() => element.querySelector(".ab-work-list")).toBeTruthy();
    await expect.poll(() => retain.mock.calls.length).toBe(1);
    element.remove();
    expect(release).toHaveBeenCalledTimes(1);
  });

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

  it("keeps open work first and pages compact completed stubs without changing the badge", async () => {
    let completedPage = 0;
    stubFetch(
      queueRoutes(
        [workItem()],
        meEditor,
        () =>
          completedPage++ === 0
            ? {
                status: 200,
                body: { items: [completedWorkItem()], nextCursor: "completed-cursor" },
              }
            : {
                status: 200,
                body: {
                  items: [
                    completedWorkItem({
                      id: "work-completed-2",
                      sourceAnnotationId: "annotation-2",
                      revisionProposalId: null,
                      commitSha: null,
                      resultingRevision: 6,
                    }),
                  ],
                  nextCursor: null,
                },
              },
      ),
    );
    const element = mount();

    await expect.poll(() => document.querySelectorAll(".ab-completed-item").length).toBe(1);
    expect(
      element.querySelector(".ab-work-active")?.nextElementSibling?.classList.contains(
        "ab-work-completed",
      ),
    ).toBe(true);
    const completed = document.querySelector<HTMLElement>(".ab-completed-item") as HTMLElement;
    expect(completed.querySelector(".ab-work-type")?.textContent).toBe("Revise passage");
    expect(completed.querySelector(".ab-completed-body")?.textContent).toContain(
      "Tighten this passage",
    );
    expect(completed.querySelector(".ab-completed-attribution")?.textContent).toContain(
      "Completed by Marin · 2026-07-21",
    );
    expect(completed.querySelector(".ab-completed-result")?.textContent).toContain(
      "Chapter revision 5 · Commit 0123456789ab · Approved by mara",
    );
    expect(
      completed.querySelector<HTMLAnchorElement>(".ab-completed-source")?.href,
    ).toContain(`authorbot-note-${completedWorkItem().sourceAnnotationId}`);
    expect(
      completed.querySelector(".ab-completed-revision")?.getAttribute("href"),
    ).toBe("../revisions/?proposal=revision-1");

    const badge = document.querySelector<HTMLElement>("[data-work-count]") as HTMLElement;
    expect(badge.textContent).toBe("1");
    const loadMore = document.querySelector<HTMLButtonElement>(
      ".ab-completed-more-button",
    ) as HTMLButtonElement;
    expect(loadMore.hidden).toBe(false);
    loadMore.click();

    await expect.poll(() => document.querySelectorAll(".ab-completed-item").length).toBe(2);
    expect(document.querySelector(".ab-completed-more")?.hasAttribute("hidden")).toBe(true);
    expect(badge.textContent).toBe("1");
    expect(requests.some(({ url }) => url.endsWith(
      "/work-items/completed?limit=20&cursor=completed-cursor",
    ))).toBe(true);
  });

  it("clears private rows and claim controls when the browser credential changes", async () => {
    let currentMe: unknown = meEditor;
    stubFetch({
      [`${API}/v1/me`]: () => ({ status: 200, body: currentMe }),
      [`${API}/v1/projects/${PROJECT}/work-items/completed`]: () =>
        currentMe === meEditor
          ? { status: 200, body: { items: [], nextCursor: null } }
          : { status: 403, body: { detail: "work:read required" } },
      [`${API}/v1/projects/${PROJECT}/work-items`]: () =>
        currentMe === meEditor
          ? { status: 200, body: { items: [workItem()], nextCursor: null } }
          : { status: 403, body: { detail: "work:read required" } },
    });
    mount();
    await expect.poll(() => document.querySelectorAll(".ab-work-item").length).toBe(1);
    expect(claimButton()).toBeTruthy();

    currentMe = meReader;
    await getProjectStore({ apiBase: API, project: PROJECT }).getState().refreshSession(true);

    await expect.poll(() => document.querySelectorAll(".ab-work-item").length).toBe(0);
    expect(document.querySelector(".ab-claim-btn")).toBeNull();
    expect(document.querySelector(".ab-work-status")?.textContent).toBe(
      "Your role cannot view the work queue.",
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
    [`${API}/v1/projects/${PROJECT}/work-items/${WORK_ITEM_ID}/lease/recover`]: {
      status: 200,
      body: {
        workItemId: WORK_ITEM_ID,
        lease: {
          id: LEASE_ID,
          token: "rotated-token-never-persisted",
          expiresAt: "2026-07-19T19:00:00.000Z",
          maxExpiresAt: "2026-07-19T22:00:00.000Z",
          renewalCount: 0,
          renewalPromptAt: "2026-07-19T18:55:00.000Z",
        },
        correlationId: "corr-recover",
      },
    },
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
    // The persisted refresh state contains no capability material.
    expect(window.sessionStorage.getItem(claimStorageKey(PROJECT))).not.toContain(TOKEN);
  });

  it("makes an open claim read-only when the signed-in credential changes", async () => {
    let currentMe: unknown = meEditor;
    stubFetch(
      claimRoutes({
        [`${API}/v1/me`]: () => ({ status: 200, body: currentMe }),
      }),
    );
    await claimIt();
    const textarea = panel().querySelector("textarea") as HTMLTextAreaElement;
    const summary = panel().querySelector('input[name="summary"]') as HTMLInputElement;
    textarea.value = "A private draft that must stop with the old credential.";
    textarea.dispatchEvent(new Event("input"));
    expect(window.sessionStorage.getItem(claimStorageKey(PROJECT))).not.toBeNull();

    currentMe = meReader;
    const store = getProjectStore({ apiBase: API, project: PROJECT });
    await store.getState().refreshSession(true);

    expect(store.getState().activeClaimsByWorkItem[WORK_ITEM_ID]).toBeUndefined();
    expect(store.getState().claimInvalidationsByWorkItem[WORK_ITEM_ID]).toContain(
      "signed-in credential changed",
    );
    expect(textarea.readOnly).toBe(true);
    expect(summary.readOnly).toBe(true);
    expect((panel().querySelector(".ab-lease-renew") as HTMLButtonElement).disabled).toBe(true);
    expect((panel().querySelector(".ab-lease-release") as HTMLButtonElement).disabled).toBe(true);
    expect((panel().querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect(panel().querySelector(".ab-submit-expired")?.textContent).toContain(
      "lease can no longer be used here",
    );
    expect(panel().querySelector(".ab-submit-expired")?.textContent).toContain("read-only");
    expect(window.sessionStorage.getItem(claimStorageKey(PROJECT))).toBeNull();
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
    // No second claim was issued. The same credential rotated the saved
    // lease id into a fresh in-memory token instead.
    expect(requests.filter((request) => request.url.endsWith("/claim")).length).toBe(0);
    expect(requests.filter((request) => request.url.endsWith("/lease/recover"))).toHaveLength(1);
    expect(window.sessionStorage.getItem(claimStorageKey(PROJECT))).not.toContain(
      "rotated-token-never-persisted",
    );
  });

  it("scrubs a legacy token even when credential-bound recovery fails", async () => {
    const legacy = {
      ...toStoredClaim(bundle(), "draft from the old release"),
      lease: { ...bundle().lease },
    };
    window.sessionStorage.setItem(claimStorageKey(PROJECT), JSON.stringify(legacy));
    expect(window.sessionStorage.getItem(claimStorageKey(PROJECT))).toContain(TOKEN);
    stubFetch(
      claimRoutes({
        [`${API}/v1/projects/${PROJECT}/work-items/${WORK_ITEM_ID}/lease/recover`]: {
          status: 403,
          body: { detail: "the saved credential cannot recover this lease" },
        },
      }),
    );

    mount();

    await expect.poll(() => document.querySelector(".ab-work-status")?.textContent).toContain(
      "could not be recovered",
    );
    const raw = window.sessionStorage.getItem(claimStorageKey(PROJECT));
    expect(raw).not.toContain(TOKEN);
    expect(JSON.parse(raw ?? "null")?.lease).not.toHaveProperty("token");
    expect(loadClaim(window.sessionStorage, PROJECT)?.draft).toBe("draft from the old release");
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

  it("does not turn its own event-before-response submission into an external lease loss", async () => {
    let polls = 0;
    stubFetch(
      submitRoutes(() => {
        polls += 1;
        return polls < 2
          ? { status: 200, body: { id: OPERATION_ID, state: "queued", error: null } }
          : {
              status: 200,
              body: {
                id: OPERATION_ID,
                state: "committed",
                error: null,
                commitSha: "abc123",
              },
            };
      }),
    );
    await claimAndSubmit("vanished on a Tuesday");

    const submission = requests.find((request) => request.url.endsWith("/submissions"));
    const correlationId = submission?.headers.get("x-correlation-id");
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/u);
    const store = getProjectStore({ apiBase: API, project: PROJECT });
    store.getState().reconcileEvent({
      id: 90,
      type: "submission_received",
      payload: {
        workItemId: WORK_ITEM_ID,
        submissionId: "sub-1",
        operationId: OPERATION_ID,
        correlationId,
      },
    });
    store.getState().reconcileEvent({
      id: 91,
      type: "work_item_completed",
      payload: { workItemId: WORK_ITEM_ID, submissionId: "sub-1" },
    });

    expect(panel().querySelector(".ab-submit-expired")).toBeNull();
    expect(store.getState().claimInvalidationsByWorkItem[WORK_ITEM_ID]).toBeUndefined();
    await expect
      .poll(() => document.querySelector(".ab-submit-completed")?.textContent, {
        timeout: 10_000,
      })
      .toContain("Completed");
    expect(panel().textContent).not.toContain("another session");
    expect(panel().textContent).not.toContain("draft is now read-only");
  });

  it("settles from its own accepted event after both submission responses are lost", async () => {
    const routes = submitRoutes(() => ({
      status: 200,
      body: {
        id: OPERATION_ID,
        state: "committed",
        error: null,
        commitSha: "abc123",
      },
    }));
    routes[`${API}/v1/projects/${PROJECT}/work-items/${WORK_ITEM_ID}/submissions`] = {
      status: 503,
      body: { detail: "the accepted response was lost at the gateway" },
    };
    stubFetch(routes);
    await claimAndSubmit("vanished on a Tuesday");

    await expect
      .poll(() => requests.filter((request) => request.url.endsWith("/submissions")).length)
      .toBe(2);
    await expect.poll(() => panel().querySelector(".ab-error")?.textContent).toContain(
      "accepted response was lost",
    );
    const submission = requests.find((request) => request.url.endsWith("/submissions"));
    const correlationId = submission?.headers.get("x-correlation-id");
    const store = getProjectStore({ apiBase: API, project: PROJECT });
    store.getState().reconcileEvent({
      id: 92,
      type: "submission_received",
      payload: {
        workItemId: WORK_ITEM_ID,
        submissionId: "sub-lost-response",
        operationId: OPERATION_ID,
        correlationId,
      },
    });
    store.getState().reconcileEvent({
      id: 93,
      type: "work_item_completed",
      payload: { workItemId: WORK_ITEM_ID, submissionId: "sub-lost-response" },
    });

    await expect
      .poll(() => panel().querySelector(".ab-submit-completed")?.textContent, {
        timeout: 10_000,
      })
      .toContain("Completed");
    expect(window.sessionStorage.getItem(claimStorageKey(PROJECT))).toBeNull();
    expect(store.getState().activeClaimsByWorkItem[WORK_ITEM_ID]).toBeUndefined();
    expect(store.getState().claimInvalidationsByWorkItem[WORK_ITEM_ID]).toBeUndefined();
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
 * Claims are stored per PROJECT, so a second claim in the same tab would still
 * overwrite the first in-progress draft even though capability material now
 * stays in memory only.
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
    expect(stored?.workItemId).toBe(WORK_ITEM_ID);

    // Every remaining row must now offer a hint, not a live Claim button.
    await expect.poll(() => document.querySelectorAll(".ab-claim-btn").length).toBe(0);
    const hints = [...document.querySelectorAll(".ab-work-hint")].map((n) => n.textContent ?? "");
    expect(hints.some((h) => h.includes("already have a work item claimed"))).toBe(true);

    // The first draft metadata survives without persisting its token.
    expect(loadClaim(window.sessionStorage, PROJECT)?.workItemId).toBe(WORK_ITEM_ID);
    expect(window.sessionStorage.getItem(claimStorageKey(PROJECT))).not.toContain(TOKEN);
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
