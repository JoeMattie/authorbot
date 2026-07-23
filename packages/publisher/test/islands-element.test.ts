// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorbotCollab } from "../site/src/islands/collab-element.js";
import {
  getProjectStore,
  resetProjectStoresForTests,
  type ProjectStore,
} from "../site/src/islands/project-store.js";
import {
  resetManuscriptSurfaceModuleLoaderForTests,
  setManuscriptSurfaceModuleLoaderForTests,
} from "../site/src/islands/manuscript-surface-loader.js";
import type {
  ManuscriptSurfaceModule,
  ManuscriptSurfaceOptions,
  ManuscriptSurfaceSession,
} from "../site/src/islands/manuscript-surface.js";
import type { ChapterNotesTargetAdapter } from "../site/src/islands/chapter-notes-presentation.js";

/**
 * Smoke tests for the `<authorbot-collab>` element wiring (Phase 2b contract
 * §2): auth states, sign-in link with return_to, per-block affordances,
 * card rendering with plain-text bodies. The network is a URL-routed stub.
 */

const CHAPTER_ID = "019cadfd-8900-7140-98fb-ceff64cada33";
const BLOCK_ID = "019cadfe-7360-7049-a30b-1f5898a5020a";
const API = "http://api.test";

if (customElements.get("authorbot-collab") === undefined) {
  customElements.define("authorbot-collab", AuthorbotCollab);
}

type RouteMap = Record<string, { status: number; body: unknown }>;

function stubFetch(routes: RouteMap): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const found = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
      const route = found?.[1] ?? { status: 404, body: { detail: "not found" } };
      return {
        ok: route.status >= 200 && route.status < 300,
        status: route.status,
        json: async () => structuredClone(route.body),
      } as Response;
    }),
  );
}

function mount(attrs: Record<string, string> = {}): AuthorbotCollab {
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
  for (const [key, value] of Object.entries(attrs)) {
    element.setAttribute(key, value);
  }
  (document.querySelector("main") as HTMLElement).append(element);
  return element;
}

beforeEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, "", "/chapters/baseline/");
  resetProjectStoresForTests();
});

afterEach(() => {
  resetManuscriptSurfaceModuleLoaderForTests();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("authorbot-collab element", () => {
  it("signed out: renders the GitHub sign-in link with return_to (§2.4)", async () => {
    stubFetch({
      [`${API}/v1/me`]: { status: 401, body: { detail: "unauthorized" } },
      [`${API}/v1/projects/`]: { status: 401, body: { detail: "unauthorized" } },
    });
    mount();
    await expect.poll(() => document.querySelector<HTMLAnchorElement>(".ab-signin")).toBeTruthy();
    const link = document.querySelector<HTMLAnchorElement>(".ab-signin") as HTMLAnchorElement;
    expect(link.href).toContain(`${API}/v1/auth/github?return_to=`);
    expect(link.href).toContain(encodeURIComponent("http"));
    // No cards, no errors; prose untouched.
    expect(document.querySelectorAll(".ab-card").length).toBe(0);
    expect(document.querySelector(".prose p")?.textContent).toBe(
      "The drift appeared on a Tuesday.",
    );
  });

  it("renders the dev-login form only behind the build flag (§2.4)", async () => {
    stubFetch({
      [`${API}/v1/me`]: { status: 401, body: {} },
      [`${API}/v1/projects/`]: { status: 401, body: {} },
    });
    mount({ "data-dev-login": "true" });
    await expect.poll(() => document.querySelector(".ab-devlogin")).toBeTruthy();
    expect(document.querySelector(".ab-signin")).toBeNull();
    const form = document.querySelector(".ab-devlogin") as HTMLFormElement;
    expect(form.querySelector("input[name=login]")).toBeTruthy();
    expect(form.querySelectorAll("option").length).toBe(4);
  });

  it("keeps a login form mounted during an authoritative annotation refresh", async () => {
    const annotation = {
      id: "ann-refresh",
      chapterId: CHAPTER_ID,
      kind: "suggestion",
      scope: "block",
      chapterRevision: 3,
      target: { blockId: BLOCK_ID },
      authorActorId: "actor-1",
      body: "Tighten this block.",
      status: "open",
      gitOperationId: null,
      createdAt: "2026-07-19T00:00:00Z",
      decision: {
        id: "decision-1",
        actionType: "create_work_item",
        result: "accepted",
        supportChanged: false,
        workItemId: "work-1",
      },
    };
    stubFetch({
      [`${API}/v1/me`]: { status: 401, body: {} },
      [`${API}/v1/projects/hollow-creek-anomaly/chapters/${CHAPTER_ID}/annotations`]: {
        status: 200,
        body: { items: [annotation], nextCursor: null },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/annotations/ann-refresh/replies`]: {
        status: 200,
        body: {
          items: [
            {
              id: "reply-1",
              annotationId: "ann-refresh",
              parentReplyId: null,
              authorActorId: "actor-2",
              body: "Agreed.",
              status: "open",
              gitOperationId: null,
              createdAt: "2026-07-19T00:01:00Z",
            },
          ],
          nextCursor: null,
        },
      },
    });
    mount({ "data-dev-login": "true" });
    await expect
      .poll(() => document.querySelector<HTMLInputElement>(".ab-devlogin input"))
      .toBeTruthy();
    const input = document.querySelector<HTMLInputElement>(
      ".ab-devlogin input",
    ) as HTMLInputElement;
    const form = input.closest("form");
    input.value = "still-typing";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    annotation.status = "pending_git";

    await getProjectStore({ apiBase: API, project: "hollow-creek-anomaly" })
      .getState()
      .refreshAnnotations(CHAPTER_ID);

    const refreshed = document.querySelector<HTMLInputElement>(
      ".ab-devlogin input",
    ) as HTMLInputElement;
    expect(refreshed).toBe(input);
    expect(refreshed.closest("form")).toBe(form);
    expect(refreshed.value).toBe("still-typing");
  });

  it("adds a keyboard 'Annotate' affordance per anchored block (§2.2, §4)", async () => {
    stubFetch({
      [`${API}/v1/me`]: { status: 401, body: {} },
      [`${API}/v1/projects/`]: { status: 401, body: {} },
    });
    mount();
    await expect.poll(() => document.querySelectorAll(".ab-annotate").length).toBe(1);
    const button = document.querySelector(".ab-annotate") as HTMLButtonElement;
    expect(button.getAttribute("aria-label")).toBe("Note on this block");
    // Injected UI is marked so the normalizer skips it and sits outside the
    // block element (the block's own text is pristine).
    expect(button.closest("[data-ab-ui]")).toBeTruthy();
    expect(button.closest(`#b-${BLOCK_ID}`)).toBeNull();
  });

  it("signed in: renders annotation cards with escaped plain-text bodies (§3)", async () => {
    const hostileBody = "First line\n<img src=x onerror=alert(1)> & <script>alert(2)</script>";
    stubFetch({
      [`${API}/v1/me`]: {
        status: 200,
        body: {
          actor: { id: "actor-1", displayName: "mara", externalIdentity: "github:mara" },
          scopes: ["chapters:read", "annotations:read", "annotations:write"],
        },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/members`]: {
        status: 200,
        body: { items: [], nextCursor: null },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/chapters/${CHAPTER_ID}/annotations`]: {
        status: 200,
        body: {
          items: [
            {
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
              authorActorId: "actor-1",
              body: hostileBody,
              status: "open",
              gitOperationId: null,
              createdAt: "2026-07-19T00:00:00Z",
            },
          ],
          nextCursor: null,
        },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/annotations/ann-1/replies`]: {
        status: 404,
        body: { detail: "no such route" },
      },
    });
    mount();
    await expect.poll(() => document.querySelectorAll(".ab-card").length).toBe(1);
    const card = document.querySelector(".ab-card") as HTMLElement;
    // Body is textContent: markup survives as inert text, never as elements.
    expect(card.querySelector(".ab-body")?.textContent).toBe(hostileBody);
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector("script")).toBeNull();
    // Labeled region announcing quote + author + status (§4).
    const label = card.getAttribute("aria-label") ?? "";
    expect(label).toContain("Suggestion");
    expect(label).toContain("mara");
    expect(label).toContain("drift");
    expect(label).toContain("open");
    // Author sees the withdraw affordance; a reply affordance exists.
    const buttons = [...card.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toContain("Withdraw");
    expect(buttons).toContain("Reply");
    // Identity belongs to the shared account control, not the Notes rail.
    expect(document.querySelector(".ab-authbar .ab-me")).toBeNull();
    expect((document.querySelector(".ab-authbar") as HTMLElement)?.hidden).toBe(true);
    expect(document.querySelector(".ab-marker-count")?.textContent).toBe("1");
    expect(document.querySelector(`#b-${BLOCK_ID}`)?.classList.contains("ab-annotated")).toBe(
      true,
    );
    const highlight = document.querySelector(".ab-inline-highlight");
    expect(highlight?.textContent).toBe("drift");
    expect(highlight?.classList.contains("ab-highlight-suggestion")).toBe(true);
    expect(highlight?.getAttribute("tabindex")).toBe("0");

    // Navigation is reciprocal: selecting prose reveals its card, and
    // selecting the card brings the anchored prose back into view.
    const targetBlock = document.getElementById(`b-${BLOCK_ID}`) as HTMLElement;
    const scrollTarget = vi.fn();
    targetBlock.scrollIntoView = scrollTarget;
    card.click();
    expect(scrollTarget).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
      behavior: "smooth",
    });
  });

  it("activates the lazy Milkdown Notes surface only after an authenticated reader asks", async () => {
    const highlights = vi.fn();
    const destroy = vi.fn(async () => {});
    const adapter: ChapterNotesTargetAdapter = {
      elementFor: () => null,
      observeVisibility: () => () => {},
      setPreview: vi.fn(),
      reveal: vi.fn(),
      clearInlineNotes: vi.fn(),
      mountInlineNote: vi.fn(),
      setHighlights: highlights,
    };
    const create = vi.fn(async (options: ManuscriptSurfaceOptions) => {
      options.root.append(document.createElement("div"));
      return {
        activation: "notes",
        notes: adapter,
        dirty: false,
        getMarkdown: () => options.markdown,
        focus: vi.fn(),
        submit: vi.fn(),
        destroy,
      } as unknown as ManuscriptSurfaceSession;
    });
    setManuscriptSurfaceModuleLoaderForTests(async () => ({
      createManuscriptSurface: create,
    } satisfies ManuscriptSurfaceModule));
    stubFetch({
      [`${API}/v1/me`]: {
        status: 200,
        body: {
          actor: { id: "actor-1", displayName: "mara", externalIdentity: "github:mara" },
          scopes: [],
          capabilityMode: "canonical",
          effectiveCapabilities: ["chapters:read", "comments:read"],
        },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/members`]: {
        status: 200,
        body: { items: [], nextCursor: null },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/chapters/${CHAPTER_ID}/annotations`]: {
        status: 200,
        body: {
          items: [{
            id: "ann-rich",
            chapterId: CHAPTER_ID,
            kind: "comment",
            scope: "range",
            chapterRevision: 3,
            target: {
              blockId: BLOCK_ID,
              textPosition: { start: 4, end: 9 },
              textQuote: { exact: "drift" },
            },
            authorActorId: "actor-1",
            body: "Keep this anchored in rich Notes mode.",
            status: "open",
            gitOperationId: null,
            createdAt: "2026-07-19T00:00:00Z",
          }],
          nextCursor: null,
        },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/annotations/ann-rich/replies`]: {
        status: 200,
        body: { items: [], nextCursor: null },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/chapters/${CHAPTER_ID}/source`]: {
        status: 200,
        body: {
          chapterId: CHAPTER_ID,
          title: "Loose Ends",
          summary: null,
          revision: 3,
          contentHash: `sha256:${"a".repeat(64)}`,
          status: "published",
          body: "The drift appeared on a Tuesday.",
        },
      },
    });
    mount();
    await expect.poll(() => document.querySelector<HTMLButtonElement>(".ab-notes-mode-toggle"))
      .toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    const toggle = document.querySelector<HTMLButtonElement>(".ab-notes-mode-toggle")!;
    toggle.click();
    await expect.poll(() => create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      activation: "notes",
      markdown: "The drift appeared on a Tuesday.",
      blockIds: [BLOCK_ID],
      allowBlockNotes: false,
    });
    expect((document.querySelector(".prose") as HTMLElement).hidden).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(highlights).toHaveBeenCalledWith([
      expect.objectContaining({ annotationId: "ann-rich", blockId: BLOCK_ID }),
    ]);

    toggle.click();
    await expect.poll(() => destroy).toHaveBeenCalledTimes(1);
    expect((document.querySelector(".prose") as HTMLElement).hidden).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("mounts and activates a source-note fragment after annotations hydrate", async () => {
    const annotation = (id: string, body: string) => ({
      id,
      chapterId: CHAPTER_ID,
      kind: "suggestion",
      scope: "block",
      chapterRevision: 3,
      target: { blockId: BLOCK_ID },
      authorActorId: "actor-1",
      body,
      status: "work_item_created",
      gitOperationId: null,
      createdAt: "2026-07-19T00:00:00Z",
    });
    stubFetch({
      [`${API}/v1/me`]: {
        status: 200,
        body: {
          actor: { id: "actor-1", displayName: "mara", externalIdentity: "github:mara" },
          scopes: ["chapters:read", "annotations:read"],
        },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/members`]: {
        status: 200,
        body: { items: [], nextCursor: null },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/chapters/${CHAPTER_ID}/annotations`]: {
        status: 200,
        body: {
          items: [
            annotation("ann-first", "First note."),
            annotation("ann-linked", "Linked completed-work source."),
          ],
          nextCursor: null,
        },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/annotations/ann-first/replies`]: {
        status: 404,
        body: { detail: "replies unavailable" },
      },
    });
    window.history.replaceState(
      null,
      "",
      "/chapters/baseline/#authorbot-note-ann-linked",
    );
    mount();

    await expect.poll(() => document.querySelectorAll(".ab-card").length).toBe(2);
    const linked = document.getElementById("authorbot-note-ann-linked") as HTMLElement;
    expect(linked).toBeTruthy();
    expect(linked.classList.contains("ab-active")).toBe(true);
    expect(linked.querySelector(".ab-card-summary")?.getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(document.getElementById("authorbot-note-ann-first")?.classList.contains("ab-active"))
      .toBe(false);
  });

  it("renders zero collaboration chrome when the API is unreachable (§1)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("connection refused");
      }),
    );
    mount({ "data-dev-login": "true" });
    // Give the probe time to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector(".ab-gutter")).toBeNull();
    expect(document.querySelector(".ab-drawer")).toBeNull();
    expect(document.querySelector(".ab-annotate")).toBeNull();
    expect(document.querySelector(".ab-authbar")).toBeNull();
    expect(document.querySelector(".ab-error")).toBeNull();
    expect(document.querySelector("main")?.classList.contains("ab-enabled")).toBe(false);
    expect(document.querySelector(".prose p")?.textContent).toBe(
      "The drift appeared on a Tuesday.",
    );
  });

  it("hides annotate pencils for a signed-in read-only role; keeps them for signed-out visitors", async () => {
    stubFetch({
      [`${API}/v1/me`]: {
        status: 200,
        body: {
          actor: { id: "actor-9", displayName: "rita", externalIdentity: "github:rita" },
          scopes: ["chapters:read", "annotations:read"], // no annotations:write
        },
      },
      [`${API}/v1/projects/`]: { status: 200, body: { items: [], nextCursor: null } },
    });
    mount();
    await expect.poll(() => document.querySelector(".ab-authbar .ab-hint")).toBeTruthy();
    const pencil = document.querySelector<HTMLButtonElement>(".ab-annotate");
    expect(pencil?.hidden).toBe(true);
  });

  it("signed-out pencil click leads to the sign-in affordance, not a dead-end composer", async () => {
    stubFetch({
      [`${API}/v1/me`]: { status: 401, body: {} },
      [`${API}/v1/projects/`]: { status: 401, body: {} },
    });
    mount();
    await expect.poll(() => document.querySelector(".ab-signin")).toBeTruthy();
    const pencil = document.querySelector<HTMLButtonElement>(".ab-annotate");
    expect(pencil?.hidden).toBe(false);
    pencil?.click();
    expect(document.querySelector(".ab-composer")).toBeNull();
    expect(document.activeElement?.classList.contains("ab-signin")).toBe(true);
  });

  it("announces block scope, mounts mobile notes inline, and previews the block accessibly", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      media: "(min-width: 960px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })));
    stubFetch({
      [`${API}/v1/me`]: {
        status: 200,
        body: {
          actor: { id: "actor-1", displayName: "mara", externalIdentity: "github:mara" },
          scopes: ["chapters:read", "annotations:read", "annotations:write"],
        },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/members`]: {
        status: 200,
        body: { items: [], nextCursor: null },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/chapters/${CHAPTER_ID}/annotations`]: {
        status: 200,
        body: {
          items: [
            {
              id: "ann-b",
              chapterId: CHAPTER_ID,
              kind: "comment",
              scope: "block",
              chapterRevision: 3,
              target: { blockId: BLOCK_ID },
              authorActorId: "actor-1",
              body: "block-scoped note",
              status: "open",
              gitOperationId: null,
              createdAt: "2026-07-19T00:00:00Z",
            },
          ],
          nextCursor: null,
        },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/annotations/ann-b/replies`]: {
        status: 200,
        body: { items: [], nextCursor: null },
      },
    });
    mount();
    await expect.poll(() => document.querySelectorAll(".ab-card").length).toBe(1);
    // Block-scoped cards announce the block, never "this chapter".
    const label = document.querySelector(".ab-card")?.getAttribute("aria-label") ?? "";
    expect(label).toContain("on this block");
    expect(label).not.toContain("on this chapter");
    expect(document.querySelector(".ab-drawer")).toBeNull();
    expect(document.querySelector(`.ab-inline-notes[data-block-id="${BLOCK_ID}"] .ab-card`))
      .toBe(document.querySelector(".ab-card"));
    // Decorative pencil glyph is hidden from AT.
    expect(
      document.querySelector(".ab-annotate-glyph")?.getAttribute("aria-hidden"),
    ).toBe("true");
    const block = document.getElementById(`b-${BLOCK_ID}`) as HTMLElement;
    const annotate = document.querySelector(".ab-annotate") as HTMLButtonElement;
    const tooltip = document.getElementById(annotate.getAttribute("aria-describedby") ?? "") as HTMLElement;
    expect(tooltip.getAttribute("role")).toBe("tooltip");
    annotate.dispatchEvent(new Event("pointerenter"));
    expect(tooltip.hidden).toBe(false);
    expect(block.classList.contains("ab-note-target-preview")).toBe(true);
    annotate.dispatchEvent(new Event("pointerleave"));
    expect(tooltip.hidden).toBe(true);
    expect(block.classList.contains("ab-note-target-preview")).toBe(false);
    // §2.1 vice-versa: hovering the anchor block highlights its card.
    block.dispatchEvent(new Event("mouseenter"));
    expect(document.querySelector(".ab-card")?.classList.contains("ab-hovered")).toBe(true);
    block.dispatchEvent(new Event("mouseleave"));
    expect(document.querySelector(".ab-card")?.classList.contains("ab-hovered")).toBe(false);
  });

  it("keeps a half-typed reply draft and focus across a background re-render (§4)", async () => {
    stubFetch({
      [`${API}/v1/me`]: {
        status: 200,
        body: {
          actor: { id: "actor-1", displayName: "mara", externalIdentity: "github:mara" },
          scopes: ["chapters:read", "annotations:read", "annotations:write"],
        },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/members`]: {
        status: 200,
        body: { items: [], nextCursor: null },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/chapters/${CHAPTER_ID}/annotations`]: {
        status: 200,
        body: {
          items: [
            {
              id: "ann-d",
              chapterId: CHAPTER_ID,
              kind: "comment",
              scope: "block",
              chapterRevision: 3,
              target: { blockId: BLOCK_ID },
              authorActorId: "actor-1",
              body: "existing card",
              status: "open",
              gitOperationId: null,
              createdAt: "2026-07-19T00:00:00Z",
            },
          ],
          nextCursor: null,
        },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/annotations/ann-d/replies`]: {
        status: 200,
        body: { items: [], nextCursor: null },
      },
    });
    const element = mount();
    await expect.poll(() => document.querySelectorAll(".ab-card").length).toBe(1);

    // Open the reply form and type a draft.
    const replyButton = [...document.querySelectorAll<HTMLButtonElement>(".ab-card button")].find(
      (b) => b.textContent === "Reply",
    ) as HTMLButtonElement;
    replyButton.click();
    const textarea = document.querySelector(
      ".ab-reply-form textarea",
    ) as HTMLTextAreaElement;
    textarea.focus();
    textarea.value = "half-typed reply the user cares about";
    textarea.dispatchEvent(new Event("input"));

    // An unrelated background sync settles → full re-render.
    (element as unknown as { renderAll(): void }).renderAll();

    const rebuilt = document.querySelector(".ab-reply-form textarea") as HTMLTextAreaElement;
    expect(rebuilt).not.toBeNull();
    expect(rebuilt.value).toBe("half-typed reply the user cares about");
    expect(document.activeElement).toBe(rebuilt);
  });

  it("renders authoritative body and status changes for an existing reply id", async () => {
    const replyId = "reply-same-id";
    stubFetch({
      [`${API}/v1/me`]: {
        status: 200,
        body: {
          actor: { id: "actor-1", displayName: "mara", externalIdentity: "github:mara" },
          scopes: ["chapters:read", "annotations:read", "annotations:write"],
        },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/members`]: {
        status: 200,
        body: { items: [], nextCursor: null },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/chapters/${CHAPTER_ID}/annotations`]: {
        status: 200,
        body: {
          items: [
            {
              id: "ann-reply-refresh",
              chapterId: CHAPTER_ID,
              kind: "comment",
              scope: "block",
              chapterRevision: 3,
              target: { blockId: BLOCK_ID },
              authorActorId: "actor-1",
              body: "Thread owner",
              status: "open",
              gitOperationId: null,
              createdAt: "2026-07-19T00:00:00Z",
            },
          ],
          nextCursor: null,
        },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/annotations/ann-reply-refresh/replies`]: {
        status: 200,
        body: {
          items: [
            {
              id: replyId,
              projectId: "hollow-creek-anomaly",
              annotationId: "ann-reply-refresh",
              parentReplyId: null,
              authorActorId: "actor-2",
              body: "Optimistic reply",
              status: "pending_git",
              gitOperationId: "op-reply-refresh",
              createdAt: "2026-07-19T00:00:00Z",
              updatedAt: "2026-07-19T00:00:00Z",
            },
          ],
          nextCursor: null,
        },
      },
    });
    const element = mount();
    await expect.poll(() => document.querySelector(".ab-reply .ab-body")?.textContent).toBe(
      "Optimistic reply",
    );
    expect(document.querySelector(".ab-reply .ab-status-syncing")).not.toBeNull();

    const store = (element as unknown as { store: ProjectStore }).store;
    const before = store.getState().repliesById[replyId];
    expect(before).toBeDefined();
    store.setState({
      repliesById: {
        ...store.getState().repliesById,
        [replyId]: {
          ...before!,
          body: "Authoritative reply",
          status: "open",
          gitOperationId: null,
          updatedAt: "2026-07-19T00:00:01Z",
        },
      },
    });

    await expect.poll(() => document.querySelector(".ab-reply .ab-body")?.textContent).toBe(
      "Authoritative reply",
    );
    expect(document.querySelector(".ab-reply .ab-status-syncing")).toBeNull();
  });

  it("closes reply-withdraw confirmation optimistically and restores a rejected reply", async () => {
    let finishWithdraw: ((response: Response) => void) | undefined;
    const pendingWithdraw = new Promise<Response>((resolve) => {
      finishWithdraw = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/v1/me")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              actor: { id: "actor-1", displayName: "mara", externalIdentity: "github:mara" },
              scopes: [],
              memberships: [{ projectId: "project-1", role: "contributor" }],
              capabilityMode: "canonical",
              effectiveCapabilities: [
                "comments:read",
                "replies:write",
                "feedback:withdraw-own",
              ],
            }),
          } as Response;
        }
        if (
          init?.method === "POST" &&
          url.endsWith("/annotations/ann-reply-withdraw/replies/reply-own/withdraw")
        ) {
          return pendingWithdraw;
        }
        if (url.includes(`/chapters/${CHAPTER_ID}/annotations`)) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              items: [{
                id: "ann-reply-withdraw",
                chapterId: CHAPTER_ID,
                kind: "comment",
                scope: "block",
                chapterRevision: 3,
                target: { blockId: BLOCK_ID },
                authorActorId: "actor-2",
                body: "Thread owner",
                status: "open",
                gitOperationId: null,
                createdAt: "2026-07-19T00:00:00Z",
              }],
              nextCursor: null,
            }),
          } as Response;
        }
        if (url.includes("/annotations/ann-reply-withdraw/replies")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              items: [{
                id: "reply-own",
                projectId: "project-1",
                annotationId: "ann-reply-withdraw",
                parentReplyId: null,
                authorActorId: "actor-1",
                body: "Keep this visible if the command is rejected.",
                status: "open",
                gitOperationId: null,
                createdAt: "2026-07-19T00:01:00Z",
                updatedAt: "2026-07-19T00:01:00Z",
              }],
              nextCursor: null,
            }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [], nextCursor: null }),
        } as Response;
      }),
    );

    mount();
    await expect.poll(() => document.querySelector(".ab-reply .ab-body")?.textContent).toBe(
      "Keep this visible if the command is rejected.",
    );
    const withdraw = [...document.querySelectorAll<HTMLButtonElement>(".ab-reply button")].find(
      (button) => button.textContent === "Withdraw reply",
    ) as HTMLButtonElement;
    withdraw.click();
    const confirm = [...document.querySelectorAll<HTMLButtonElement>(".ab-reply button")].find(
      (button) => button.textContent === "Confirm withdraw reply",
    ) as HTMLButtonElement;
    expect(confirm).toBeTruthy();
    expect(document.querySelector(".ab-reply button")?.textContent).not.toBe("Withdraw reply");

    confirm.click();
    // The confirmation closes and the reply body disappears before the
    // deliberately unresolved HTTP request returns.
    expect(document.querySelector(".ab-reply-withdrawn")?.textContent).toBe("Reply withdrawn.");
    expect(document.querySelector(".ab-reply .ab-body")).toBeNull();
    expect(
      [...document.querySelectorAll<HTMLButtonElement>(".ab-reply button")].some(
        (button) => button.textContent === "Confirm withdraw reply",
      ),
    ).toBe(false);

    finishWithdraw?.({
      ok: false,
      status: 403,
      json: async () => ({ detail: "reply withdrawal is forbidden" }),
    } as Response);
    await expect.poll(() => document.querySelector(".ab-reply .ab-body")?.textContent).toBe(
      "Keep this visible if the command is rejected.",
    );
    expect(document.querySelector(".ab-reply")?.textContent).toContain("Your role is read-only here.");
    expect(
      [...document.querySelectorAll<HTMLButtonElement>(".ab-reply button")].some(
        (button) => button.textContent === "Withdraw reply",
      ),
    ).toBe(true);
  });

  it("clears and closes the note composer before its POST finishes", async () => {
    let finishPost: ((response: Response) => void) | undefined;
    const pendingPost = new Promise<Response>((resolve) => {
      finishPost = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/v1/me")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              actor: { id: "actor-1", displayName: "mara", externalIdentity: "github:mara" },
              scopes: ["chapters:read", "annotations:read", "annotations:write"],
            }),
          } as Response;
        }
        if (init?.method === "POST" && url.includes("/chapters/") && url.endsWith("/annotations")) {
          return pendingPost;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [], nextCursor: null }),
        } as Response;
      }),
    );

    mount();
    await expect.poll(() => document.querySelector(".ab-annotate")).toBeTruthy();
    (document.querySelector(".ab-annotate") as HTMLButtonElement).click();
    const form = document.querySelector(".ab-composer") as HTMLFormElement;
    const textarea = form.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "Close this composer immediately.";
    textarea.dispatchEvent(new Event("input"));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    // The fetch promise is deliberately unresolved. Closing cannot depend on
    // the round trip or operation polling.
    expect(document.querySelector(".ab-composer")).toBeNull();
    finishPost?.({
      ok: true,
      status: 202,
      json: async () => ({ annotationId: "ann-new", operationId: "op-new" }),
    } as Response);
    await expect.poll(() => document.querySelector(".ab-card")?.textContent).toContain(
      "Close this composer immediately.",
    );
  });

  it("clears and closes the reply form before its POST finishes", async () => {
    let finishPost: ((response: Response) => void) | undefined;
    const pendingPost = new Promise<Response>((resolve) => {
      finishPost = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/v1/me")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              actor: { id: "actor-1", displayName: "mara", externalIdentity: "github:mara" },
              scopes: ["chapters:read", "annotations:read", "annotations:write"],
            }),
          } as Response;
        }
        if (init?.method === "POST" && url.endsWith("/annotations/ann-r/replies")) {
          return pendingPost;
        }
        if (url.includes(`/chapters/${CHAPTER_ID}/annotations`)) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              items: [{
                id: "ann-r",
                chapterId: CHAPTER_ID,
                kind: "comment",
                scope: "block",
                chapterRevision: 3,
                target: { blockId: BLOCK_ID },
                authorActorId: "actor-1",
                body: "Existing note",
                status: "open",
                gitOperationId: null,
                createdAt: "2026-07-19T00:00:00Z",
              }],
              nextCursor: null,
            }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: [], nextCursor: null }),
        } as Response;
      }),
    );

    mount();
    await expect.poll(() => document.querySelector(".ab-card")).toBeTruthy();
    const reply = [...document.querySelectorAll<HTMLButtonElement>(".ab-card button")].find(
      (button) => button.textContent === "Reply",
    ) as HTMLButtonElement;
    reply.click();
    const form = document.querySelector(".ab-reply-form") as HTMLFormElement;
    const textarea = form.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "Close this reply immediately.";
    textarea.dispatchEvent(new Event("input"));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(document.querySelector(".ab-reply-form")).toBeNull();
    finishPost?.({
      ok: true,
      status: 202,
      json: async () => ({ replyId: "reply-new", operationId: "op-reply" }),
    } as Response);
    await expect.poll(() => document.querySelector(".ab-reply")?.textContent).toContain(
      "Close this reply immediately.",
    );
  });

  it("keeps polling through a transient conflict state instead of settling failed (§2.5)", async () => {
    vi.useFakeTimers();
    let operationCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = ((): unknown => {
          if (url.includes("/v1/me")) {
            return {
              actor: { id: "actor-1", displayName: "mara", externalIdentity: "github:mara" },
              scopes: ["chapters:read", "annotations:read", "annotations:write"],
            };
          }
          if (url.includes("/operations/op-c")) {
            operationCalls += 1;
            // conflict is the bounded-retry state: it must NOT read as failed.
            return {
              id: "op-c",
              state: operationCalls < 3 ? "conflict" : "committed",
              error: "non-fast-forward",
            };
          }
          if (url.includes("/annotations") && url.includes("/replies")) {
            return { items: [], nextCursor: null };
          }
          if (url.includes("/annotations")) {
            return {
              items: [
                {
                  id: "ann-c",
                  chapterId: CHAPTER_ID,
                  kind: "comment",
                  scope: "block",
                  chapterRevision: 3,
                  target: { blockId: BLOCK_ID },
                  authorActorId: "actor-1",
                  body: "conflicted body",
                  status: "pending_git",
                  gitOperationId: "op-c",
                  createdAt: "2026-07-19T00:00:00Z",
                },
              ],
              nextCursor: null,
            };
          }
          return { items: [], nextCursor: null };
        })();
        return {
          ok: true,
          status: 200,
          json: async () => body,
        } as Response;
      }),
    );
    mount();
    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(8000);
    }
    const card = document.querySelector(".ab-card") as HTMLElement;
    // Never labeled failed; the operation committed on retry.
    expect(card.textContent).not.toContain("failed");
    expect(card.textContent).not.toContain("non-fast-forward");
    expect(operationCalls).toBeGreaterThanOrEqual(3);
    vi.useRealTimers();
  });

  it("maps a stale-revision 409 to a human message and disables Post (§2.5)", async () => {
    stubFetch({
      [`${API}/v1/me`]: {
        status: 200,
        body: {
          actor: { id: "actor-1", displayName: "mara", externalIdentity: "github:mara" },
          scopes: ["chapters:read", "annotations:read", "annotations:write"],
        },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/members`]: {
        status: 200,
        body: { items: [], nextCursor: null },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/chapters/${CHAPTER_ID}/annotations`]: {
        status: 409,
        body: {
          code: "revision-conflict",
          detail: "chapterRevision 3 does not match projected revision 4",
          projectedRevision: 4,
        },
      },
    });
    mount();
    await expect.poll(() => document.querySelector(".ab-annotate")).toBeTruthy();
    (document.querySelector(".ab-annotate") as HTMLButtonElement).click();
    const composer = document.querySelector(".ab-composer") as HTMLFormElement;
    expect(composer).not.toBeNull();
    const textarea = composer.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "will hit 409";
    textarea.dispatchEvent(new Event("input"));
    composer.dispatchEvent(new Event("submit"));
    await expect.poll(() => document.querySelector(".ab-composer .ab-error")).toBeTruthy();
    const error = document.querySelector(".ab-composer .ab-error") as HTMLElement;
    expect(error.textContent).toContain("republished");
    expect(error.textContent).not.toContain("projected revision");
    const post = [...document.querySelectorAll<HTMLButtonElement>(".ab-composer button")].find(
      (b) => b.textContent === "Post",
    ) as HTMLButtonElement;
    expect(post.disabled).toBe(true);
  });

  it("shows pending_git records as syncing and leaves a refresh hint when polling exhausts (§2.5)", async () => {
    vi.useFakeTimers();
    stubFetch({
      [`${API}/v1/me`]: {
        status: 200,
        body: {
          actor: { id: "actor-1", displayName: "mara", externalIdentity: "github:mara" },
          scopes: ["chapters:read", "annotations:read", "annotations:write"],
        },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/members`]: {
        status: 200,
        body: { items: [], nextCursor: null },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/chapters/${CHAPTER_ID}/annotations`]: {
        status: 200,
        body: {
          items: [
            {
              id: "ann-2",
              chapterId: CHAPTER_ID,
              kind: "comment",
              scope: "block",
              chapterRevision: 3,
              target: { blockId: BLOCK_ID },
              authorActorId: "actor-1",
              body: "pending body",
              status: "pending_git",
              gitOperationId: "op-9",
              createdAt: "2026-07-19T00:00:00Z",
            },
          ],
          nextCursor: null,
        },
      },
      [`${API}/v1/projects/hollow-creek-anomaly/annotations/ann-2/replies`]: {
        status: 404,
        body: {},
      },
      [`${API}/v1/projects/hollow-creek-anomaly/operations/op-9`]: {
        status: 200,
        body: { id: "op-9", state: "queued", error: null },
      },
    });
    mount();
    // Let the async fetch chain settle, then walk the bounded poll schedule.
    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(8000);
    }
    const card = document.querySelector(".ab-card") as HTMLElement;
    expect(card.textContent).toContain("syncing");
    expect(card.textContent).toContain("refresh the page");
    vi.useRealTimers();
  });
});
