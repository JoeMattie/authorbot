// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorbotCollab } from "../site/src/islands/collab-element.js";
import { resetProjectStoresForTests } from "../site/src/islands/project-store.js";
import { VoteControl } from "../site/src/islands/vote-control.js";
import type { Annotation } from "../site/src/islands/api.js";

/**
 * Phase 3 contract §6: the approve/reject/abstain segmented control (aria-
 * pressed, current-vote highlight, enabled only with votes:write), the live
 * tally, and the "Queued as work item" badge - as a unit (VoteControl) and
 * wired into the suggestion cards (the element).
 */

const CHAPTER_ID = "019cadfd-8900-7140-98fb-ceff64cada33";
const BLOCK_ID = "019cadfe-7360-7049-a30b-1f5898a5020a";
const API = "http://api.test";

if (customElements.get("authorbot-collab") === undefined) {
  customElements.define("authorbot-collab", AuthorbotCollab);
}

const tally = (over: Partial<NonNullable<Annotation["votes"]>> = {}) => ({
  approvals: 0,
  rejections: 0,
  abstentions: 0,
  netScore: 0,
  distinctVoters: 0,
  humanApprovals: 0,
  agentApprovals: 0,
  ...over,
});

const suggestion = (over: Partial<Annotation> = {}): Annotation => ({
  id: "ann-1",
  chapterId: CHAPTER_ID,
  kind: "suggestion",
  scope: "range",
  chapterRevision: 3,
  target: {
    blockId: BLOCK_ID,
    textPosition: { start: 4, end: 9 },
    textQuote: { exact: "drift", prefix: "The ", suffix: " appeared" },
  },
  authorActorId: "actor-2",
  body: "Tighten this clause.",
  status: "open",
  gitOperationId: null,
  createdAt: "2026-07-19T00:00:00Z",
  votes: tally(),
  decision: null,
  myVote: null,
  ...over,
});

// ---- VoteControl unit -------------------------------------------------------

describe("VoteControl", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders three aria-pressed segments with counts; highlights the current vote", () => {
    const control = new VoteControl({
      canVote: true,
      signedIn: true,
      onVote: () => {},
      onSignIn: () => {},
    });
    control.update(suggestion({ votes: tally({ approvals: 3, rejections: 1, netScore: 2, distinctVoters: 4 }), myVote: "approve" }));
    document.body.append(control.root);

    const buttons = [...control.root.querySelectorAll<HTMLButtonElement>(".ab-vote-btn")];
    expect(buttons.map((b) => b.dataset.vote)).toEqual(["approve", "reject", "abstain"]);
    expect(buttons.map((b) => b.querySelector(".ab-vote-count")?.textContent)).toEqual(["3", "1", "0"]);
    // Current vote pressed + highlighted; the others not.
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(buttons[0]?.classList.contains("ab-vote-current")).toBe(true);
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("false");
    expect(control.root.querySelector(".ab-vote-tally")?.textContent).toContain("3 approve, 1 reject");
    // All segments enabled for a voter.
    expect(buttons.every((b) => !b.disabled)).toBe(true);
  });

  it("casts a new vote, and toggles the current vote off (clear)", () => {
    const votes: Array<string | null> = [];
    const control = new VoteControl({
      canVote: true,
      signedIn: true,
      onVote: (v) => votes.push(v),
      onSignIn: () => {},
    });
    control.update(suggestion({ myVote: "approve" }));
    document.body.append(control.root);
    const [approve, reject] = [...control.root.querySelectorAll<HTMLButtonElement>(".ab-vote-btn")];
    reject?.click(); // change to a different value
    approve?.click(); // clicking the current vote clears it
    expect(votes).toEqual(["reject", null]);
  });

  it("disables the segments for a signed-in read-only role, with an honest hint", () => {
    const control = new VoteControl({ canVote: false, signedIn: true, onVote: () => {}, onSignIn: () => {} });
    control.update(suggestion());
    document.body.append(control.root);
    expect([...control.root.querySelectorAll<HTMLButtonElement>(".ab-vote-btn")].every((b) => b.disabled)).toBe(true);
    const hint = control.root.querySelector<HTMLElement>(".ab-vote-hint");
    expect(hint?.hidden).toBe(false);
    expect(hint?.textContent).toContain("Your role");
  });

  it("prompts sign-in for a signed-out visitor and shows 'Sign in to vote'", () => {
    let signInCalls = 0;
    const control = new VoteControl({
      canVote: false,
      signedIn: false,
      onVote: () => {},
      onSignIn: () => {
        signInCalls += 1;
      },
    });
    control.update(suggestion());
    document.body.append(control.root);
    expect(control.root.querySelector(".ab-vote-hint")?.textContent).toBe("Sign in to vote.");
    // Disabled buttons don't fire clicks; the onClick guard still routes to
    // sign-in if invoked programmatically (defensive).
    (control as unknown as { onClick(v: string): void }).onClick("approve");
    expect(signInCalls).toBe(1);
  });

  it("shows the queued badge, and the honest support_changed detail", () => {
    const control = new VoteControl({ canVote: true, signedIn: true, onVote: () => {}, onSignIn: () => {} });
    control.update(
      suggestion({ decision: { id: "d", actionType: "create_work_item", result: "create_work_item", supportChanged: false, workItemId: "w" } }),
    );
    document.body.append(control.root);
    expect(control.root.querySelector(".ab-badge")?.textContent).toBe("Queued as work item");
    expect(control.root.querySelector(".ab-badge-detail")).toBeNull();

    // Support drops below the rule → dashed badge + detail, still queued.
    control.update(
      suggestion({ decision: { id: "d", actionType: "create_work_item", result: "create_work_item", supportChanged: true, workItemId: "w" } }),
    );
    expect(control.root.querySelector(".ab-badge-support-changed")).not.toBeNull();
    expect(control.root.querySelector(".ab-badge-detail")?.textContent).toContain("below the threshold");
  });
});

// ---- element integration ----------------------------------------------------

type RouteMap = Record<string, { status: number; body: unknown }>;

function stubFetch(routes: RouteMap): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const found = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    const route = found?.[1] ?? { status: 404, body: { detail: "not found" } };
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.body,
    } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function mount(): AuthorbotCollab {
  document.body.innerHTML = `
    <main id="main">
      <article class="chapter">
        <div class="prose">
          <p id="b-${BLOCK_ID}">The drift appeared on a Tuesday.</p>
        </div>
      </article>
    </main>`;
  const element = document.createElement("authorbot-collab") as AuthorbotCollab;
  element.dataset.apiBase = API;
  element.dataset.project = "hollow-creek-anomaly";
  element.dataset.chapterId = CHAPTER_ID;
  element.dataset.chapterRevision = "3";
  element.dataset.showPublic = "true";
  (document.querySelector("main") as HTMLElement).append(element);
  return element;
}

const meVoter = {
  actor: { id: "actor-1", displayName: "mara", externalIdentity: "github:mara" },
  scopes: ["chapters:read", "annotations:read", "annotations:write", "votes:write"],
};

function annotationsRoute(items: Annotation[]): RouteMap {
  return {
    [`${API}/v1/projects/hollow-creek-anomaly/members`]: { status: 200, body: { items: [], nextCursor: null } },
    [`${API}/v1/projects/hollow-creek-anomaly/chapters/${CHAPTER_ID}/annotations`]: {
      status: 200,
      body: { items, nextCursor: null },
    },
    [`${API}/v1/projects/hollow-creek-anomaly/annotations/ann-1/replies`]: {
      status: 200,
      body: { items: [], nextCursor: null },
    },
  };
}

beforeEach(() => {
  resetProjectStoresForTests();
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("suggestion vote control (element)", () => {
  it("attaches the vote control to a suggestion card and enables it for a voter", async () => {
    stubFetch({ [`${API}/v1/me`]: { status: 200, body: meVoter }, ...annotationsRoute([suggestion({ votes: tally({ approvals: 2, netScore: 2, distinctVoters: 2 }) })]) });
    mount();
    await expect.poll(() => document.querySelector(".ab-votes")).toBeTruthy();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".ab-vote-btn")];
    expect(buttons.length).toBe(3);
    expect(buttons.every((b) => !b.disabled)).toBe(true);
    expect(document.querySelector(".ab-vote-btn .ab-vote-count")?.textContent).toBe("2");
  });

  it("gives comments no vote control", async () => {
    stubFetch({
      [`${API}/v1/me`]: { status: 200, body: meVoter },
      ...annotationsRoute([suggestion({ id: "ann-1", kind: "comment" })]),
    });
    mount();
    await expect.poll(() => document.querySelector(".ab-card")).toBeTruthy();
    expect(document.querySelector(".ab-votes")).toBeNull();
  });

  it("casts a vote: PUTs, then updates the tally and pressed state in place", async () => {
    const fetchFn = stubFetch({
      [`${API}/v1/me`]: { status: 200, body: meVoter },
      [`${API}/v1/projects/hollow-creek-anomaly/annotations/ann-1/vote`]: {
        status: 200,
        body: { value: "approve", votes: tally({ approvals: 1, netScore: 1, distinctVoters: 1 }), decision: null },
      },
      ...annotationsRoute([suggestion()]),
    });
    mount();
    await expect.poll(() => document.querySelector(".ab-vote-btn")).toBeTruthy();
    const approve = document.querySelector<HTMLButtonElement>('.ab-vote-btn[data-vote="approve"]') as HTMLButtonElement;
    approve.click();
    await expect.poll(() => approve.getAttribute("aria-pressed")).toBe("true");
    expect(approve.querySelector(".ab-vote-count")?.textContent).toBe("1");
    // A PUT to the vote endpoint was issued.
    const calledVote = fetchFn.mock.calls.some(
      (call) => String(call[0]).endsWith("/annotations/ann-1/vote") && (call[1] as RequestInit)?.method === "PUT",
    );
    expect(calledVote).toBe(true);
  });

  it("renders an embedded work decision as a settled accepted card", async () => {
    stubFetch({
      [`${API}/v1/me`]: { status: 200, body: meVoter },
      ...annotationsRoute([
        suggestion({
          status: "work_item_created",
          votes: tally({ approvals: 3, netScore: 3, distinctVoters: 3, humanApprovals: 3 }),
          decision: { id: "d", actionType: "create_work_item", result: "create_work_item", supportChanged: false, workItemId: "w" },
        }),
      ]),
    });
    mount();
    await expect.poll(() => document.querySelector(".ab-accepted-badge")).toBeTruthy();
    expect(document.querySelector(".ab-accepted-badge")?.textContent).toBe("Accepted");
    expect(document.querySelector(".ab-card")?.classList.contains("ab-promoted")).toBe(true);
    expect(document.querySelector(".ab-votes")).toBeNull();
    // The crossed suggestion stays visible as its compact accepted diff.
    expect(document.querySelectorAll(".ab-card").length).toBe(1);
  });

  it("updates the tally live from a vote_aggregate feed event (no re-render)", async () => {
    stubFetch({ [`${API}/v1/me`]: { status: 200, body: meVoter }, ...annotationsRoute([suggestion()]) });
    const element = mount();
    await expect.poll(() => document.querySelector(".ab-vote-btn")).toBeTruthy();
    const card = document.querySelector(".ab-card") as HTMLElement;
    // Deliver a live aggregate update straight to the feed handler.
    (element as unknown as {
      onFeedEvent(e: { id: number; type: string; payload: Record<string, unknown> }): void;
    }).onFeedEvent({
      id: 9,
      type: "vote_aggregate",
      payload: {
        annotationId: "ann-1",
        chapterId: CHAPTER_ID,
        votes: tally({ approvals: 5, netScore: 5, distinctVoters: 5 }),
      },
    });
    expect(document.querySelector('.ab-vote-btn[data-vote="approve"] .ab-vote-count')?.textContent).toBe("5");
    // Same card node - updated in place, not rebuilt.
    expect(document.querySelector(".ab-card")).toBe(card);
  });

  it("keeps keyboard focus on the same vote segment across a live re-render (§6)", async () => {
    stubFetch({ [`${API}/v1/me`]: { status: 200, body: meVoter }, ...annotationsRoute([suggestion()]) });
    const element = mount();
    await expect.poll(() => document.querySelector(".ab-vote-btn")).toBeTruthy();
    const abstain = document.querySelector<HTMLButtonElement>('.ab-vote-btn[data-vote="abstain"]') as HTMLButtonElement;
    abstain.focus();
    expect(document.activeElement).toBe(abstain);
    // A background live update rebuilds every card.
    (element as unknown as { renderAll(): void }).renderAll();
    const rebuilt = document.querySelector<HTMLButtonElement>('.ab-vote-btn[data-vote="abstain"]');
    expect(rebuilt).not.toBe(abstain); // the node was rebuilt
    expect(document.activeElement).toBe(rebuilt); // focus followed the segment
  });

  it("signed-out public reader: tallies visible, controls disabled, sign-in hint", async () => {
    stubFetch({
      [`${API}/v1/me`]: { status: 401, body: {} },
      ...annotationsRoute([suggestion({ votes: tally({ approvals: 2, netScore: 2, distinctVoters: 2 }) })]),
    });
    mount();
    await expect.poll(() => document.querySelector(".ab-votes")).toBeTruthy();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".ab-vote-btn")];
    expect(buttons.every((b) => b.disabled)).toBe(true);
    expect(document.querySelector(".ab-vote-btn .ab-vote-count")?.textContent).toBe("2");
    expect(document.querySelector(".ab-vote-hint")?.textContent).toBe("Sign in to vote.");
  });
});
