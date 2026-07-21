// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorbotSettings } from "../site/src/islands/settings-view.js";
import {
  buildPatch,
  cloneSnapshot,
  describeRule,
  hasHumanMaintainerClause,
  licenseSummary,
  snapshotOf,
  withHumanMaintainerClause,
} from "../site/src/islands/settings-model.js";
import type { SettingsDocument } from "../site/src/islands/api.js";

/**
 * Phase 6 contract §3.6 at the element level: settings are maintainer-only,
 * governance is explained rather than printed, guarded changes state what they
 * break BEFORE they are accepted, and the never-editable fields are absent from
 * the interface rather than disabled in it.
 */

const API = "http://api.test";
const PROJECT = "hollow-creek-anomaly";
/** The book id is a UUID and must never reach the interface. */
const BOOK_ID = "019cadfd-8900-7140-98fb-ceff64cada33";

const SLUG_CONSEQUENCE =
  "The slug appears in every published chapter URL. Changing it breaks every existing link to this book.";

if (customElements.get("authorbot-settings") === undefined) {
  customElements.define("authorbot-settings", AuthorbotSettings);
}

const doc = (over: Partial<SettingsDocument> = {}): SettingsDocument => ({
  settings: {
    title: "The Hollow Creek Anomaly",
    language: "en-US",
    license: "CC-BY-4.0",
    publication: {
      show_revision: true,
      show_attribution: null,
      show_public_annotations: false,
    },
  },
  guarded: {
    slug: { value: "hollow-creek", consequence: SLUG_CONSEQUENCE },
    "publication.chapter_url": {
      value: null,
      consequence: "chapter_url is the URL template for published chapters.",
    },
  },
  governance: {
    source: "book",
    rules: {
      promote_suggestion: {
        version: 3,
        trigger: "vote_changed",
        when: {
          all: [
            { metric: "approvals", operator: "gte", value: 3 },
            { metric: "human_maintainer_approvals", operator: "gte", value: 1 },
          ],
        },
        action: { type: "create_work_item", work_type: "revise_range" },
      } as never,
    },
    vocabulary: {
      metrics: ["approvals", "human_maintainer_approvals"],
      operators: ["gte", "lte", "gt", "lt", "eq"],
    },
  },
  readOnly: {
    id: BOOK_ID,
    "repository.default_branch": "main",
    "content.chapters_glob": "content/chapters/*.md",
    "content.raw_html": false,
    "publication.api_url": "/api",
    reasons: {
      id: "The book id is its permanent identity.",
      "repository.default_branch": "The default branch is a deployment invariant.",
      "content.chapters_glob": "The chapters glob is a repository layout invariant.",
      "content.raw_html": "Enabling raw HTML is a security decision, not a display preference.",
      "publication.api_url": "api_url must match the Worker's API_BASE_PATH.",
    },
  },
  status: "clean",
  updatedAt: "2026-07-19T00:00:00Z",
  ...over,
});

const me = (role: string) => ({
  actor: { id: "actor-1", displayName: "mara", externalIdentity: "github:mara" },
  scopes: ["annotations:write", "submissions:write"],
  memberships: [{ role }],
});

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];

/** URL-prefix route map; each route may answer differently per call. */
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
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const problem = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json" },
  });

const settingsUrl = `${API}/v1/projects/${PROJECT}/settings`;

function mount(attrs: Record<string, string> = {}): HTMLElement {
  const host = document.createElement("authorbot-settings");
  host.setAttribute("data-api-base", API);
  host.setAttribute("data-project", PROJECT);
  for (const [name, value] of Object.entries(attrs)) {
    host.setAttribute(name, value);
  }
  const fallback = document.createElement("p");
  fallback.className = "settings-fallback";
  fallback.textContent = "Book settings load here once JavaScript is enabled.";
  host.append(fallback);
  document.body.append(host);
  return host;
}

/** Wait until `read` returns a truthy value (the element renders async). */
async function until<T>(read: () => T): Promise<NonNullable<T>> {
  await expect.poll(() => read()).toBeTruthy();
  return read() as NonNullable<T>;
}

const settingsRequests = (): Call[] => calls.filter((call) => call.url.startsWith(settingsUrl));
const patches = (): Call[] => settingsRequests().filter((call) => call.method === "PATCH");

beforeEach(() => {
  calls = [];
  document.body.textContent = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

describe("settings-model", () => {
  it("builds a minimal patch and treats null as 'clear', absent as 'leave alone'", () => {
    const original = snapshotOf(doc());
    const edited = cloneSnapshot(original);
    expect(buildPatch(original, edited)).toEqual({});

    edited.title = "A New Title";
    expect(buildPatch(original, edited)).toEqual({ title: "A New Title" });

    const cleared = cloneSnapshot(original);
    cleared.license = null;
    expect(buildPatch(original, cleared)).toEqual({ license: null });

    const flagged = cloneSnapshot(original);
    flagged.publication.show_attribution = true;
    expect(buildPatch(original, flagged)).toEqual({ publication: { show_attribution: true } });
  });

  it("never carries a rule `version` into the patch", () => {
    const original = snapshotOf(doc());
    expect(JSON.stringify(original.rules)).not.toContain("version");
    const edited = cloneSnapshot(original);
    edited.rules["promote_suggestion"] = withHumanMaintainerClause(
      edited.rules["promote_suggestion"]!,
      false,
    );
    const patch = buildPatch(original, edited);
    expect(JSON.stringify(patch.governance)).not.toContain("version");
  });

  it("adds and removes the human-maintainer clause", () => {
    const rule = snapshotOf(doc()).rules["promote_suggestion"]!;
    expect(hasHumanMaintainerClause(rule)).toBe(true);
    const without = withHumanMaintainerClause(rule, false);
    expect(hasHumanMaintainerClause(without)).toBe(false);
    expect(hasHumanMaintainerClause(withHumanMaintainerClause(without, true))).toBe(true);
  });

  it("reads maintainer_approvals and human_maintainer_approvals differently", () => {
    const anyMaintainer = describeRule("r", {
      when: { all: [{ metric: "maintainer_approvals", operator: "gte", value: 1 }] },
      action: { type: "create_work_item", work_type: "revise_range" },
    }).clauses[0]!;
    const humanOnly = describeRule("r", {
      when: { all: [{ metric: "human_maintainer_approvals", operator: "gte", value: 1 }] },
      action: { type: "create_work_item", work_type: "revise_range" },
    }).clauses[0]!;
    expect(anyMaintainer.text).not.toEqual(humanOnly.text);
    expect(humanOnly.text).toContain("human maintainer");
    // The explanation must say WHY the distinction matters, not just restate it.
    expect(anyMaintainer.explain).toContain("agent");
    expect(humanOnly.explain.toLowerCase()).toContain("agent");
  });

  it("summarises recognised licences and invents nothing for the rest", () => {
    expect(licenseSummary("CC-BY-4.0")).toContain("credit you");
    expect(licenseSummary("cc0-1.0")).toBeTruthy();
    expect(licenseSummary("LicenseRef-Weird-Custom-1.0")).toBeNull();
    expect(licenseSummary(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The element
// ---------------------------------------------------------------------------

describe("<authorbot-settings>", () => {
  it("explains that settings are maintainer-only instead of rendering the form", async () => {
    stubFetch({
      [`${API}/v1/me`]: () => json(200, me("contributor")),
      [settingsUrl]: () => json(200, doc()),
    });
    const host = mount();
    const denied = await until(() => host.querySelector(".ab-settings-denied"));
    expect(denied.textContent).toContain("maintainer");
    expect(host.querySelector(".ab-settings-form")).toBeNull();
    // A non-maintainer never even asks for the document.
    expect(settingsRequests()).toHaveLength(0);
  });

  it("renders an editable form for a maintainer and round-trips a title change", async () => {
    stubFetch({
      [`${API}/v1/me`]: () => json(200, me("maintainer")),
      [settingsUrl]: (call, index) => {
        if (call.method === "PATCH") {
          return json(202, { operationId: "op-1", status: "queued", changed: ["title"] });
        }
        return json(
          200,
          index === 0
            ? doc()
            : doc({ settings: { ...doc().settings, title: "The Hollow Creek Anomaly, Revised" } }),
        );
      },
    });
    const host = mount();
    const title = (await until(() =>
      host.querySelector<HTMLInputElement>("input.ab-settings-title"),
    )) as HTMLInputElement;
    expect(title.value).toBe("The Hollow Creek Anomaly");

    title.value = "The Hollow Creek Anomaly, Revised";
    title.dispatchEvent(new Event("input"));
    host.querySelector<HTMLButtonElement>(".ab-settings-save")?.click();

    await expect.poll(() => patches().length).toBe(1);
    // Minimal patch: only the field that actually changed.
    expect(patches()[0]?.body).toEqual({ title: "The Hollow Creek Anomaly, Revised" });

    const status = await until(() => host.querySelector(".ab-settings-status"));
    expect(status.textContent).toContain("Saved");
    // Round-trip: the form is refreshed from the API after a save.
    await expect.poll(
      () => host.querySelector<HTMLInputElement>("input.ab-settings-title")?.value,
    ).toBe("The Hollow Creek Anomaly, Revised");
  });

  it("sends nothing when nothing changed", async () => {
    stubFetch({
      [`${API}/v1/me`]: () => json(200, me("maintainer")),
      [settingsUrl]: () => json(200, doc()),
    });
    const host = mount();
    const save = (await until(() =>
      host.querySelector<HTMLButtonElement>(".ab-settings-save"),
    )) as HTMLButtonElement;
    save.click();
    await expect.poll(() => host.querySelector(".ab-settings-status")?.textContent).toContain(
      "Nothing to save",
    );
    expect(patches()).toHaveLength(0);
  });

  it("omits the never-editable fields entirely - no control is bound to them", async () => {
    stubFetch({
      [`${API}/v1/me`]: () => json(200, me("maintainer")),
      [settingsUrl]: () => json(200, doc()),
    });
    const host = mount();
    await until(() => host.querySelector(".ab-settings-form"));

    const controls = [...host.querySelectorAll<HTMLElement>("input, select, textarea")];
    expect(controls.length).toBeGreaterThan(0);
    const forbidden = ["default_branch", "chapters_glob", "raw_html", "api_url"];
    for (const control of controls) {
      const name = control.getAttribute("name") ?? "";
      const id = control.getAttribute("id") ?? "";
      const labelText =
        (control.closest("label")?.textContent ?? "") +
        (document.querySelector(`label[for="${id}"]`)?.textContent ?? "");
      const surface = `${name} ${id} ${labelText}`.toLowerCase();
      for (const token of forbidden) {
        expect(surface).not.toContain(token);
      }
      // `id` as a field of its own, not as a substring of another word.
      expect(name).not.toBe("id");
      expect(name).not.toBe("book_id");
      // Nothing is bound to a never-editable value.
      expect((control as HTMLInputElement).value ?? "").not.toBe(BOOK_ID);
      expect((control as HTMLInputElement).value ?? "").not.toBe("content/chapters/*.md");
    }
    // Nothing is merely disabled either - a greyed control is still an offer.
    expect(host.querySelectorAll("[disabled]")).toHaveLength(0);
  });

  it("never leaks the book id (a UUID) into the rendered text", async () => {
    stubFetch({
      [`${API}/v1/me`]: () => json(200, me("maintainer")),
      [settingsUrl]: () => json(200, doc()),
    });
    const host = mount();
    await until(() => host.querySelector(".ab-settings-form"));
    expect(host.textContent ?? "").not.toContain(BOOK_ID);
    expect(host.textContent ?? "").not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it("states the consequence as soon as a guarded field is edited", async () => {
    stubFetch({
      [`${API}/v1/me`]: () => json(200, me("maintainer")),
      [settingsUrl]: () => json(200, doc()),
    });
    const host = mount();
    const slug = (await until(() =>
      host.querySelector<HTMLInputElement>("input.ab-settings-slug"),
    )) as HTMLInputElement;
    const consequence = host.querySelector<HTMLElement>(".ab-guarded-consequence");
    expect(consequence?.hidden).toBe(true);

    slug.value = "hollow-creek-2";
    slug.dispatchEvent(new Event("input"));
    // Server-supplied text, shown before the change is even attempted.
    expect(consequence?.hidden).toBe(false);
    expect(consequence?.textContent).toBe(SLUG_CONSEQUENCE);
  });

  it("requires an explicit confirmation before resending a guarded change", async () => {
    const breaks =
      "Changing the slug breaks every existing link to this book - bookmarks, citations, and links shared by readers will 404.";
    stubFetch({
      [`${API}/v1/me`]: () => json(200, me("maintainer")),
      [settingsUrl]: (call) => {
        if (call.method !== "PATCH") return json(200, doc());
        const confirmed = (call.body as { confirm?: string[] }).confirm ?? [];
        if (!confirmed.includes("slug")) {
          return problem(409, {
            code: "settings-confirmation-required",
            title: "Confirmation required",
            detail: "these changes break existing links and must be confirmed: slug",
            fields: [{ field: "slug", breaks }],
            confirmWith: ["slug"],
          });
        }
        return json(202, { operationId: "op-2", status: "queued", changed: ["slug"] });
      },
    });
    const host = mount();
    const slug = (await until(() =>
      host.querySelector<HTMLInputElement>("input.ab-settings-slug"),
    )) as HTMLInputElement;
    slug.value = "hollow-creek-2";
    slug.dispatchEvent(new Event("input"));
    host.querySelector<HTMLButtonElement>(".ab-settings-save")?.click();

    await expect.poll(() => patches().length).toBe(1);
    const confirmPanel = await until(() =>
      host.querySelector<HTMLElement>(".ab-settings-confirm:not([hidden])"),
    );
    // The API's own account of what breaks, not our copy of it.
    expect(confirmPanel.textContent).toContain(breaks);

    const check = confirmPanel.querySelector<HTMLInputElement>("input.ab-confirm-check");
    const confirmButton = confirmPanel.querySelector<HTMLButtonElement>(".ab-confirm-btn");
    expect(check?.checked).toBe(false); // never pre-ticked
    expect(confirmButton?.disabled).toBe(true);

    // Nothing is resent until the maintainer acts.
    confirmButton?.click();
    expect(patches()).toHaveLength(1);

    check!.checked = true;
    check!.dispatchEvent(new Event("change"));
    expect(confirmButton?.disabled).toBe(false);
    confirmButton?.click();

    await expect.poll(() => patches().length).toBe(2);
    expect(patches()[1]?.body).toEqual({ slug: "hollow-creek-2", confirm: ["slug"] });
  });

  it("renders governance as author-facing sentences, never raw metric identifiers", async () => {
    stubFetch({
      [`${API}/v1/me`]: () => json(200, me("maintainer")),
      [settingsUrl]: () => json(200, doc()),
    });
    const host = mount();
    const governance = await until(() => host.querySelector(".ab-settings-governance"));
    const text = governance.textContent ?? "";

    expect(text).toContain("How many approvals before a suggestion becomes work?");
    expect(text).toContain("at least 3 people approve it");
    expect(text).toContain("you (or another human maintainer) approve it");
    // Explained, not merely rendered: the WHY is present.
    expect(text.toLowerCase()).toContain("agent");
    expect(text).toContain("Require a human maintainer's approval");

    for (const identifier of [
      "human_maintainer_approvals",
      "maintainer_approvals",
      "approvals >=",
      "net_score",
      "create_work_item",
      "vote_changed",
      "gte",
    ]) {
      expect(text).not.toContain(identifier);
    }

    const toggle = governance.querySelector<HTMLInputElement>("input.ab-require-human-maintainer");
    expect(toggle?.checked).toBe(true);
  });

  it("says a bootstrap book has not adopted its own rules yet", async () => {
    const base = doc();
    stubFetch({
      [`${API}/v1/me`]: () => json(200, me("maintainer")),
      [settingsUrl]: () =>
        json(200, { ...base, governance: { ...base.governance, source: "bootstrap" } }),
    });
    const host = mount();
    const source = await until(() => host.querySelector(".ab-governance-source"));
    expect(source.textContent).toContain("has not adopted its own rules yet");
    expect(source.textContent).toContain("Saving here adopts them");
  });

  it("sends edited rules with no `version` key", async () => {
    stubFetch({
      [`${API}/v1/me`]: () => json(200, me("maintainer")),
      [settingsUrl]: (call) =>
        call.method === "PATCH"
          ? json(202, { operationId: "op-3", status: "queued", changed: ["governance.rules"] })
          : json(200, doc()),
    });
    const host = mount();
    const threshold = (await until(() =>
      host.querySelector<HTMLInputElement>("input.ab-rule-threshold"),
    )) as HTMLInputElement;
    threshold.value = "5";
    threshold.dispatchEvent(new Event("input"));
    // The sentence updates live, in the author's words.
    expect(host.querySelector(".ab-clause-text")?.textContent).toContain("at least 5 people");

    host.querySelector<HTMLButtonElement>(".ab-settings-save")?.click();
    await expect.poll(() => patches().length).toBe(1);
    const body = patches()[0]?.body as { governance: { rules: Record<string, unknown> } };
    expect(Object.keys(body)).toEqual(["governance"]);
    expect(JSON.stringify(body.governance)).not.toContain("version");
    expect(JSON.stringify(body.governance)).toContain('"value":5');
  });

  it("removing the human-maintainer requirement drops the clause from the patch", async () => {
    stubFetch({
      [`${API}/v1/me`]: () => json(200, me("maintainer")),
      [settingsUrl]: (call) =>
        call.method === "PATCH"
          ? json(202, { operationId: "op-4", status: "queued", changed: ["governance.rules"] })
          : json(200, doc()),
    });
    const host = mount();
    const toggle = (await until(() =>
      host.querySelector<HTMLInputElement>("input.ab-require-human-maintainer"),
    )) as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    expect(host.querySelector(".ab-settings-governance")?.textContent).not.toContain(
      "human maintainer) approve it",
    );

    host.querySelector<HTMLButtonElement>(".ab-settings-save")?.click();
    await expect.poll(() => patches().length).toBe(1);
    expect(JSON.stringify(patches()[0]?.body)).not.toContain("human_maintainer_approvals");
  });

  it("shows a state-conflict detail verbatim and offers no form", async () => {
    const detail =
      "this book's book.yml has not been projected from its repository yet, so settings cannot be read or changed. Configure the GitHub App credentials and let the projection run, then retry.";
    stubFetch({
      [`${API}/v1/me`]: () => json(200, me("maintainer")),
      [settingsUrl]: () => problem(409, { code: "state-conflict", title: "Conflict", detail }),
    });
    const host = mount();
    const error = await until(() => host.querySelector(".ab-settings-error"));
    expect(error.textContent).toContain(detail);
    expect(host.querySelector(".ab-settings-form")).toBeNull();
  });

  it("does not offer Save while a previous settings commit is in flight", async () => {
    stubFetch({
      [`${API}/v1/me`]: () => json(200, me("maintainer")),
      [settingsUrl]: () => json(200, doc({ status: "pending_git" })),
    });
    const host = mount();
    const pending = await until(() => host.querySelector(".ab-settings-pending"));
    expect(pending.textContent).toContain("not been committed");
    expect(host.querySelector(".ab-settings-save")).toBeNull();
  });

  it("reports validation issues field by field", async () => {
    stubFetch({
      [`${API}/v1/me`]: () => json(200, me("maintainer")),
      [settingsUrl]: (call) =>
        call.method === "PATCH"
          ? problem(422, {
              code: "validation-failed",
              title: "Validation failed",
              detail: "settings patch failed validation",
              issues: [{ path: "language", message: "must be a language tag like en-US" }],
            })
          : json(200, doc()),
    });
    const host = mount();
    const language = (await until(() =>
      host.querySelector<HTMLInputElement>("input.ab-settings-language"),
    )) as HTMLInputElement;
    language.value = "not a tag!";
    language.dispatchEvent(new Event("input"));
    host.querySelector<HTMLButtonElement>(".ab-settings-save")?.click();

    const error = await until(() => host.querySelector(".ab-settings-error:not([hidden])"));
    expect(error.textContent).toContain("settings patch failed validation");
    expect(error.textContent).toContain("language: must be a language tag like en-US");
  });

  it("renders hostile API strings as text, never as markup", async () => {
    const hostile = '<img src=x onerror=alert(1)> & <script>alert(2)</script>';
    stubFetch({
      [`${API}/v1/me`]: () => json(200, me("maintainer")),
      [settingsUrl]: (call) => {
        if (call.method === "PATCH") {
          return problem(409, {
            code: "settings-confirmation-required",
            detail: hostile,
            fields: [{ field: "slug", breaks: hostile }],
            confirmWith: ["slug"],
          });
        }
        const base = doc();
        return json(200, {
          ...base,
          settings: { ...base.settings, title: hostile },
          guarded: { ...base.guarded, slug: { value: "hollow-creek", consequence: hostile } },
        });
      },
    });
    const host = mount();
    const slug = (await until(() =>
      host.querySelector<HTMLInputElement>("input.ab-settings-slug"),
    )) as HTMLInputElement;
    expect(host.querySelector<HTMLInputElement>("input.ab-settings-title")?.value).toBe(hostile);
    expect(host.querySelector(".ab-guarded-consequence")?.textContent).toBe(hostile);
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("script")).toBeNull();

    slug.value = "hollow-creek-2";
    slug.dispatchEvent(new Event("input"));
    host.querySelector<HTMLButtonElement>(".ab-settings-save")?.click();
    const breaksLine = await until(() => host.querySelector(".ab-confirm-breaks"));
    expect(breaksLine.textContent).toBe(hostile);
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("script")).toBeNull();
  });

  it("renders the dev-login form with the shared selectors when signed out", async () => {
    stubFetch({
      [`${API}/v1/me`]: () => new Response("", { status: 401 }),
      [`${API}/v1/dev/login`]: () => json(200, me("maintainer")),
      [settingsUrl]: () => json(200, doc()),
    });
    const host = mount({ "data-dev-login": "true" });
    const form = (await until(() =>
      host.querySelector<HTMLFormElement>(".ab-devlogin"),
    )) as HTMLFormElement;
    expect(form.querySelector('input[name="login"]')).toBeTruthy();
    expect(form.querySelector("select")).toBeTruthy();
    expect(form.querySelector('button[type="submit"]')).toBeTruthy();
    expect(host.querySelector(".ab-settings-form")).toBeNull();
  });

  it("renders nothing at all when the API is unreachable", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    const host = mount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The static fallback survives untouched (progressive enhancement).
    expect(host.querySelector(".settings-fallback")).toBeTruthy();
    expect(host.querySelector(".ab-settings-form")).toBeNull();
    expect(host.querySelector(".ab-settings-denied")).toBeNull();
  });
});
