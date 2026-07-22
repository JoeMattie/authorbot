// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorbotAccess } from "../site/src/islands/access-view.js";
import {
  ANONYMOUS_NOTE,
  CONTRIBUTIONS_RETAINED,
  POLICY_ORDER,
  authorHistorySentence,
  describeRemoval,
  describeRevokeAll,
  formatWhen,
  policyMeans,
  removalConsequence,
  revokeAllConsequence,
  roleMeans,
  tokenRevocationConsequence,
  tokenStatus,
} from "../site/src/islands/access-model.js";
import type {
  AccessStateDoc,
  AgentTokenMeta,
  AuditEvent,
  Collaborator,
  PendingAnnotation,
} from "../site/src/islands/access-api.js";

/**
 * Phase 7 contract, "Author-facing access control", at the element level.
 *
 * The assertions here are mostly about WORDS, and deliberately so. Exit
 * criterion 6 is that an author can do all of this "without touching a database
 * or CLI", which makes the interface's account of what each control does part
 * of the feature rather than decoration around it. In particular:
 *
 * - `locked` must never be described as switching collaboration off;
 * - a destructive confirmation must state that contributions and attribution
 *   remain, and must never be default-yes;
 * - role changes must be explained in plain language, never as scope names.
 */

const API = "http://api.test";
const PROJECT = "hollow-creek-anomaly";

if (customElements.get("authorbot-access") === undefined) {
  customElements.define("authorbot-access", AuthorbotAccess);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const me = (role: string) => ({
  actor: { id: "actor-me", displayName: "mara", externalIdentity: "github:mara" },
  scopes: ["annotations:write"],
  memberships: [{ role }],
});

const state = (over: Partial<AccessStateDoc> = {}): AccessStateDoc => ({
  annotationPolicy: "collaborators-only",
  requiresApproval: false,
  freeze: { state: "open" },
  agents: { state: "active" },
  pendingModerationCount: 0,
  ...over,
});

const collaborator = (over: Partial<Collaborator> = {}): Collaborator => ({
  membershipId: "m-1",
  actorId: "actor-avery",
  actor: {
    id: "actor-avery",
    type: "human",
    displayName: "Avery",
    externalIdentity: "github:avery",
  },
  role: "contributor",
  roleMeans: "Server-supplied: a contributor may comment, suggest, and vote.",
  scopes: ["annotations:write"],
  joinedAt: "2026-05-01T09:00:00Z",
  removedAt: null,
  addedByActorId: "actor-me",
  lastActedAt: "2026-07-18T12:30:00Z",
  isAgent: false,
  ownerActorId: null,
  ...over,
});

const token = (over: Partial<AgentTokenMeta> = {}): AgentTokenMeta => ({
  id: "tok-1",
  actorId: "actor-agent",
  name: "drafting-agent",
  scopes: ["submissions:write"],
  createdBy: "actor-me",
  createdAt: "2026-06-01T09:00:00Z",
  expiresAt: "2027-06-01T09:00:00Z",
  revokedAt: null,
  lastUsedAt: "2026-07-19T08:00:00Z",
  owner: { id: "actor-me", type: "human", displayName: "mara", externalIdentity: "github:mara" },
  role: "editor",
  expired: false,
  ...over,
});

const pending = (over: Partial<PendingAnnotation> = {}): PendingAnnotation => ({
  id: "pend-1",
  chapterId: "chap-1",
  kind: "comment",
  scope: "block",
  chapterRevision: 3,
  target: { blockId: "b-1", textQuote: { exact: "the calibration numbers" } },
  authorActorId: "actor-stranger",
  body: "This paragraph contradicts chapter two.",
  moderation: { state: "pending", reviewedByActorId: null, reviewedAt: null, rejectionReason: null },
  createdAt: "2026-07-19T10:00:00Z",
  author: {
    id: "actor-stranger",
    type: "human",
    displayName: "Robin",
    externalIdentity: "github:robin",
  },
  chapter: { id: "chap-1", title: "Baseline", slug: "baseline", revision: 3 },
  authorHistory: { pending: 1, approved: 2, rejected: 4 },
  ...over,
});

const auditEvent = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  id: "ev-1",
  at: "2026-07-19T11:00:00Z",
  action: "project.freeze",
  actorId: "actor-me",
  actorName: "mara",
  actorIdentity: "github:mara",
  actorType: "human",
  targetType: "project",
  targetId: "proj-1",
  correlationId: "corr-1",
  metadata: { reason: "spam wave" },
  ...over,
});

const settingsDoc = (policy = "collaborators-only", status = "clean") => ({
  settings: {
    title: "The Hollow Creek Anomaly",
    language: "en-US",
    license: null,
    publication: {
      show_revision: null,
      show_attribution: null,
      show_public_annotations: null,
    },
    collaboration: {
      annotation_policy: policy,
      source: "book",
      options: {
        open: "Server text for open.",
        "approval-gated": "Server text for approval-gated.",
        "collaborators-only": "Server text for collaborators-only.",
        locked: "Server text for locked: the book stays fully yours to work in.",
      },
    },
  },
  guarded: {},
  governance: { source: "book", rules: {}, vocabulary: { metrics: [], operators: [] } },
  readOnly: {},
  status,
  updatedAt: "2026-07-19T00:00:00Z",
});

// ---------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];

function stubFetch(routes: Record<string, (call: Call, index: number) => Response>): void {
  const seen = new Map<string, number>();
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const call: Call = { url, method, body };
    calls.push(call);
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((prefix) => url.startsWith(prefix));
    if (key === undefined) {
      throw new Error(`unrouted fetch: ${method} ${url}`);
    }
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    return Promise.resolve((routes[key] as (c: Call, i: number) => Response)(call, index));
  });
}

const json = (status: number, body: unknown): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const base = `${API}/v1/projects/${PROJECT}`;

/** The read routes, with per-test overrides. */
function readRoutes(over: Partial<Record<string, (call: Call, index: number) => Response>> = {}) {
  return {
    [`${API}/v1/me`]: () => json(200, me("maintainer")),
    [`${base}/access`]: () => json(200, state()),
    [`${base}/collaborators`]: () => json(200, { items: [], roleConsequences: {} }),
    [`${base}/agent-tokens`]: () => json(200, { items: [] }),
    [`${base}/audit`]: () => json(200, { items: [], nextCursor: null }),
    [`${base}/moderation/queue`]: () => json(200, { items: [], nextCursor: null, pendingCount: 0 }),
    [`${base}/settings`]: () => json(200, settingsDoc()),
    ...over,
  } as Record<string, (call: Call, index: number) => Response>;
}

function mount(): HTMLElement {
  const host = document.createElement("authorbot-access");
  host.setAttribute("data-api-base", API);
  host.setAttribute("data-project", PROJECT);
  const fallback = document.createElement("p");
  fallback.className = "settings-fallback";
  fallback.textContent = "Collaborators load here once JavaScript is enabled.";
  host.append(fallback);
  document.body.append(host);
  return host;
}

async function until<T>(read: () => T): Promise<NonNullable<T>> {
  await expect.poll(() => read()).toBeTruthy();
  return read() as NonNullable<T>;
}

const text = (host: HTMLElement, selector: string): string =>
  host.querySelector<HTMLElement>(selector)?.textContent ?? "";

beforeEach(() => {
  calls = [];
  document.body.textContent = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================
// The model
// ===========================================================================

describe("access-model", () => {
  it("prefers the server's wording for a role and a policy, falling back only when absent", () => {
    expect(roleMeans("editor", { editor: "Server text." })).toBe("Server text.");
    expect(roleMeans("editor")).toContain("claiming work items");
    expect(policyMeans("locked", { locked: "Server locked text." })).toBe("Server locked text.");
    expect(policyMeans("locked")).toContain("stays fully yours");
    // An empty server string is not an answer; the fallback still wins.
    expect(roleMeans("reader", { reader: "" })).toContain("Cannot comment");
  });

  it("never describes `locked` as switching collaboration off", () => {
    const locked = policyMeans("locked");
    expect(locked).toMatch(/only maintainers|maintainers may write/i);
    expect(locked).toMatch(/your own|yours/i);
    // Explicitly promises collaborators keep membership and history.
    expect(locked).toMatch(/keep their membership/i);
    for (const phrase of ["turn off", "turned off", "disabled", "switch off"]) {
      expect(locked.toLowerCase()).not.toContain(phrase);
    }
  });

  it("offers the four modes as the contract's progression, in order", () => {
    expect([...POLICY_ORDER]).toEqual(["open", "approval-gated", "collaborators-only", "locked"]);
  });

  it("says anonymous writing is unavailable in every mode, `open` included", () => {
    expect(ANONYMOUS_NOTE).toMatch(/every mode/i);
    expect(ANONYMOUS_NOTE).toMatch(/open/i);
    expect(ANONYMOUS_NOTE).toMatch(/anonymous/i);
  });

  it("states, in every destructive consequence list, that contributions remain", () => {
    for (const lines of [
      removalConsequence("Avery"),
      tokenRevocationConsequence("drafting-agent"),
      revokeAllConsequence(3),
    ]) {
      expect(lines).toContain(CONTRIBUTIONS_RETAINED);
    }
    expect(CONTRIBUTIONS_RETAINED).toMatch(/not erasing them/i);
  });

  it("names the specific things a removal does, including the released lease", () => {
    const lines = removalConsequence("Avery").join(" ");
    expect(lines).toMatch(/next request/i);
    expect(lines).toMatch(/released|returns to the queue/i);
  });

  it("reports what a revocation actually did, from the API's own numbers", () => {
    const lines = describeRemoval("Avery", {
      actorId: "a",
      removed: true,
      sessionsInvalidated: true,
      leasesReleased: [{ leaseId: "l1", workItemId: "w1" }],
      submissionsRejected: ["s1", "s2"],
      agentTokensRevoked: ["t1"],
      contributionsRetained: true,
    });
    const joined = lines.join(" ");
    expect(joined).toContain("One work item");
    expect(joined).toContain("2 in-flight submissions");
    expect(joined).toContain("One agent token");
    expect(lines).toContain(CONTRIBUTIONS_RETAINED);

    const all = describeRevokeAll({
      revoked: [{ id: "t1", name: "a" }, { id: "t2", name: "b" }],
      leasesReleased: [],
      submissionsRejected: [],
      contributionsRetained: true,
    });
    expect(all.join(" ")).toContain("2 agent tokens were revoked");
    expect(all).toContain(CONTRIBUTIONS_RETAINED);
  });

  it("distinguishes 'never acted' from 'not recorded' rather than blurring them", () => {
    expect(formatWhen(null, "Never")).toBe("Never");
    expect(formatWhen(null, "Not recorded")).toBe("Not recorded");
    expect(formatWhen("2026-07-19T11:05:00Z", "x")).toBe("2026-07-19 11:05 UTC");
    // An unparseable timestamp is an absence, not a fabricated date.
    expect(formatWhen("not-a-date", "Not recorded")).toBe("Not recorded");
  });

  it("ranks a token's status revoked > expired > active", () => {
    expect(tokenStatus(token({ revokedAt: "2026-07-01T00:00:00Z", expired: true }))).toBe("revoked");
    expect(tokenStatus(token({ expired: true }))).toBe("expired");
    expect(tokenStatus(token())).toBe("active");
  });

  it("summarises an author's history so a tenth spam comment reads as the tenth", () => {
    expect(authorHistorySentence({ pending: 1, approved: 0, rejected: 9 })).toContain("9 rejected");
    expect(authorHistorySentence({ pending: 1, approved: 0, rejected: 0 })).toMatch(
      /first contribution/i,
    );
  });
});

// ===========================================================================
// Seeing
// ===========================================================================

describe("seeing", () => {
  it("renders nothing at all for a non-maintainer or a signed-out visitor", async () => {
    for (const body of [me("editor"), null]) {
      document.body.textContent = "";
      calls = [];
      stubFetch(
        readRoutes({
          [`${API}/v1/me`]: () => (body === null ? json(401, {}) : json(200, body)),
        }),
      );
      const host = mount();
      await new Promise((resolve) => setTimeout(resolve, 10));
      // The static fallback survives: the element never scaffolds.
      expect(host.querySelector(".ab-access-body")).toBeNull();
      vi.unstubAllGlobals();
    }
  });

  it("renders nothing when the API is unreachable (progressive enhancement)", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const host = mount();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(host.querySelector(".ab-access-body")).toBeNull();
    expect(host.querySelector(".settings-fallback")).not.toBeNull();
  });

  it("lists a collaborator with role, joined, added by, and last acted", async () => {
    stubFetch(
      readRoutes({
        [`${base}/collaborators`]: () =>
          json(200, {
            items: [collaborator()],
            roleConsequences: { contributor: "Server: may comment, suggest and vote." },
          }),
      }),
    );
    const host = mount();
    const row = await until(() => host.querySelector<HTMLElement>(".ab-collaborator"));
    expect(row.textContent).toContain("Avery");
    expect(row.textContent).toContain("Contributor");
    expect(row.textContent).toContain("2026-05-01");
    expect(row.textContent).toContain("2026-07-18");
    // The role is explained in the server's plain language, never as scopes.
    expect(text(host, ".ab-role-means")).toBe("Server: may comment, suggest and vote.");
    expect(row.textContent).not.toContain("annotations:write");
  });

  it("says 'not recorded' for a membership that predates access logging", async () => {
    stubFetch(
      readRoutes({
        [`${base}/collaborators`]: () =>
          json(200, {
            items: [collaborator({ addedByActorId: null, lastActedAt: null })],
            roleConsequences: {},
          }),
      }),
    );
    const host = mount();
    const row = await until(() => host.querySelector<HTMLElement>(".ab-collaborator"));
    expect(row.textContent).toMatch(/Not recorded/i);
    expect(row.textContent).toMatch(/Never/);
  });

  it("marks an agent actor as an agent rather than showing it silently among the humans", async () => {
    stubFetch(
      readRoutes({
        [`${base}/collaborators`]: () =>
          json(200, {
            items: [collaborator({ isAgent: true, actor: { id: "a", type: "agent", displayName: "drafting-agent", externalIdentity: null } })],
            roleConsequences: {},
          }),
      }),
    );
    const host = mount();
    await until(() => host.querySelector(".ab-badge-agent"));
    expect(text(host, ".ab-badge-agent")).toBe("Agent");
  });

  it("shows token metadata and never a token value or hash", async () => {
    stubFetch(readRoutes({ [`${base}/agent-tokens`]: () => json(200, { items: [token()] }) }));
    const host = mount();
    const row = await until(() => host.querySelector<HTMLElement>(".ab-token"));
    expect(row.textContent).toContain("drafting-agent");
    expect(row.textContent).toContain("mara"); // owning human
    expect(row.textContent).toContain("Editor"); // membership role: half the authority
    expect(row.textContent).toContain("2026-07-19"); // last used
    expect(row.textContent).toMatch(/Active until/);
    for (const forbidden of ["tokenHash", "token_hash", "secret"]) {
      expect(row.textContent).not.toContain(forbidden);
    }
  });

  it("says a token with no membership can do nothing, rather than implying its scopes suffice", async () => {
    stubFetch(
      readRoutes({ [`${base}/agent-tokens`]: () => json(200, { items: [token({ role: null })] }) }),
    );
    const host = mount();
    const row = await until(() => host.querySelector<HTMLElement>(".ab-token"));
    expect(row.textContent).toMatch(/No membership/i);
  });

  it("renders a readable audit view and filters it by actor", async () => {
    stubFetch(
      readRoutes({
        [`${base}/audit`]: () =>
          json(200, {
            items: [auditEvent(), auditEvent({ id: "ev-2", action: "member.remove", actorName: "Avery", actorIdentity: "github:avery", metadata: {} })],
            nextCursor: null,
          }),
      }),
    );
    const host = mount();
    const list = await until(() => host.querySelector<HTMLElement>(".ab-audit-list"));
    // Actions read as words, never as identifiers.
    expect(list.textContent).toContain("mara froze the book");
    expect(list.textContent).toContain("Avery removed a collaborator");
    expect(list.textContent).not.toContain("project.freeze");
    // A reason a maintainer typed is surfaced: it is why the log is worth reading.
    expect(list.textContent).toContain("spam wave");

    const select = host.querySelector<HTMLSelectElement>("select.ab-audit-actor");
    expect(select).not.toBeNull();
    select!.value = "github:avery";
    select!.dispatchEvent(new Event("change"));
    await expect
      .poll(() => calls.some((call) => call.url.includes("/audit?") && call.url.includes("github%3Aavery")))
      .toBe(true);
  });
});

// ===========================================================================
// Restricting
// ===========================================================================

describe("restricting", () => {
  it("offers all four policy modes at once, each explained in the server's words", async () => {
    stubFetch(readRoutes());
    const host = mount();
    await until(() => host.querySelector(".ab-policy-choices"));
    const radios = host.querySelectorAll<HTMLInputElement>("input.ab-policy-radio");
    expect(radios.length).toBe(4);
    expect([...radios].map((r) => r.value)).toEqual([
      "open",
      "approval-gated",
      "collaborators-only",
      "locked",
    ]);
    const means = [...host.querySelectorAll<HTMLElement>(".ab-policy-means")].map(
      (node) => node.textContent ?? "",
    );
    expect(means).toContain("Server text for locked: the book stays fully yours to work in.");
    // The mode in force is marked, and the apply button starts inert.
    expect(host.querySelector(".ab-policy-current")?.textContent).toContain("Collaborators only");
    expect(host.querySelector<HTMLButtonElement>(".ab-policy-apply")?.disabled).toBe(true);
  });

  it("describes `locked` as author-only rather than off, even without server text", async () => {
    stubFetch(
      readRoutes({
        // A deployment predating Phase 7 sends no options map.
        [`${base}/settings`]: () => {
          const document_ = settingsDoc();
          delete (document_.settings as { collaboration?: unknown }).collaboration;
          return json(200, document_);
        },
      }),
    );
    const host = mount();
    await until(() => host.querySelector(".ab-policy-choices"));
    const lockedLabel = [...host.querySelectorAll<HTMLElement>(".ab-field-label")].find(
      (node) => (node.textContent ?? "") === "Locked",
    );
    expect(lockedLabel).toBeDefined();
    const section = host.querySelector<HTMLElement>(".ab-access-policy");
    expect(section?.textContent).toMatch(/only maintainers may write/i);
    expect(section?.textContent).toMatch(/keep their membership/i);
  });

  it("patches only the policy when the mode is changed, and is honest about the commit", async () => {
    stubFetch(readRoutes());
    const host = mount();
    await until(() => host.querySelector(".ab-policy-choices"));
    const locked = host.querySelector<HTMLInputElement>("#ab-policy-locked");
    locked!.checked = true;
    locked!.dispatchEvent(new Event("change"));
    const apply = host.querySelector<HTMLButtonElement>(".ab-policy-apply");
    expect(apply!.disabled).toBe(false);
    apply!.click();

    const patch = await until(() =>
      calls.find((call) => call.method === "PATCH" && call.url.endsWith("/settings")),
    );
    expect(patch.body).toEqual({ collaboration: { annotation_policy: "locked" } });
    // Not "done": the projection updates when the commit lands, and the view
    // says so rather than claiming a mode that is not yet in force.
    await expect
      .poll(() => text(host, ".ab-access-status"))
      .toMatch(/being committed|takes effect/i);
  });

  it("turns the policy picker off while a previous settings commit is in flight", async () => {
    stubFetch(
      readRoutes({ [`${base}/settings`]: () => json(200, settingsDoc("open", "pending_git")) }),
    );
    const host = mount();
    await until(() => host.querySelector(".ab-policy-pending"));
    expect(host.querySelector(".ab-policy-apply")).toBeNull();
  });

  it("shows freeze as an emergency control that stops the author too and spares readers", async () => {
    stubFetch(readRoutes());
    const host = mount();
    await until(() => host.querySelector(".ab-access-freeze"));
    const freeze = host.querySelector<HTMLElement>(".ab-access-freeze")!;
    expect(freeze.textContent).toMatch(/including you/i);
    expect(freeze.textContent).toMatch(/readers are unaffected/i);
    expect(freeze.textContent).toMatch(/keeps serving/i);
    // It is set apart from the ordinary controls, and it is NOT the same
    // control as pausing agents.
    expect(host.querySelector(".ab-access-emergency")).not.toBeNull();
    expect(host.querySelector(".ab-access-agents")).not.toBeNull();
    expect(host.querySelector(".ab-access-freeze")).not.toBe(host.querySelector(".ab-access-agents"));
  });

  it("requires a reason to freeze and sends it", async () => {
    stubFetch(
      readRoutes({
        [`${base}/access/freeze`]: () => json(200, { ...state({ freeze: { state: "frozen" } }), changed: true }),
      }),
    );
    const host = mount();
    await until(() => host.querySelector(".ab-access-freeze-btn"));
    const button = host.querySelector<HTMLButtonElement>(".ab-access-freeze-btn")!;
    expect(button.disabled).toBe(false);
    button.click();

    const reason = host.querySelector<HTMLTextAreaElement>("#ab-freeze-reason")!;
    const ack = host.querySelector<HTMLInputElement>(".ab-confirm-check")!;
    const confirm = host.querySelector<HTMLButtonElement>(".ab-confirm-go")!;
    expect(confirm.disabled).toBe(true);
    reason.value = "a fleet is misbehaving";
    reason.dispatchEvent(new Event("input"));
    expect(confirm.disabled).toBe(true);
    ack.checked = true;
    ack.dispatchEvent(new Event("change"));
    expect(confirm.disabled).toBe(false);
    confirm.click();

    const call = await until(() => calls.find((c) => c.url.endsWith("/access/freeze")));
    expect(call.body).toEqual({ reason: "a fleet is misbehaving" });
  });

  it("pauses agents as a separate control that revokes nothing", async () => {
    stubFetch(
      readRoutes({
        [`${base}/access/pause-agents`]: () =>
          json(200, { ...state({ agents: { state: "paused" } }), changed: true, affectedTokens: 4 }),
      }),
    );
    const host = mount();
    await until(() => host.querySelector(".ab-access-pause-btn"));
    const agents = host.querySelector<HTMLElement>(".ab-access-agents")!;
    expect(agents.textContent).toMatch(/human collaborators keep working/i);
    expect(agents.textContent).toMatch(/nothing is revoked/i);

    host.querySelector<HTMLButtonElement>(".ab-access-pause-btn")!.click();
    const reason = host.querySelector<HTMLTextAreaElement>("#ab-pause-reason")!;
    reason.value = "runaway loop";
    reason.dispatchEvent(new Event("input"));
    const ack = host.querySelector<HTMLInputElement>(".ab-confirm-check")!;
    ack.checked = true;
    ack.dispatchEvent(new Event("change"));
    host.querySelector<HTMLButtonElement>(".ab-confirm-go")!.click();
    const call = await until(() => calls.find((c) => c.url.endsWith("/access/pause-agents")));
    expect(call.body).toEqual({ reason: "runaway loop" });
  });

  it("states a role's consequences in plain language before the change is applied", async () => {
    stubFetch(
      readRoutes({
        [`${base}/collaborators`]: (call) =>
          call.method === "PATCH"
            ? json(200, { actorId: "actor-avery", role: "maintainer", roleMeans: "Server: everything.", changed: true })
            : json(200, {
                items: [collaborator()],
                roleConsequences: {
                  contributor: "Server: may comment and vote.",
                  maintainer: "Server: may change settings, freeze the book, and remove people.",
                },
              }),
      }),
    );
    const host = mount();
    await until(() => host.querySelector(".ab-role-select"));
    const select = host.querySelector<HTMLSelectElement>(".ab-role-select")!;
    const apply = host.querySelector<HTMLButtonElement>(".ab-role-apply")!;
    expect(apply.disabled).toBe(true);

    select.value = "maintainer";
    select.dispatchEvent(new Event("change"));
    const preview = host.querySelector<HTMLElement>(".ab-role-preview")!;
    expect(preview.hidden).toBe(false);
    // The server's sentence, not a scope list.
    expect(preview.textContent).toContain("Server: may change settings, freeze the book");
    expect(preview.textContent).not.toContain("tokens:manage");
    expect(apply.disabled).toBe(false);

    apply.click();
    const call = await until(() =>
      calls.find((c) => c.method === "PATCH" && c.url.includes("/collaborators/actor-avery")),
    );
    expect(call.body).toEqual({ role: "maintainer" });
  });
});

// ===========================================================================
// Revoking
// ===========================================================================

describe("revoking", () => {
  it("never confirms a removal by default, and states what stays as well as what stops", async () => {
    stubFetch(
      readRoutes({
        [`${base}/collaborators`]: () => json(200, { items: [collaborator()], roleConsequences: {} }),
      }),
    );
    const host = mount();
    await until(() => host.querySelector(".ab-remove-collaborator"));
    host.querySelector<HTMLButtonElement>(".ab-remove-collaborator")!.click();

    const panel = await until(() => host.querySelector<HTMLElement>(".ab-access-confirm"));
    // What actually happens, in the API's terms.
    expect(panel.textContent).toMatch(/next request/i);
    expect(panel.textContent).toMatch(/returns to the queue/i);
    // And the sentence the contract makes non-negotiable.
    expect(panel.textContent).toContain(CONTRIBUTIONS_RETAINED);
    expect(panel.textContent).not.toMatch(/delete|erase their|remove their comments/i);

    // Never default-yes: unticked, disabled, and the easy escape is the safe one.
    const check = panel.querySelector<HTMLInputElement>("input.ab-confirm-check")!;
    const go = panel.querySelector<HTMLButtonElement>(".ab-confirm-go")!;
    expect(check.checked).toBe(false);
    expect(go.disabled).toBe(true);
    expect(panel.querySelector(".ab-confirm-cancel")?.textContent).toBe("Keep access");

    // Cancelling sends nothing at all.
    panel.querySelector<HTMLButtonElement>(".ab-confirm-cancel")!.click();
    expect(host.querySelector(".ab-access-confirm")).toBeNull();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("removes only after a deliberate tick, and reports what the API actually did", async () => {
    stubFetch(
      readRoutes({
        [`${base}/collaborators`]: (call) =>
          call.method === "DELETE"
            ? json(200, {
                actorId: "actor-avery",
                removed: true,
                sessionsInvalidated: true,
                leasesReleased: [{ leaseId: "l1", workItemId: "w1" }],
                submissionsRejected: [],
                agentTokensRevoked: [],
                contributionsRetained: true,
              })
            : json(200, { items: [collaborator()], roleConsequences: {} }),
      }),
    );
    const host = mount();
    await until(() => host.querySelector(".ab-remove-collaborator"));
    host.querySelector<HTMLButtonElement>(".ab-remove-collaborator")!.click();
    const panel = await until(() => host.querySelector<HTMLElement>(".ab-access-confirm"));
    const check = panel.querySelector<HTMLInputElement>("input.ab-confirm-check")!;
    check.checked = true;
    check.dispatchEvent(new Event("change"));
    const go = panel.querySelector<HTMLButtonElement>(".ab-confirm-go")!;
    expect(go.disabled).toBe(false);
    go.click();

    await until(() => calls.find((c) => c.method === "DELETE"));
    const status = await until(() => {
      const value = text(host, ".ab-access-status");
      return value.includes("released") ? value : "";
    });
    expect(status).toMatch(/One work item/);
    expect(status).toContain(CONTRIBUTIONS_RETAINED);
  });

  it("confirms a single token revocation with what it costs and what it keeps", async () => {
    stubFetch(
      readRoutes({
        [`${base}/agent-tokens`]: () => json(200, { items: [token()] }),
        [`${base}/agent-tokens/tok-1`]: () => json(204, null),
      }),
    );
    const host = mount();
    await until(() => host.querySelector(".ab-revoke-token"));
    host.querySelector<HTMLButtonElement>(".ab-revoke-token")!.click();
    const panel = await until(() => host.querySelector<HTMLElement>(".ab-access-confirm"));
    expect(panel.textContent).toContain("drafting-agent");
    expect(panel.textContent).toMatch(/cannot be recovered/i);
    expect(panel.textContent).toContain(CONTRIBUTIONS_RETAINED);
    expect(panel.querySelector<HTMLButtonElement>(".ab-confirm-go")!.disabled).toBe(true);
  });

  it("requires a reason as well as a tick before revoking every token", async () => {
    stubFetch(
      readRoutes({
        [`${base}/agent-tokens`]: () => json(200, { items: [token(), token({ id: "tok-2", name: "second" })] }),
        [`${base}/agent-tokens/revoke-all`]: () =>
          json(200, {
            revoked: [{ id: "tok-1", name: "drafting-agent" }],
            leasesReleased: [],
            submissionsRejected: [],
            contributionsRetained: true,
          }),
      }),
    );
    const host = mount();
    await until(() => host.querySelector(".ab-revoke-all"));
    host.querySelector<HTMLButtonElement>(".ab-revoke-all")!.click();
    const panel = await until(() => host.querySelector<HTMLElement>(".ab-access-confirm"));
    expect(panel.textContent).toMatch(/All 2 active agent tokens/);
    expect(panel.textContent).toMatch(/human collaborators are unaffected/i);

    const go = panel.querySelector<HTMLButtonElement>(".ab-confirm-go")!;
    const check = panel.querySelector<HTMLInputElement>("input.ab-confirm-check")!;
    check.checked = true;
    check.dispatchEvent(new Event("change"));
    // Ticked, but the reason is required for this one: still inert.
    expect(go.disabled).toBe(true);

    const reason = panel.querySelector<HTMLTextAreaElement>("textarea")!;
    reason.value = "a token leaked in a log";
    reason.dispatchEvent(new Event("input"));
    expect(go.disabled).toBe(false);
    go.click();
    const call = await until(() => calls.find((c) => c.url.endsWith("/agent-tokens/revoke-all")));
    expect(call.body).toEqual({ reason: "a token leaked in a log" });
  });
});

// ===========================================================================
// Moderating
// ===========================================================================

describe("moderating", () => {
  const gated = () =>
    readRoutes({
      [`${base}/access`]: () =>
        json(200, state({ annotationPolicy: "approval-gated", requiresApproval: true, pendingModerationCount: 1 })),
      [`${base}/moderation/queue`]: () =>
        json(200, { items: [pending()], nextCursor: null, pendingCount: 1 }),
      [`${base}/settings`]: () => json(200, settingsDoc("approval-gated")),
    });

  it("shows an empty review section without fetching a queue when the policy is open", async () => {
    stubFetch(readRoutes());
    const host = mount();
    await until(() => host.querySelector(".ab-access-body"));
    expect(host.querySelector(".ab-access-moderation")).not.toBeNull();
    expect(text(host, ".ab-queue-empty")).toContain("Nothing is waiting");
    // And it does not ask for a queue it knows is empty by construction.
    expect(calls.some((call) => call.url.includes("/moderation/queue"))).toBe(false);
  });

  it("shows the comment, its target passage and the author's history", async () => {
    stubFetch(gated());
    const host = mount();
    const row = await until(() => host.querySelector<HTMLElement>(".ab-pending"));
    expect(text(host, ".ab-pending-body")).toBe("This paragraph contradicts chapter two.");
    expect(row.textContent).toContain("Robin");
    expect(text(host, ".ab-pending-target")).toContain("Baseline");
    expect(text(host, ".ab-pending-target")).toContain("the calibration numbers");
    expect(text(host, ".ab-pending-history")).toContain("4 rejected");
    expect(host.querySelector(".ab-approve")).not.toBeNull();
    expect(host.querySelector(".ab-reject")).not.toBeNull();
  });

  it("renders an untrusted comment body as text, never as markup", async () => {
    stubFetch(
      readRoutes({
        [`${base}/access`]: () => json(200, state({ requiresApproval: true, annotationPolicy: "approval-gated" })),
        [`${base}/moderation/queue`]: () =>
          json(200, {
            items: [pending({ body: '<img src=x onerror="alert(1)"><script>alert(2)</script>' })],
            nextCursor: null,
            pendingCount: 1,
          }),
        [`${base}/settings`]: () => json(200, settingsDoc("approval-gated")),
      }),
    );
    const host = mount();
    const quote = await until(() => host.querySelector<HTMLElement>(".ab-pending-body"));
    expect(quote.textContent).toContain("<script>alert(2)</script>");
    expect(quote.querySelector("img")).toBeNull();
    expect(quote.querySelector("script")).toBeNull();
  });

  it("approves one item", async () => {
    stubFetch({
      ...gated(),
      [`${base}/moderation/pend-1/approve`]: () => json(202, { pendingId: "pend-1", operationId: "op-1" }),
    });
    const host = mount();
    await until(() => host.querySelector(".ab-approve"));
    host.querySelector<HTMLButtonElement>(".ab-approve")!.click();
    await until(() => calls.find((c) => c.url.endsWith("/moderation/pend-1/approve")));
    await expect.poll(() => text(host, ".ab-access-status")).toMatch(/appears to readers/i);
  });

  it("takes an optional reason on rejection and says nobody is notified", async () => {
    stubFetch({
      ...gated(),
      [`${base}/moderation/pend-1/reject`]: () => json(200, { pendingId: "pend-1", retained: true }),
    });
    const host = mount();
    await until(() => host.querySelector(".ab-pending .ab-reject"));
    host.querySelector<HTMLButtonElement>(".ab-pending .ab-reject")!.click();
    const panel = await until(() => host.querySelector<HTMLElement>(".ab-access-confirm"));
    expect(panel.textContent).toMatch(/not notified/i);
    expect(panel.textContent).toMatch(/nothing in Git to remove|never reaches your repository/i);

    // The reason is genuinely optional: ticking alone is enough.
    const check = panel.querySelector<HTMLInputElement>("input.ab-confirm-check")!;
    check.checked = true;
    check.dispatchEvent(new Event("change"));
    const go = panel.querySelector<HTMLButtonElement>(".ab-confirm-go")!;
    expect(go.disabled).toBe(false);

    const reason = panel.querySelector<HTMLTextAreaElement>("textarea")!;
    reason.value = "off topic";
    reason.dispatchEvent(new Event("input"));
    go.click();
    const call = await until(() => calls.find((c) => c.url.endsWith("/moderation/pend-1/reject")));
    expect(call.body).toEqual({ reason: "off topic" });
  });

  it("bulk approves what is selected, and reports items someone else already reviewed", async () => {
    stubFetch({
      ...gated(),
      [`${base}/moderation/queue`]: () =>
        json(200, {
          items: [pending(), pending({ id: "pend-2", body: "second" })],
          nextCursor: null,
          pendingCount: 2,
        }),
      [`${base}/moderation/bulk`]: () =>
        json(200, {
          action: "approve",
          approved: 1,
          rejected: 0,
          results: [
            { pendingId: "pend-1", outcome: "approved" },
            { pendingId: "pend-2", outcome: "already-rejected" },
          ],
        }),
    });
    const host = mount();
    await until(() => host.querySelector(".ab-bulk-approve"));
    // Nothing selected: both bulk actions are inert.
    await expect
      .poll(() => host.querySelector<HTMLButtonElement>(".ab-bulk-approve")?.disabled)
      .toBe(true);

    host.querySelector<HTMLButtonElement>(".ab-bulk-select-all")!.click();
    await expect
      .poll(() => host.querySelector<HTMLButtonElement>(".ab-bulk-approve")?.disabled)
      .toBe(false);
    expect(text(host, ".ab-bulk-count")).toContain("2 comments selected");

    host.querySelector<HTMLButtonElement>(".ab-bulk-approve")!.click();
    const call = await until(() => calls.find((c) => c.url.endsWith("/moderation/bulk")));
    expect((call.body as { ids: string[] }).ids.sort()).toEqual(["pend-1", "pend-2"]);
    // Per-item outcomes: one success does not hide the row someone else took.
    const status = await until(() => {
      const value = text(host, ".ab-access-status");
      return value.includes("skipped") ? value : "";
    });
    expect(status).toMatch(/1 comment approved/);
    expect(status).toMatch(/1 were skipped/);
  });

  it("confirms a bulk rejection rather than firing it straight from the button", async () => {
    stubFetch({
      ...gated(),
      [`${base}/moderation/bulk`]: () => json(200, { action: "reject", approved: 0, rejected: 1, results: [] }),
    });
    const host = mount();
    await until(() => host.querySelector(".ab-bulk-select-all"));
    host.querySelector<HTMLButtonElement>(".ab-bulk-select-all")!.click();
    await expect
      .poll(() => host.querySelector<HTMLButtonElement>(".ab-bulk-reject")?.disabled)
      .toBe(false);
    host.querySelector<HTMLButtonElement>(".ab-bulk-reject")!.click();
    const panel = await until(() => host.querySelector<HTMLElement>(".ab-access-bulk .ab-access-confirm"));
    expect(panel.querySelector<HTMLButtonElement>(".ab-confirm-go")!.disabled).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/moderation/bulk"))).toBe(false);
  });
});

// ===========================================================================
// Accessibility
// ===========================================================================

describe("accessibility", () => {
  it("labels every control and keeps the whole surface keyboard-reachable", async () => {
    stubFetch(
      readRoutes({
        [`${base}/collaborators`]: () => json(200, { items: [collaborator()], roleConsequences: {} }),
        [`${base}/agent-tokens`]: () => json(200, { items: [token()] }),
      }),
    );
    const host = mount();
    await until(() => host.querySelector(".ab-collaborator"));

    // No control is reachable only by pointer: everything interactive is a
    // native button, input, select or textarea, and none is given a
    // negative tabindex.
    const controls = host.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]");
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.getAttribute("tabindex")).not.toBe("-1");
    }

    // Every form control has an accessible name, via a label or aria-label.
    for (const field of host.querySelectorAll<HTMLElement>("input, select, textarea")) {
      const id = field.getAttribute("id");
      const labelled =
        (id !== null && host.querySelector(`label[for="${id}"]`) !== null) ||
        field.closest("label") !== null ||
        field.getAttribute("aria-label") !== null;
      expect(labelled, `${field.tagName} ${id ?? "(no id)"} has an accessible name`).toBe(true);
    }

    // The live regions announce results without stealing focus.
    expect(host.querySelector(".ab-access-status")?.getAttribute("aria-live")).toBe("polite");
    expect(host.querySelector(".ab-access-error")?.getAttribute("role")).toBe("alert");
  });

  it("groups a destructive confirmation as a labelled region", async () => {
    stubFetch(
      readRoutes({
        [`${base}/collaborators`]: () => json(200, { items: [collaborator()], roleConsequences: {} }),
      }),
    );
    const host = mount();
    await until(() => host.querySelector(".ab-remove-collaborator"));
    host.querySelector<HTMLButtonElement>(".ab-remove-collaborator")!.click();
    const panel = await until(() => host.querySelector<HTMLElement>(".ab-access-confirm"));
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.getAttribute("aria-label")).toContain("Remove Avery");
  });
});
