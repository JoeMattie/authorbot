// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorbotCollab } from "../site/src/islands/collab-element.js";
import type { Annotation } from "../site/src/islands/api.js";

/** Phase 11 slice 1: one-click comment/suggestion promotion, reason-required
 * suggestion rejection, and the settled accepted-card presentation. */

const CHAPTER_ID = "019cadfd-8900-7140-98fb-ceff64cada33";
const BLOCK_ID = "019cadfe-7360-7049-a30b-1f5898a5020a";
const API = "http://api.test";
const PROJECT = "hollow-creek-anomaly";

if (customElements.get("authorbot-collab") === undefined) {
  customElements.define("authorbot-collab", AuthorbotCollab);
}

const XSS = "<img src=x onerror=alert(1)> & <script>alert(2)</script>";

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

const comment = (over: Partial<Annotation> = {}): Annotation =>
  suggestion({ kind: "comment", body: "Resolve this loose end.", ...over });

const blockComment = (over: Partial<Annotation> = {}): Annotation =>
  comment({
    scope: "block",
    target: { blockId: BLOCK_ID },
    body: "Resolve this section's loose end.",
    ...over,
  });

interface Route {
  status: number;
  body: unknown;
}
type RouteMap = Record<string, Route>;

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const calls: Call[] = [];

function stubFetch(routes: RouteMap): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const found = Object.entries(routes)
      .filter(([prefix]) => url.startsWith(prefix))
      .sort((a, b) => b[0].length - a[0].length)[0];
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
  element.dataset.project = PROJECT;
  element.dataset.chapterId = CHAPTER_ID;
  element.dataset.chapterRevision = "3";
  element.dataset.showPublic = "true";
  (document.querySelector("main") as HTMLElement).append(element);
  return element;
}

const DEFAULT_SCOPES = [
  "chapters:read",
  "annotations:read",
  "annotations:write",
  "votes:write",
  "work:claim",
];

const meWithRole = (role: string, scopes = DEFAULT_SCOPES) => ({
  actor: { id: "actor-1", displayName: "mara", externalIdentity: "github:mara" },
  scopes,
  memberships: [{ role }],
});

function baseRoutes(items: Annotation[], extra: RouteMap = {}): RouteMap {
  return {
    [`${API}/v1/projects/${PROJECT}/members`]: {
      status: 200,
      body: { items: [], nextCursor: null },
    },
    [`${API}/v1/projects/${PROJECT}/chapters/${CHAPTER_ID}/annotations`]: {
      status: 200,
      body: { items, nextCursor: null },
    },
    [`${API}/v1/projects/${PROJECT}/annotations/ann-1/replies`]: {
      status: 200,
      body: { items: [], nextCursor: null },
    },
    ...extra,
  };
}

async function mountAs(
  role: string,
  items: Annotation[],
  extra: RouteMap = {},
  scopes = DEFAULT_SCOPES,
): Promise<AuthorbotCollab> {
  stubFetch({
    [`${API}/v1/me`]: { status: 200, body: meWithRole(role, scopes) },
    ...baseRoutes(items, extra),
  });
  const element = mount();
  await expect.poll(() => document.querySelector(".ab-card")).toBeTruthy();
  return element;
}

const promoteBtn = () => document.querySelector<HTMLButtonElement>('[data-override="promote"]');
const rejectBtn = () => document.querySelector<HTMLButtonElement>('[data-override="reject"]');
const confirmBtn = () => document.querySelector<HTMLButtonElement>('[data-override="confirm"]');
const reasonBox = () => document.querySelector<HTMLTextAreaElement>(".ab-override-reason");
const errorNode = () => document.querySelector<HTMLElement>(".ab-override-error");
const overrideCall = (suffix: string): Call | undefined =>
  calls.find((call) => call.url.endsWith(suffix) && call.method === "POST");

const promotedResponse: Route = {
  status: 201,
  body: {
    annotationId: "ann-1",
    status: "work_item_created",
    decisionId: "dec-1",
    workItemId: "wi-1",
    operationIds: ["op-1"],
    correlationId: "corr-1",
  },
};

beforeEach(() => {
  vi.useRealTimers();
  calls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("promotion surface", () => {
  it("offers one-click promotion and separate rejection on an open suggestion", async () => {
    await mountAs("maintainer", [suggestion()]);
    expect(promoteBtn()?.textContent).toBe("Promote to work");
    expect(promoteBtn()?.disabled).toBe(false);
    expect(rejectBtn()?.textContent).toBe("Reject suggestion");
    expect(document.querySelector<HTMLElement>(".ab-override-form")?.hidden).toBe(true);
  });

  it("offers a comment only Promote to work, with no vote or rejection UI", async () => {
    await mountAs("maintainer", [comment()]);
    expect(promoteBtn()?.textContent).toBe("Promote to work");
    expect(rejectBtn()?.hidden).toBe(true);
    expect(document.querySelector(".ab-votes")).toBeNull();
    expect(document.querySelector<HTMLElement>(".ab-override-roles")?.hidden).toBe(true);
    expect(document.querySelector(".ab-override-tally")?.textContent).toBe(
      "Turn this note into tracked work.",
    );
  });

  it("offers Promote alongside Reply and Withdraw on a section comment", async () => {
    await mountAs("maintainer", [blockComment({ authorActorId: "actor-1" })]);

    const card = document.querySelector(".ab-card") as HTMLElement;
    const buttons = [...card.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toContain("Promote to work");
    expect(promoteBtn()?.hidden).toBe(false);
    expect(buttons).toContain("Reply");
    expect(buttons).toContain("Withdraw");
    expect(card.getAttribute("aria-label")).toContain("on this block");
  });

  it("shows non-maintainers no maintainer actions", async () => {
    await mountAs("contributor", [suggestion()]);
    expect(document.querySelector(".ab-override")).toBeNull();

    vi.unstubAllGlobals();
    calls.length = 0;
    await mountAs("editor", [suggestion()]);
    expect(document.querySelector(".ab-override")).toBeNull();
  });

  it("gates promotion and rejection on their actual scopes", async () => {
    await mountAs("maintainer", [suggestion()], {}, [
      "chapters:read",
      "annotations:read",
      "annotations:write",
    ]);
    expect(promoteBtn()?.hidden).toBe(true);
    expect(rejectBtn()?.hidden).toBe(false);
  });

  it("offers no actions while syncing or after promotion", async () => {
    await mountAs("maintainer", [suggestion({ status: "pending_git" })]);
    expect(document.querySelector(".ab-override")).toBeNull();

    vi.unstubAllGlobals();
    calls.length = 0;
    await mountAs("maintainer", [suggestion({ status: "work_item_created" })]);
    expect(document.querySelector(".ab-override")).toBeNull();
  });
});

describe("open suggestion context", () => {
  it("shows the tally and role-aware approval counts before promotion", async () => {
    await mountAs("maintainer", [
      suggestion({
        votes: tally({
          approvals: 2,
          rejections: 1,
          netScore: 1,
          distinctVoters: 3,
          humanApprovals: 2,
          maintainerApprovals: 1,
          humanMaintainerApprovals: 0,
        }),
      }),
    ]);
    expect(document.querySelector(".ab-override-tally")?.textContent).toContain(
      "2 approve, 1 reject, 0 abstain (net +1, 3 voters)",
    );
    expect([...document.querySelectorAll(".ab-override-role")].map((node) => node.textContent)).toEqual([
      "Maintainer approvals: 1",
      "Human maintainer approvals: 0",
    ]);
  });
});

describe("one-click promotion", () => {
  it("POSTs {} and immediately settles a suggestion into a green diff card", async () => {
    await mountAs("maintainer", [suggestion()], {
      [`${API}/v1/projects/${PROJECT}/annotations/ann-1/force-create-work-item`]: promotedResponse,
    });

    promoteBtn()?.click();

    await expect.poll(() => overrideCall("/force-create-work-item")).toBeTruthy();
    expect(overrideCall("/force-create-work-item")?.body).toEqual({});
    await expect.poll(() => document.querySelector(".ab-card")?.classList.contains("ab-promoted")).toBe(
      true,
    );
    const card = document.querySelector(".ab-card") as HTMLElement;
    expect(card.querySelector(".ab-accepted-badge")?.textContent).toBe("Accepted");
    expect(card.querySelector(".ab-card-status")).toBeNull();
    expect(card.querySelector(".ab-suggestion-diff")).not.toBeNull();
    expect(card.querySelector(".ab-votes")).toBeNull();
    expect(card.querySelector(".ab-override")).toBeNull();
    expect(card.textContent).not.toContain("Queued as work item");
    expect(card.textContent).not.toContain("work_item_created");
    expect(card.textContent).not.toContain("Maintainer approvals");
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Promoted to work");
  });

  it("settles a promoted section comment into a green note card", async () => {
    await mountAs("maintainer", [blockComment()], {
      [`${API}/v1/projects/${PROJECT}/annotations/ann-1/force-create-work-item`]: promotedResponse,
    });
    promoteBtn()?.click();
    await expect.poll(() => document.querySelector(".ab-card")?.classList.contains("ab-promoted")).toBe(
      true,
    );
    const card = document.querySelector(".ab-card") as HTMLElement;
    expect(card.querySelector(".ab-body")?.textContent).toBe(
      "Resolve this section's loose end.",
    );
    expect(card.querySelector(".ab-accepted-badge")?.textContent).toBe("Accepted");
    expect(card.querySelector(".ab-actions")).toBeNull();
    expect(card.getAttribute("aria-label")).toContain("on this block");
  });

  it("surfaces promotion failures without opening a reason form", async () => {
    const detail = "a work item already exists for this annotation";
    await mountAs("maintainer", [suggestion()], {
      [`${API}/v1/projects/${PROJECT}/annotations/ann-1/force-create-work-item`]: {
        status: 409,
        body: { title: "Conflict", detail },
      },
    });
    promoteBtn()?.click();
    await expect.poll(() => errorNode()?.textContent).toBe(detail);
    expect(errorNode()?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>(".ab-override-form")?.hidden).toBe(true);
  });
});

describe("reason-required rejection", () => {
  it("opens its own empty form and refuses a short reason", async () => {
    await mountAs("maintainer", [suggestion()]);
    rejectBtn()?.click();
    expect(document.querySelector<HTMLElement>(".ab-override-form")?.hidden).toBe(false);
    expect(reasonBox()?.value).toBe("");
    confirmBtn()?.click();
    await expect.poll(() => errorNode()?.textContent).toContain("at least 3 characters");
    expect(overrideCall("/annotations/ann-1/reject")).toBeUndefined();
  });

  it("POSTs the trimmed reason and announces rejection", async () => {
    await mountAs("maintainer", [suggestion()], {
      [`${API}/v1/projects/${PROJECT}/annotations/ann-1/reject`]: {
        status: 200,
        body: {
          annotationId: "ann-1",
          status: "rejected",
          decisionId: "dec-2",
          operationIds: ["op-2"],
          correlationId: "corr-2",
        },
      },
    });
    rejectBtn()?.click();
    const box = reasonBox() as HTMLTextAreaElement;
    box.value = "  Out of scope for this book.  ";
    box.dispatchEvent(new Event("input"));
    confirmBtn()?.click();

    await expect.poll(() => overrideCall("/annotations/ann-1/reject")).toBeTruthy();
    expect(overrideCall("/annotations/ann-1/reject")?.body).toEqual({
      reason: "Out of scope for this book.",
    });
    await expect.poll(() => document.querySelector('[role="status"]')?.textContent).toContain(
      "rejected",
    );
  });

  it("keeps a half-typed rejection reason and focus across a re-render", async () => {
    const element = await mountAs("maintainer", [suggestion()]);
    rejectBtn()?.click();
    const box = reasonBox() as HTMLTextAreaElement;
    box.value = "Half-typed rejection reason";
    box.dispatchEvent(new Event("input"));
    box.focus();

    (element as unknown as { renderAll(): void }).renderAll();

    const rebuilt = reasonBox() as HTMLTextAreaElement;
    expect(rebuilt).not.toBe(box);
    expect(rebuilt.value).toBe("Half-typed rejection reason");
    expect(document.activeElement).toBe(rebuilt);
  });
});

describe("untrusted strings", () => {
  it("renders API detail and annotation body as text, never markup", async () => {
    await mountAs("maintainer", [suggestion({ body: XSS })], {
      [`${API}/v1/projects/${PROJECT}/annotations/ann-1/force-create-work-item`]: {
        status: 409,
        body: { title: "Conflict", detail: XSS },
      },
    });
    expect(document.querySelector(".ab-body")?.textContent).toBe(XSS);
    promoteBtn()?.click();
    await expect.poll(() => errorNode()?.textContent).toBe(XSS);
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.querySelectorAll("[onerror]").length).toBe(0);
  });
});
