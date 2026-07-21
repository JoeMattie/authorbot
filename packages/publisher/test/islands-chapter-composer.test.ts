// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorbotChapterComposer } from "../site/src/islands/chapter-composer.js";
import { AuthorbotNewChapter } from "../site/src/islands/new-chapter-button.js";
import {
  chapterComposerReduce,
  chapterDraftStorageKey,
  loadChapterDraft,
  saveChapterDraft,
  validateDraft,
  CHAPTER_IDLE,
} from "../site/src/islands/chapter-composer-state.js";

/**
 * Phase 6 contract §3.5 at the element level: a plain title-and-prose composer
 * that creates a chapter from nothing, revises an existing one, keeps
 * publishing a SEPARATE explicit action, degrades honestly when the chapter's
 * text cannot be read, preserves the draft and the caret across a refresh, and
 * never renders a UUID or a scrap of markup from API data.
 */

const API = "http://api.test";
const PROJECT = "hollow-creek-anomaly";
const CHAPTER_ID = "019cadfd-8900-7140-98fb-ceff64cada33";
const OPERATION_ID = "0190f306-7045-7b2d-9d91-95b3c8228b56";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const HOSTILE = "<img src=x onerror=alert(1)> & <script>alert(2)</script>";

if (customElements.get("authorbot-chapter-composer") === undefined) {
  customElements.define("authorbot-chapter-composer", AuthorbotChapterComposer);
}
if (customElements.get("authorbot-new-chapter") === undefined) {
  customElements.define("authorbot-new-chapter", AuthorbotNewChapter);
}

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
        // Longest prefix wins, so `/chapters/<id>/publish` beats `/chapters`.
        .sort((a, b) => b.length - a.length)[0];
      const entry = key === undefined ? undefined : routes[key];
      const route =
        entry === undefined
          ? { status: 404, body: { detail: "not found" } }
          : typeof entry === "function"
            ? entry()
            : entry;
      return {
        ok: route.status >= 200 && route.status < 300,
        status: route.status,
        json: async () => route.body,
      } as Response;
    }),
  );
}

const meWith = (role: string, scopes: string[], displayName = "mara") => ({
  actor: { id: "actor-1", displayName, externalIdentity: `github:${displayName}` },
  scopes,
  memberships: [{ role }],
});

const meEditor = meWith("editor", ["chapters:read", "submissions:write"]);
const meMaintainer = meWith("maintainer", ["chapters:read", "submissions:write"]);
const meContributor = meWith("contributor", ["annotations:write"]);

const accepted = {
  chapterId: CHAPTER_ID,
  operationId: OPERATION_ID,
  correlationId: "corr-1",
  status: "pending_git",
};

const source = (over: Record<string, unknown> = {}) => ({
  chapterId: CHAPTER_ID,
  title: "The Baseline",
  summary: null,
  revision: 7,
  status: "draft",
  body: "The drift appeared on a Tuesday.\n",
  ...over,
});

const createRoutes = (me: unknown = meEditor, over: Routes = {}): Routes => ({
  [`${API}/v1/me`]: { status: 200, body: me },
  [`${API}/v1/projects/${PROJECT}/chapter-submissions`]: { status: 202, body: accepted },
  [`${API}/v1/projects/${PROJECT}/operations/`]: {
    status: 200,
    body: { id: OPERATION_ID, state: "committed", error: null },
  },
  ...over,
});

function mount(extra: Record<string, string> = {}): AuthorbotChapterComposer {
  document.body.innerHTML = "";
  const element = document.createElement("authorbot-chapter-composer") as AuthorbotChapterComposer;
  element.dataset.apiBase = API;
  element.dataset.project = PROJECT;
  // Default to the `/write/` page's mount, where the composer is the page's
  // own island and therefore owns sign-in. A chapter page's secondary mount
  // (no `data-standalone`) is covered separately below.
  element.dataset.standalone = "true";
  for (const [key, value] of Object.entries(extra)) {
    element.setAttribute(key, value);
  }
  const fallback = document.createElement("p");
  fallback.className = "write-fallback";
  fallback.textContent = "The chapter composer loads here once JavaScript is enabled.";
  element.append(fallback);
  document.body.append(element);
  return element;
}

/** A chapter page's secondary mount, which is not the page's own island. */
function mountOnChapterPage(extra: Record<string, string> = {}): AuthorbotChapterComposer {
  return mount({ "data-standalone": "false", ...extra });
}

const titleInput = (): HTMLInputElement =>
  document.querySelector<HTMLInputElement>(".ab-chapter-title") as HTMLInputElement;
const bodyInput = (): HTMLTextAreaElement =>
  document.querySelector<HTMLTextAreaElement>(".ab-chapter-text") as HTMLTextAreaElement;
const saveBtn = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(".ab-chapter-save") as HTMLButtonElement;
const publishBtn = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>(".ab-chapter-publish");
const statusText = (): string => document.querySelector(".ab-chapter-status")?.textContent ?? "";
const errorText = (): string => document.querySelector(".ab-chapter-error")?.textContent ?? "";

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  requests = [];
  window.sessionStorage.clear();
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  window.sessionStorage.clear();
});

describe("chapter composer state (pure reducer)", () => {
  it("rejects an empty title and an empty body as state, not exceptions", () => {
    expect(validateDraft({ chapterId: null, title: "  ", body: "x", baseRevision: null })).toContain(
      "title",
    );
    expect(validateDraft({ chapterId: null, title: "x", body: " \n", baseRevision: null })).toContain(
      "text",
    );
    expect(validateDraft({ chapterId: null, title: "x", body: "y", baseRevision: null })).toBeNull();

    const opened = chapterComposerReduce(CHAPTER_IDLE, {
      type: "open",
      draft: { chapterId: null, title: "", body: "", baseRevision: null },
    });
    const refused = chapterComposerReduce(opened, { type: "save" });
    expect(refused.phase).toBe("editing");
    expect(refused.error).not.toBeNull();
  });

  it("leaves a refresh hint once the poll budget is spent", () => {
    let state = chapterComposerReduce(CHAPTER_IDLE, {
      type: "open",
      draft: { chapterId: null, title: "T", body: "B", baseRevision: null },
    });
    state = chapterComposerReduce(state, { type: "save" });
    state = chapterComposerReduce(state, {
      type: "accepted",
      operationId: OPERATION_ID,
      chapterId: CHAPTER_ID,
    });
    for (let i = 0; i < 5; i += 1) {
      state = chapterComposerReduce(state, { type: "poll-pending" });
    }
    expect(state.phase).toBe("stale");
  });
});

describe("chapter composer element (contract §3.5)", () => {
  it("leaves the static fallback alone when the API is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    mount();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.querySelector(".write-fallback")).not.toBeNull();
    expect(document.querySelector(".ab-chapter-form")).toBeNull();
    expect(document.querySelector(".ab-error")).toBeNull();
  });

  it("creates a chapter from a title and prose alone (no id, no markers)", async () => {
    stubFetch(createRoutes());
    mount();
    await expect.poll(() => document.querySelector(".ab-chapter-form")).toBeTruthy();
    type(titleInput(), "Chapter One");
    type(bodyInput(), "The drift appeared on a Tuesday.");
    saveBtn().click();

    await expect.poll(() => statusText()).toContain("Saved as a draft");
    const post = requests.find((r) => r.method === "POST" && r.url.endsWith("/chapter-submissions"));
    expect(post).toBeTruthy();
    // Exactly the two fields the author wrote: no id, no slug, no markers.
    expect(post?.body).toEqual({ title: "Chapter One", body: "The drift appeared on a Tuesday." });
    // The 202's operation was polled.
    expect(requests.some((r) => r.url.includes("/operations/"))).toBe(true);
  });

  it("refuses to save an empty title without throwing", async () => {
    stubFetch(createRoutes());
    mount();
    await expect.poll(() => document.querySelector(".ab-chapter-form")).toBeTruthy();
    type(bodyInput(), "prose but no title");
    saveBtn().click();
    await expect.poll(() => errorText()).toContain("title");
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("keeps publishing a separate action, offered only to a maintainer", async () => {
    stubFetch(createRoutes(meEditor));
    mount();
    await expect.poll(() => document.querySelector(".ab-chapter-form")).toBeTruthy();
    expect(publishBtn()).toBeNull();

    stubFetch(
      createRoutes(meMaintainer, {
        [`${API}/v1/projects/${PROJECT}/chapters/${CHAPTER_ID}/publish`]: {
          status: 202,
          body: accepted,
        },
      }),
    );
    mount();
    await expect.poll(() => document.querySelector(".ab-chapter-form")).toBeTruthy();
    // Present but not usable before a chapter exists — and saving never
    // published anything by itself.
    expect(publishBtn()).toBeTruthy();
    expect(publishBtn()?.hidden).toBe(true);

    type(titleInput(), "Chapter One");
    type(bodyInput(), "Prose.");
    saveBtn().click();
    await expect.poll(() => statusText()).toContain("Saved as a draft");
    expect(requests.some((r) => r.url.includes("/publish"))).toBe(false);
    expect(publishBtn()?.hidden).toBe(false);

    (publishBtn() as HTMLButtonElement).click();
    await expect.poll(() => statusText()).toContain("Published");
    expect(requests.some((r) => r.method === "POST" && r.url.includes("/publish"))).toBe(true);
  });

  it("explains the role requirement in words instead of a disabled form", async () => {
    stubFetch(createRoutes(meContributor));
    mount();
    await expect.poll(() => document.querySelector(".ab-chapter-denied")).toBeTruthy();
    expect(document.querySelector(".ab-chapter-denied")?.textContent).toContain(
      "editor or maintainer",
    );
    expect(document.querySelector(".ab-chapter-form")).toBeNull();
    expect(document.querySelector("button[disabled]")).toBeNull();
  });

  it("offers the dev-login form (shared e2e selectors) when signed out", async () => {
    stubFetch({ [`${API}/v1/me`]: { status: 401, body: {} } });
    mount({ "data-dev-login": "true" });
    await expect.poll(() => document.querySelector(".ab-devlogin")).toBeTruthy();
    const form = document.querySelector(".ab-devlogin") as HTMLFormElement;
    expect(form.querySelector('input[name="login"]')).toBeTruthy();
    expect(form.querySelector("select")).toBeTruthy();
    expect(form.querySelector('button[type="submit"]')).toBeTruthy();
    expect(document.querySelector(".ab-signin")).toBeNull();
  });

  it("links to GitHub sign-in when signed out without the dev flag", async () => {
    stubFetch({ [`${API}/v1/me`]: { status: 401, body: {} } });
    mount();
    await expect.poll(() => document.querySelector(".ab-signin")).toBeTruthy();
    const link = document.querySelector<HTMLAnchorElement>(".ab-signin") as HTMLAnchorElement;
    expect(link.href).toContain(`${API}/v1/auth/github?return_to=`);
  });

  /**
   * On a chapter page the composer is a SECOND island beside the annotation
   * island, which already renders the auth bar. Offering sign-in twice on one
   * page is two controls for one job — confusing to a reader, and ambiguous to
   * anything selecting `.ab-devlogin` or `.ab-me`.
   */
  it("renders no auth chrome when it is not the page's own island", async () => {
    for (const me of [
      { status: 401, body: {} },
      { status: 200, body: meContributor },
    ]) {
      stubFetch({ [`${API}/v1/me`]: me });
      mountOnChapterPage({ "data-chapter-id": CHAPTER_ID });
      // Give start() a chance to render anything it was going to render.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(document.querySelector(".ab-devlogin")).toBeNull();
      expect(document.querySelector(".ab-signin")).toBeNull();
      expect(document.querySelector(".ab-me")).toBeNull();
      expect(document.querySelector(".ab-chapter-form")).toBeNull();
      vi.unstubAllGlobals();
    }
  });

  it("still opens the editor on a chapter page for someone who may author", async () => {
    stubFetch({
      [`${API}/v1/me`]: { status: 200, body: meMaintainer },
      [`${API}/v1/projects/${PROJECT}/chapters/${CHAPTER_ID}/source`]: {
        status: 200,
        body: source({ title: "Baseline" }),
      },
    });
    mountOnChapterPage({ "data-chapter-id": CHAPTER_ID });
    await expect.poll(() => document.querySelector(".ab-chapter-form")).toBeTruthy();
    // ...and still without a second auth bar.
    expect(document.querySelector(".ab-me")).toBeNull();
    expect(titleInput().value).toBe("Baseline");
  });
});

describe("chapter composer, edit mode", () => {
  const editRoutes = (over: Routes = {}, me: unknown = meEditor): Routes => ({
    [`${API}/v1/me`]: { status: 200, body: me },
    [`${API}/v1/projects/${PROJECT}/chapters/${CHAPTER_ID}/source`]: { status: 200, body: source() },
    [`${API}/v1/projects/${PROJECT}/chapter-submissions`]: { status: 202, body: accepted },
    [`${API}/v1/projects/${PROJECT}/operations/`]: {
      status: 200,
      body: { id: OPERATION_ID, state: "committed", error: null },
    },
    ...over,
  });

  it("prefills the title and prose from the chapter source", async () => {
    stubFetch(editRoutes());
    mount({ "data-chapter-id": CHAPTER_ID, "data-chapter-title": "The Baseline" });
    await expect.poll(() => document.querySelector(".ab-chapter-form")).toBeTruthy();
    expect(titleInput().value).toBe("The Baseline");
    expect(bodyInput().value).toBe("The drift appeared on a Tuesday.\n");
  });

  it("revises with the base revision the source returned", async () => {
    stubFetch(editRoutes());
    mount({ "data-chapter-id": CHAPTER_ID });
    await expect.poll(() => document.querySelector(".ab-chapter-form")).toBeTruthy();
    type(bodyInput(), "The drift appeared on a Wednesday.");
    saveBtn().click();
    await expect.poll(() => statusText()).toContain("Saved as a draft");
    const post = requests.find((r) => r.method === "POST" && r.url.endsWith("/chapter-submissions"));
    expect(post?.body).toEqual({
      chapterId: CHAPTER_ID,
      baseRevision: 7,
      title: "The Baseline",
      body: "The drift appeared on a Wednesday.",
    });
  });

  it("reads a 409 on revise as 'reload to get the current text'", async () => {
    stubFetch(
      editRoutes({
        [`${API}/v1/projects/${PROJECT}/chapter-submissions`]: {
          status: 409,
          body: { detail: "base revision is stale" },
        },
      }),
    );
    mount({ "data-chapter-id": CHAPTER_ID });
    await expect.poll(() => document.querySelector(".ab-chapter-form")).toBeTruthy();
    type(bodyInput(), "Rewritten.");
    saveBtn().click();
    await expect.poll(() => errorText()).toContain("reload");
    expect(errorText()).toContain("changed since you opened it");
  });

  it("degrades honestly — and never opens an empty box — when the source is unreadable", async () => {
    stubFetch(
      editRoutes({
        [`${API}/v1/projects/${PROJECT}/chapters/${CHAPTER_ID}/source`]: {
          status: 409,
          body: { code: "state-conflict", detail: "no repository reader configured" },
        },
      }),
    );
    mount({ "data-chapter-id": CHAPTER_ID });
    await expect.poll(() => errorText().length > 0).toBe(true);
    expect(errorText()).toContain("cannot be edited here");
    // The critical assertion: no editable box, so a revise can never send an
    // empty replacement body over the chapter.
    expect(document.querySelector(".ab-chapter-text")).toBeNull();
    expect(document.querySelector(".ab-chapter-form")).toBeNull();
    expect(document.querySelector(".ab-chapter-save")).toBeNull();
  });

  it("shows the problem detail for a plain read failure", async () => {
    stubFetch(
      editRoutes({
        [`${API}/v1/projects/${PROJECT}/chapters/${CHAPTER_ID}/source`]: {
          status: 500,
          body: { detail: "the reader exploded" },
        },
      }),
    );
    mount({ "data-chapter-id": CHAPTER_ID });
    await expect.poll(() => errorText()).toContain("the reader exploded");
    expect(document.querySelector(".ab-chapter-text")).toBeNull();
  });
});

describe("draft preservation", () => {
  it("round-trips a draft, caret and focused field through sessionStorage", () => {
    saveChapterDraft(window.sessionStorage, PROJECT, {
      chapterId: null,
      title: "T",
      body: "B",
      baseRevision: null,
      caret: 1,
      focus: "body",
    });
    expect(window.sessionStorage.getItem(chapterDraftStorageKey(PROJECT, null))).not.toBeNull();
    expect(loadChapterDraft(window.sessionStorage, PROJECT, null)).toEqual({
      chapterId: null,
      title: "T",
      body: "B",
      baseRevision: null,
      caret: 1,
      focus: "body",
    });
    // Shape drift is not a crash and not a half-restored draft.
    window.sessionStorage.setItem(chapterDraftStorageKey(PROJECT, null), '{"title":42}');
    expect(loadChapterDraft(window.sessionStorage, PROJECT, null)).toBeNull();
    // A storage-less browser is fine.
    expect(loadChapterDraft(null, PROJECT, null)).toBeNull();
  });

  it("restores the text, the caret and the focus after a remount", async () => {
    stubFetch(createRoutes());
    mount();
    await expect.poll(() => document.querySelector(".ab-chapter-form")).toBeTruthy();
    type(titleInput(), "Chapter One");
    type(bodyInput(), "Half a sentence");
    bodyInput().selectionStart = 4;
    bodyInput().dispatchEvent(new Event("blur"));

    // A refresh: same page, fresh element.
    stubFetch(createRoutes());
    mount();
    await expect.poll(() => document.querySelector(".ab-chapter-form")).toBeTruthy();
    expect(titleInput().value).toBe("Chapter One");
    expect(bodyInput().value).toBe("Half a sentence");
    expect(document.activeElement).toBe(bodyInput());
    expect(bodyInput().selectionStart).toBe(4);
  });

  it("clears the stored draft once the chapter is saved", async () => {
    stubFetch(createRoutes());
    mount();
    await expect.poll(() => document.querySelector(".ab-chapter-form")).toBeTruthy();
    type(titleInput(), "Chapter One");
    type(bodyInput(), "Prose.");
    expect(window.sessionStorage.getItem(chapterDraftStorageKey(PROJECT, null))).not.toBeNull();
    saveBtn().click();
    await expect.poll(() => statusText()).toContain("Saved as a draft");
    expect(window.sessionStorage.getItem(chapterDraftStorageKey(PROJECT, null))).toBeNull();
  });
});

describe("security", () => {
  it("renders hostile source text and problem details as text, never markup", async () => {
    stubFetch({
      [`${API}/v1/me`]: { status: 200, body: meWith("editor", ["submissions:write"], HOSTILE) },
      [`${API}/v1/projects/${PROJECT}/chapters/${CHAPTER_ID}/source`]: {
        status: 200,
        body: source({ title: HOSTILE, body: `Prose ${HOSTILE}` }),
      },
      [`${API}/v1/projects/${PROJECT}/chapter-submissions`]: {
        status: 500,
        body: { detail: HOSTILE },
      },
    });
    const host = mount({ "data-chapter-id": CHAPTER_ID, "data-chapter-title": "Baseline" });
    await expect.poll(() => document.querySelector(".ab-chapter-form")).toBeTruthy();
    expect(titleInput().value).toBe(HOSTILE);
    expect(bodyInput().value).toBe(`Prose ${HOSTILE}`);

    saveBtn().click();
    await expect.poll(() => errorText()).toContain("onerror");

    // Nothing was parsed as markup anywhere in the composer or the page.
    expect(document.querySelectorAll("script").length).toBe(0);
    expect(document.querySelectorAll("img").length).toBe(0);
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(document.querySelector(".ab-me")?.textContent).toBe(`Signed in as ${HOSTILE}`);
  });

  it("never renders a UUID into the composer, in either mode", async () => {
    stubFetch(createRoutes(meMaintainer));
    mount();
    await expect.poll(() => document.querySelector(".ab-chapter-form")).toBeTruthy();
    type(titleInput(), "Chapter One");
    type(bodyInput(), "Prose.");
    saveBtn().click();
    await expect.poll(() => statusText()).toContain("Saved as a draft");
    const composer = document.querySelector(".ab-chapter-composer") as HTMLElement;
    expect(UUID_RE.test(composer.textContent ?? "")).toBe(false);

    stubFetch({
      [`${API}/v1/me`]: { status: 200, body: meMaintainer },
      [`${API}/v1/projects/${PROJECT}/chapters/${CHAPTER_ID}/source`]: { status: 200, body: source() },
    });
    mount({ "data-chapter-id": CHAPTER_ID, "data-chapter-title": "The Baseline" });
    await expect.poll(() => document.querySelector(".ab-chapter-form")).toBeTruthy();
    const editComposer = document.querySelector(".ab-chapter-composer") as HTMLElement;
    expect(UUID_RE.test(editComposer.textContent ?? "")).toBe(false);
    expect(UUID_RE.test(titleInput().value + bodyInput().value)).toBe(false);
  });
});

describe("new chapter button", () => {
  function mountButton(): HTMLElement {
    document.body.innerHTML = "";
    const element = document.createElement("authorbot-new-chapter");
    element.dataset.apiBase = API;
    element.dataset.project = PROJECT;
    element.dataset.href = "/write/";
    document.body.append(element);
    return element;
  }

  it("shows a real link to an actor who may author", async () => {
    stubFetch({ [`${API}/v1/me`]: { status: 200, body: meEditor } });
    mountButton();
    await expect.poll(() => document.querySelector(".ab-new-chapter")).toBeTruthy();
    const link = document.querySelector<HTMLAnchorElement>(".ab-new-chapter") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/write/");
    expect(link.textContent).toBe("New chapter");
  });

  it("renders nothing for a contributor, a signed-out reader, or an unreachable API", async () => {
    stubFetch({ [`${API}/v1/me`]: { status: 200, body: meContributor } });
    const contributor = mountButton();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(contributor.textContent).toBe("");

    stubFetch({ [`${API}/v1/me`]: { status: 401, body: {} } });
    const signedOut = mountButton();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signedOut.textContent).toBe("");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const offline = mountButton();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(offline.textContent).toBe("");
  });
});
