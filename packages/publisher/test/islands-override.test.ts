// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorbotCollab } from "../site/src/islands/collab-element.js";
import type { Annotation } from "../site/src/islands/api.js";

/**
 * Phase 6 contract §3.6 "Force-promote": the maintainer overrides ("Promote to
 * work" and reject) surfaced on an open suggestion — maintainer-only, each
 * requiring a reason, each shown beside the tally (including the amendment's
 * role-aware maintainer / human-maintainer approval counts) that the override
 * bypasses.
 */

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

// ---- harness ----------------------------------------------------------------

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
    // Longest matching prefix wins, so `/annotations/ann-1/reject` is not
    // swallowed by the `/annotations` list route.
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

const meWithRole = (role: string) => ({
  actor: { id: "actor-1", displayName: "mara", externalIdentity: "github:mara" },
  scopes: ["chapters:read", "annotations:read", "annotations:write", "votes:write"],
  memberships: [{ role }],
});

function baseRoutes(items: Annotation[], extra: RouteMap = {}): RouteMap {
  return {
    [`${API}/v1/projects/${PROJECT}/members`]: { status: 200, body: { items: [], nextCursor: null } },
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
): Promise<AuthorbotCollab> {
  stubFetch({ [`${API}/v1/me`]: { status: 200, body: meWithRole(role) }, ...baseRoutes(items, extra) });
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

beforeEach(() => {
  vi.useRealTimers();
  calls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

// ---- who sees it ------------------------------------------------------------

describe("override surface visibility", () => {
  it("offers Promote to work + reject to a maintainer on an open suggestion", async () => {
    await mountAs("maintainer", [suggestion()]);
    expect(document.querySelector(".ab-override")).not.toBeNull();
    expect(promoteBtn()?.textContent).toBe("Promote to work");
    expect(rejectBtn()?.textContent).toBe("Reject suggestion");
    // Real, keyboard-reachable buttons — never a disabled affordance.
    expect(promoteBtn()?.tagName).toBe("BUTTON");
    expect(promoteBtn()?.disabled).toBe(false);
    expect(rejectBtn()?.disabled).toBe(false);
  });

  it("shows a contributor and an editor nothing at all", async () => {
    await mountAs("contributor", [suggestion()]);
    expect(document.querySelector(".ab-override")).toBeNull();
    expect(promoteBtn()).toBeNull();
    expect(rejectBtn()).toBeNull();

    vi.unstubAllGlobals();
    calls.length = 0;
    await mountAs("editor", [suggestion()]);
    expect(document.querySelector(".ab-override")).toBeNull();
  });

  it("does not offer the actions for a pending_git annotation (still committing)", async () => {
    await mountAs("maintainer", [
      suggestion({ status: "pending_git", gitOperationId: null }),
    ]);
    expect(document.querySelector(".ab-override")).toBeNull();
  });

  it("does not offer the actions once the suggestion already became work", async () => {
    await mountAs("maintainer", [suggestion({ status: "work_item_created" })]);
    expect(document.querySelector(".ab-override")).toBeNull();
  });
});

// ---- the tally being overridden --------------------------------------------

describe("the tally shown beside the actions", () => {
  it("shows the aggregate summary and the role-aware approval counts", async () => {
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
    const line = document.querySelector(".ab-override-tally")?.textContent ?? "";
    expect(line).toContain("2 approve, 1 reject, 0 abstain");
    expect(line).toContain("net +1, 3 voters");
    expect(line).toContain("rule"); // the framing: this overrides the rule
    const roles = [...document.querySelectorAll(".ab-override-role")].map((n) => n.textContent);
    expect(roles).toEqual(["Maintainer approvals: 1", "Human maintainer approvals: 0"]);
  });

  it("shows “—” for role counts an older API did not supply", async () => {
    await mountAs("maintainer", [suggestion({ votes: tally({ approvals: 1, netScore: 1, distinctVoters: 1 }) })]);
    const roles = [...document.querySelectorAll(".ab-override-role")].map((n) => n.textContent);
    expect(roles).toEqual(["Maintainer approvals: —", "Human maintainer approvals: —"]);
  });

  it("names the action in the framing once a form is open", async () => {
    await mountAs("maintainer", [suggestion()]);
    promoteBtn()?.click();
    expect(document.querySelector(".ab-override-tally")?.textContent).toContain("Promoting overrides");
    document.querySelector<HTMLButtonElement>('[data-override="cancel"]')?.click();
    rejectBtn()?.click();
    expect(document.querySelector(".ab-override-tally")?.textContent).toContain("Rejecting overrides");
  });
});

// ---- the required reason ----------------------------------------------------

describe("the required reason", () => {
  it("opens an empty, labelled reason form with a confirm naming the action", async () => {
    await mountAs("maintainer", [suggestion()]);
    expect(reasonBox()).not.toBeNull();
    expect(document.querySelector<HTMLElement>(".ab-override-form")?.hidden).toBe(true);

    promoteBtn()?.click();
    expect(document.querySelector<HTMLElement>(".ab-override-form")?.hidden).toBe(false);
    expect(reasonBox()?.value).toBe(""); // never pre-filled
    const label = reasonBox()?.closest("label")?.querySelector(".ab-field-label");
    expect(label?.textContent).toContain("Why promote");
    expect(confirmBtn()?.textContent).toBe("Promote to work"); // not "OK"
  });

  it("sends nothing and explains when the reason is empty or too short", async () => {
    await mountAs("maintainer", [suggestion()]);
    promoteBtn()?.click();
    confirmBtn()?.click();
    await expect.poll(() => errorNode()?.hidden).toBe(false);
    expect(errorNode()?.textContent).toContain("at least 3 characters");
    expect(overrideCall("/force-create-work-item")).toBeUndefined();

    const box = reasonBox() as HTMLTextAreaElement;
    box.value = "ab";
    box.dispatchEvent(new Event("input"));
    confirmBtn()?.click();
    await expect.poll(() => errorNode()?.textContent).toContain("at least 3 characters");
    expect(overrideCall("/force-create-work-item")).toBeUndefined();
  });
});

// ---- the two overrides ------------------------------------------------------

describe("performing an override", () => {
  it("promotes: POSTs {reason} to force-create-work-item, accepts 201, announces", async () => {
    await mountAs("maintainer", [suggestion()], {
      [`${API}/v1/projects/${PROJECT}/annotations/ann-1/force-create-work-item`]: {
        status: 201,
        body: {
          annotationId: "ann-1",
          status: "work_item_created",
          decisionId: "dec-1",
          workItemId: "wi-1",
          operationIds: ["op-1"],
          correlationId: "corr-1",
        },
      },
    });
    promoteBtn()?.click();
    const box = reasonBox() as HTMLTextAreaElement;
    box.value = "  Solo book: promoting my own edit.  ";
    box.dispatchEvent(new Event("input"));
    confirmBtn()?.click();

    await expect.poll(() => overrideCall("/force-create-work-item")).toBeTruthy();
    const call = overrideCall("/force-create-work-item") as Call;
    expect(call.method).toBe("POST");
    // Exactly {reason}, trimmed — nothing else is sent.
    expect(call.body).toEqual({ reason: "Solo book: promoting my own edit." });
    await expect.poll(() => document.querySelector('[role="status"]')?.textContent).toContain(
      "Promoted to work",
    );
    expect(errorNode()?.hidden).toBe(true);
  });

  it("rejects: POSTs {reason} to reject and accepts 200", async () => {
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
    box.value = "Out of scope for this book.";
    box.dispatchEvent(new Event("input"));
    confirmBtn()?.click();

    await expect.poll(() => overrideCall("/annotations/ann-1/reject")).toBeTruthy();
    const call = overrideCall("/annotations/ann-1/reject") as Call;
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ reason: "Out of scope for this book." });
    await expect.poll(() => document.querySelector('[role="status"]')?.textContent).toContain(
      "rejected",
    );
  });

  it("surfaces a 403 problem detail verbatim", async () => {
    const detail = "only a maintainer may perform overrides";
    await mountAs("maintainer", [suggestion()], {
      [`${API}/v1/projects/${PROJECT}/annotations/ann-1/force-create-work-item`]: {
        status: 403,
        body: { title: "Forbidden", detail },
      },
    });
    promoteBtn()?.click();
    const box = reasonBox() as HTMLTextAreaElement;
    box.value = "Because I say so.";
    box.dispatchEvent(new Event("input"));
    confirmBtn()?.click();
    await expect.poll(() => errorNode()?.textContent).toBe(detail);
    expect(errorNode()?.getAttribute("role")).toBe("alert");
    expect(errorNode()?.hidden).toBe(false);
  });

  it("surfaces a 409 problem detail verbatim", async () => {
    const detail = "a work item already exists for this suggestion";
    await mountAs("maintainer", [suggestion()], {
      [`${API}/v1/projects/${PROJECT}/annotations/ann-1/force-create-work-item`]: {
        status: 409,
        body: { title: "Conflict", detail },
      },
    });
    promoteBtn()?.click();
    const box = reasonBox() as HTMLTextAreaElement;
    box.value = "Promote it anyway.";
    box.dispatchEvent(new Event("input"));
    confirmBtn()?.click();
    await expect.poll(() => errorNode()?.textContent).toBe(detail);
  });
});

// ---- draft survival ---------------------------------------------------------

describe("draft survival across a background re-render", () => {
  it("keeps an in-progress reason (and focus) when every card is rebuilt", async () => {
    const element = await mountAs("maintainer", [suggestion()]);
    promoteBtn()?.click();
    const box = reasonBox() as HTMLTextAreaElement;
    box.value = "Half-typed override reason";
    box.dispatchEvent(new Event("input"));
    box.focus();
    expect(document.activeElement).toBe(box);

    // The background refresh path: a settled poll rebuilds every card.
    (element as unknown as { renderAll(): void }).renderAll();

    const rebuilt = reasonBox() as HTMLTextAreaElement;
    expect(rebuilt).not.toBe(box); // genuinely rebuilt
    expect(rebuilt.value).toBe("Half-typed override reason");
    expect(document.querySelector<HTMLElement>(".ab-override-form")?.hidden).toBe(false);
    expect(document.activeElement).toBe(rebuilt);
  });

  it("keeps focus on a focused override button across a re-render", async () => {
    const element = await mountAs("maintainer", [suggestion()]);
    const reject = rejectBtn() as HTMLButtonElement;
    reject.focus();
    (element as unknown as { renderAll(): void }).renderAll();
    const rebuilt = rejectBtn();
    expect(rebuilt).not.toBe(reject);
    expect(document.activeElement).toBe(rebuilt);
  });
});

// ---- XSS --------------------------------------------------------------------

describe("untrusted strings are text, never markup", () => {
  it("renders an API detail and an annotation body as text", async () => {
    await mountAs("maintainer", [suggestion({ body: XSS })], {
      [`${API}/v1/projects/${PROJECT}/annotations/ann-1/force-create-work-item`]: {
        status: 409,
        body: { title: "Conflict", detail: XSS },
      },
    });
    // The untrusted annotation body reached the DOM as text.
    expect(document.querySelector(".ab-body")?.textContent).toBe(XSS);

    promoteBtn()?.click();
    const box = reasonBox() as HTMLTextAreaElement;
    box.value = "Trying it.";
    box.dispatchEvent(new Event("input"));
    confirmBtn()?.click();
    await expect.poll(() => errorNode()?.textContent).toBe(XSS);

    // No element was ever created from either string.
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.querySelectorAll("[onerror]").length).toBe(0);
  });
});
