// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterNotesTargetAdapter } from "../site/src/islands/chapter-notes-presentation.js";
import {
  AuthorbotManuscriptEditor,
  CHAPTER_REVISION_SUBMIT_EVENT,
  type ChapterRevisionSubmitEventDetail,
} from "../site/src/islands/manuscript-editor-element.js";
import {
  resetManuscriptSurfaceModuleLoaderForTests,
  setManuscriptSurfaceModuleLoaderForTests,
} from "../site/src/islands/manuscript-surface-loader.js";
import type {
  ManuscriptSurfaceModule,
  ManuscriptSurfaceOptions,
  ManuscriptSurfaceSession,
} from "../site/src/islands/manuscript-surface.js";
import { resetProjectStoresForTests } from "../site/src/islands/project-store.js";

const API = "http://api.test";
const PROJECT = "hollow-creek-anomaly";
const CHAPTER = "019cadfd-8900-7140-98fb-ceff64cada33";
const BLOCK = "019cadfe-7360-7049-a30b-1f5898a5020a";

if (customElements.get("authorbot-manuscript-editor") === undefined) {
  customElements.define("authorbot-manuscript-editor", AuthorbotManuscriptEditor);
}

const session = (options: ManuscriptSurfaceOptions): ManuscriptSurfaceSession => ({
  activation: options.activation,
  notes: {
    elementFor: () => null,
    observeVisibility: () => () => {},
    setPreview: () => {},
    reveal: () => {},
    clearInlineNotes: () => {},
    mountInlineNote: () => {},
  } satisfies ChapterNotesTargetAdapter,
  dirty: false,
  getMarkdown: () => "Edited chapter prose.",
  focus: vi.fn(),
  submit: () => options.onSubmit?.({ markdown: "Edited chapter prose." }) ??
    Promise.resolve({ ok: false, message: "not connected" }),
  destroy: vi.fn(async () => {}),
});

let requests: string[];
let createSurface: ReturnType<typeof vi.fn<(options: ManuscriptSurfaceOptions) => Promise<ManuscriptSurfaceSession>>>;

function me(scopes: string[]) {
  return {
    actor: { id: "actor-1", displayName: "Mara", externalIdentity: "github:mara" },
    memberships: [{ role: "editor" }],
    scopes,
  };
}

function stubFetch(scopes: string[], sourceStatus = 200): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url === `${API}/v1/me`) {
      return new Response(JSON.stringify(me(scopes)), { status: 200 });
    }
    if (url.endsWith(`/chapters/${CHAPTER}/source`)) {
      return new Response(JSON.stringify({
        chapterId: CHAPTER,
        title: "Loose Ends",
        summary: null,
        revision: 12,
        contentHash: `sha256:${"a".repeat(64)}`,
        status: "published",
        body: "Original chapter prose.",
      }), { status: sourceStatus });
    }
    return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
  }));
}

function mount(): AuthorbotManuscriptEditor {
  document.body.innerHTML = `<article>
    <authorbot-manuscript-editor
      data-api-base="${API}"
      data-project="${PROJECT}"
      data-chapter-id="${CHAPTER}"
      data-chapter-title="Loose Ends"></authorbot-manuscript-editor>
    <div class="prose"><p id="b-${BLOCK}">Original chapter prose.</p></div>
  </article>`;
  return document.querySelector("authorbot-manuscript-editor") as AuthorbotManuscriptEditor;
}

beforeEach(() => {
  requests = [];
  resetProjectStoresForTests();
  window.sessionStorage.clear();
  createSurface = vi.fn(async (options: ManuscriptSurfaceOptions) => {
    const editor = document.createElement("div");
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-label", options.accessibleName);
    options.root.append(editor);
    return session(options);
  });
  const module: ManuscriptSurfaceModule = { createManuscriptSurface: createSurface };
  setManuscriptSurfaceModuleLoaderForTests(vi.fn(async () => module));
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  resetManuscriptSurfaceModuleLoaderForTests();
  resetProjectStoresForTests();
  window.sessionStorage.clear();
});

describe("in-place manuscript editor launcher", () => {
  it("keeps static reading intact and Milkdown unloaded until Edit is activated", async () => {
    stubFetch(["chapters:read", "revisions:write"]);
    mount();
    await expect.poll(() => document.querySelector(".ab-manuscript-edit")).toBeTruthy();

    const prose = document.querySelector<HTMLElement>(".prose")!;
    expect(prose.hidden).toBe(false);
    expect(createSurface).not.toHaveBeenCalled();
    expect(requests.some((url) => url.endsWith("/source"))).toBe(false);

    (document.querySelector(".ab-manuscript-edit") as HTMLButtonElement).click();
    await expect.poll(() => createSurface.mock.calls.length).toBe(1);
    expect(prose.hidden).toBe(true);
    expect(document.querySelector('[role="textbox"]')?.getAttribute("aria-label"))
      .toBe("Chapter text for Loose Ends");
    expect(createSurface.mock.calls[0]?.[0]).toMatchObject({
      activation: "edit",
      markdown: "Original chapter prose.",
      blockIds: [BLOCK],
      allowBlockNotes: false,
    });
  });

  it("offers no Edit affordance from role alone without revisions:write", async () => {
    stubFetch(["chapters:read", "submissions:write"]);
    mount();
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(document.querySelector(".ab-manuscript-edit")).toBeNull();
    expect(createSurface).not.toHaveBeenCalled();
  });

  it("submits only through the explicit revision callback and restores reading on Cancel", async () => {
    stubFetch(["chapters:read", "revisions:write"]);
    const host = mount();
    await expect.poll(() => document.querySelector(".ab-manuscript-edit")).toBeTruthy();
    (document.querySelector(".ab-manuscript-edit") as HTMLButtonElement).click();
    await expect.poll(() => createSurface.mock.calls.length).toBe(1);

    let received: ChapterRevisionSubmitEventDetail["draft"] | null = null;
    host.addEventListener(CHAPTER_REVISION_SUBMIT_EVENT, (event) => {
      const detail = (event as CustomEvent<ChapterRevisionSubmitEventDetail>).detail;
      detail.handle = async (draft) => {
        received = draft;
        return { ok: true, message: "Revision is waiting for review." };
      };
    });
    (document.querySelector(".ab-manuscript-editor-actions .ab-primary") as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-manuscript-status")?.textContent)
      .toBe("Revision is waiting for review.");
    expect(received).toMatchObject({
      chapterId: CHAPTER,
      title: "Loose Ends",
      markdown: "Edited chapter prose.",
      baseRevision: 12,
      baseContentHash: `sha256:${"a".repeat(64)}`,
    });
    expect(requests.some((url) => url.includes("chapter-submissions"))).toBe(false);

    (document.querySelector(".ab-manuscript-editor-actions .ab-btn") as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-manuscript-editor-shell")).toBeNull();
    expect(document.querySelector<HTMLElement>(".prose")?.hidden).toBe(false);
    expect(document.activeElement).toBe(document.querySelector(".ab-manuscript-edit"));
  });

  it("restores the untouched reading view when the lazy editor refuses source", async () => {
    stubFetch(["chapters:read", "revisions:write"]);
    createSurface.mockRejectedValueOnce(new Error("raw HTML is not allowed"));
    mount();
    await expect.poll(() => document.querySelector(".ab-manuscript-edit")).toBeTruthy();
    (document.querySelector(".ab-manuscript-edit") as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-manuscript-launcher-status")?.textContent)
      .toContain("raw HTML is not allowed");
    expect(document.querySelector<HTMLElement>(".prose")?.hidden).toBe(false);
    expect(document.querySelector(".ab-manuscript-editor-shell")).toBeNull();
  });
});
