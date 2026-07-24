// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterNotesTargetAdapter } from "../site/src/islands/chapter-notes-presentation.js";
import { saveChapterDraft } from "../site/src/islands/chapter-composer-state.js";
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
import {
  getProjectStore,
  resetProjectStoresForTests,
} from "../site/src/islands/project-store.js";

const API = "http://api.test";
const PROJECT = "hollow-creek-anomaly";
const CHAPTER = "019cadfd-8900-7140-98fb-ceff64cada33";
const BLOCK = "019cadfe-7360-7049-a30b-1f5898a5020a";
const HASH = `sha256:${"a".repeat(64)}`;

if (customElements.get("authorbot-manuscript-editor") === undefined) {
  customElements.define("authorbot-manuscript-editor", AuthorbotManuscriptEditor);
}

let surfaceMarkdown: string;
let lastSurfaceOptions: ManuscriptSurfaceOptions | null;

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
  get dirty() {
    return surfaceMarkdown !== options.markdown;
  },
  getMarkdown: () => surfaceMarkdown,
  focus: vi.fn(),
  submit: () => options.onSubmit?.({ markdown: surfaceMarkdown }) ??
    Promise.resolve({ ok: false, message: "not connected" }),
  destroy: vi.fn(async () => {}),
});

interface RequestCall {
  url: string;
  method: string;
  body: unknown;
  idempotencyKey: string | null;
  correlationId: string | null;
}

let requests: RequestCall[];
let createSurface: ReturnType<typeof vi.fn<(options: ManuscriptSurfaceOptions) => Promise<ManuscriptSurfaceSession>>>;

function me(role: string, capabilities: string[], canonical = true) {
  return {
    actor: { id: "actor-1", displayName: "Mara", externalIdentity: "github:mara" },
    memberships: [{ role }],
    scopes: capabilities,
    ...(canonical
      ? {
          capabilityMode: "human",
          grantedCapabilities: capabilities,
          roleCapabilityCeiling: capabilities,
          effectiveCapabilities: capabilities,
          legacyEffectiveActions: [],
        }
      : {}),
  };
}

function stubFetch(options: {
  role?: string;
  capabilities: string[];
  canonical?: boolean;
  sourceStatus?: number;
  sourceHash?: string | null;
  proposalStatus?: number;
  proposalNetworkFailures?: number;
}): void {
  let networkFailures = options.proposalNetworkFailures ?? 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined,
      idempotencyKey: headers.get("Idempotency-Key"),
      correlationId: headers.get("X-Correlation-Id"),
    });
    if (url === `${API}/v1/me`) {
      return new Response(JSON.stringify(me(
        options.role ?? "editor",
        options.capabilities,
        options.canonical ?? true,
      )), { status: 200 });
    }
    if (url.endsWith(`/chapters/${CHAPTER}/source`)) {
      return new Response(JSON.stringify({
        chapterId: CHAPTER,
        title: "Loose Ends",
        summary: null,
        revision: 12,
        ...(options.sourceHash === null ? {} : { contentHash: options.sourceHash ?? HASH }),
        status: "published",
        body: "Original chapter prose.",
      }), { status: options.sourceStatus ?? 200 });
    }
    if (url.endsWith("/revision-proposals") && method === "POST") {
      if (networkFailures > 0) {
        networkFailures -= 1;
        throw new Error("connection reset");
      }
      const status = options.proposalStatus ?? 201;
      return new Response(JSON.stringify(
        status === 201 || status === 202
          ? {
              proposalId: "proposal-1",
              operationId: status === 202 ? "operation-1" : null,
              correlationId: "correlation-1",
              status: status === 202 ? "applying" : "pending_review",
            }
          : { detail: status === 409 ? "base content changed" : "proposal rejected" },
      ), { status });
    }
    return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
  }));
}

function mount(): AuthorbotManuscriptEditor {
  const container = document.createElement("div");
  container.innerHTML = `<article class="chapter">
    <div class="chapter-author-actions">
      <button type="button">History</button>
      <authorbot-manuscript-editor
        data-api-base="${API}"
        data-project="${PROJECT}"
        data-chapter-id="${CHAPTER}"
        data-chapter-title="Loose Ends"></authorbot-manuscript-editor>
    </div>
    <div class="chapter-manuscript-surface" data-chapter-manuscript-surface>
      <div class="prose"><p id="b-${BLOCK}">Original chapter prose.</p></div>
    </div>
  </article>`;
  document.body.append(container.firstElementChild!);
  return document.querySelector("authorbot-manuscript-editor") as AuthorbotManuscriptEditor;
}

beforeEach(() => {
  requests = [];
  resetProjectStoresForTests();
  window.sessionStorage.clear();
  createSurface = vi.fn(async (options: ManuscriptSurfaceOptions) => {
    lastSurfaceOptions = options;
    surfaceMarkdown = options.markdown;
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
  it("announces chapter edit mode from handoff through WYSIWYG teardown", async () => {
    stubFetch({ capabilities: ["chapters:read", "revisions:write"] });
    mount();
    const collab = document.createElement("authorbot-collab") as HTMLElement & {
      setChapterEditMode: ReturnType<typeof vi.fn<(active: boolean) => void>>;
    };
    collab.dataset.chapterId = CHAPTER;
    collab.setChapterEditMode = vi.fn();
    document.body.append(collab);
    await expect.poll(() => document.querySelector(".ab-manuscript-edit")).toBeTruthy();

    (document.querySelector(".ab-manuscript-edit") as HTMLButtonElement).click();
    await expect.poll(() => createSurface.mock.calls.length).toBe(1);
    expect(collab.setChapterEditMode).toHaveBeenLastCalledWith(true);
    expect(document.querySelector<HTMLElement>("authorbot-manuscript-editor")?.dataset.chapterEditActive)
      .toBe("true");

    (document.querySelector(".ab-manuscript-editor-actions .ab-btn") as HTMLButtonElement)
      .click();
    await expect.poll(() => document.querySelector(".ab-manuscript-editor-shell")).toBeNull();
    expect(collab.setChapterEditMode.mock.calls).toEqual([[true], [false]]);
    expect(document.querySelector<HTMLElement>("authorbot-manuscript-editor")?.dataset.chapterEditActive)
      .toBeUndefined();
  });

  it("keeps edit suppression active through fail-safe surface teardown", async () => {
    stubFetch({ capabilities: ["chapters:read", "revisions:write"] });
    mount();
    const collab = document.createElement("authorbot-collab") as HTMLElement & {
      setChapterEditMode: ReturnType<typeof vi.fn<(active: boolean) => void>>;
    };
    collab.dataset.chapterId = CHAPTER;
    collab.setChapterEditMode = vi.fn();
    document.body.append(collab);

    let rejectDestroy!: (reason?: unknown) => void;
    const destroying = new Promise<void>((_resolve, reject) => {
      rejectDestroy = reject;
    });
    const destroy = vi.fn(() => destroying);
    createSurface.mockImplementationOnce(async (options: ManuscriptSurfaceOptions) => {
      lastSurfaceOptions = options;
      surfaceMarkdown = options.markdown;
      const editor = document.createElement("div");
      editor.setAttribute("role", "textbox");
      options.root.append(editor);
      return { ...session(options), destroy };
    });

    await expect.poll(() => document.querySelector(".ab-manuscript-edit")).toBeTruthy();
    (document.querySelector(".ab-manuscript-edit") as HTMLButtonElement).click();
    await expect.poll(() => createSurface.mock.calls.length).toBe(1);
    const prose = document.querySelector<HTMLElement>(".prose")!;
    expect(prose.hidden).toBe(true);
    expect(collab.setChapterEditMode.mock.calls).toEqual([[true]]);

    (document.querySelector(".ab-manuscript-editor-actions .ab-btn") as HTMLButtonElement)
      .click();
    await expect.poll(() => destroy).toHaveBeenCalledOnce();
    expect(document.querySelector(".ab-manuscript-editor-shell")).toBeTruthy();
    expect(prose.hidden).toBe(true);
    expect(collab.setChapterEditMode.mock.calls).toEqual([[true]]);

    rejectDestroy(new Error("surface teardown failed"));
    await expect.poll(() => document.querySelector(".ab-manuscript-editor-shell")).toBeNull();
    expect(prose.hidden).toBe(false);
    expect(collab.setChapterEditMode.mock.calls).toEqual([[true], [false]]);
  });

  it("releases the exact collaboration island after their shared subtree detaches", async () => {
    stubFetch({ capabilities: ["chapters:read", "revisions:write"] });
    const editor = mount();
    const collab = document.createElement("authorbot-collab") as HTMLElement & {
      setChapterEditMode: ReturnType<typeof vi.fn<(active: boolean) => void>>;
    };
    collab.dataset.chapterId = CHAPTER;
    collab.setChapterEditMode = vi.fn();
    document.querySelector("article")?.append(collab);
    await expect.poll(() => document.querySelector(".ab-manuscript-edit")).toBeTruthy();

    (document.querySelector(".ab-manuscript-edit") as HTMLButtonElement).click();
    await expect.poll(() => createSurface.mock.calls.length).toBe(1);
    expect(collab.setChapterEditMode.mock.calls).toEqual([[true]]);

    document.querySelector("article")?.remove();
    await expect.poll(() => collab.setChapterEditMode.mock.calls).toEqual([[true], [false]]);
    expect(editor.dataset.chapterEditActive).toBeUndefined();
  });

  it("keeps static reading intact and Milkdown unloaded until Edit is activated", async () => {
    stubFetch({ capabilities: ["chapters:read", "revisions:write"] });
    mount();
    await expect.poll(() => document.querySelector(".ab-manuscript-edit")).toBeTruthy();

    const prose = document.querySelector<HTMLElement>(".prose")!;
    expect(prose.hidden).toBe(false);
    expect(createSurface).not.toHaveBeenCalled();
    expect(requests.some(({ url }) => url.endsWith("/source"))).toBe(false);

    (document.querySelector(".ab-manuscript-edit") as HTMLButtonElement).click();
    await expect.poll(() => createSurface.mock.calls.length).toBe(1);
    expect(prose.hidden).toBe(true);
    const editButton = document.querySelector(".ab-manuscript-edit") as HTMLButtonElement;
    expect(editButton.textContent).toBe("Stop editing");
    expect(editButton.disabled).toBe(false);
    expect(editButton.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".ab-manuscript-launcher-status")).toBeNull();
    expect(document.querySelector('[role="textbox"]')?.getAttribute("aria-label"))
      .toBe("Chapter text for Loose Ends");
    expect(createSurface.mock.calls[0]?.[0]).toMatchObject({
      activation: "edit",
      markdown: "Original chapter prose.",
      blockIds: [BLOCK],
      allowBlockNotes: false,
    });

    (document.querySelector(".ab-manuscript-editor-actions .ab-btn") as HTMLButtonElement)
      .click();
    await expect.poll(() => document.querySelector(".ab-manuscript-editor-shell")).toBeNull();
    expect(editButton.textContent).toBe("Edit chapter");
    expect(editButton.disabled).toBe(false);
    expect(editButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("offers no Edit affordance from role alone without revisions:write", async () => {
    stubFetch({
      role: "maintainer",
      capabilities: ["chapters:read", "submissions:write"],
    });
    mount();
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(document.querySelector(".ab-manuscript-edit")).toBeNull();
    expect(createSurface).not.toHaveBeenCalled();
  });

  it("requires chapters:read as well as revisions:write", async () => {
    stubFetch({ capabilities: ["revisions:write"] });
    mount();
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(document.querySelector(".ab-manuscript-edit")).toBeNull();
  });

  it("submits a complete hash-bound proposal through the shared store and closes", async () => {
    stubFetch({ capabilities: ["chapters:read", "revisions:write"] });
    mount();
    await expect.poll(() => document.querySelector(".ab-manuscript-edit")).toBeTruthy();
    (document.querySelector(".ab-manuscript-edit") as HTMLButtonElement).click();
    await expect.poll(() => createSurface.mock.calls.length).toBe(1);
    expect(document.querySelector(".ab-manuscript-apply")).toBeNull();

    surfaceMarkdown = "Edited chapter prose.";
    lastSurfaceOptions?.onMarkdownChange?.(surfaceMarkdown);
    const summary = document.querySelector(".ab-manuscript-summary") as HTMLInputElement;
    summary.value = "Tighten the ending.";
    summary.dispatchEvent(new Event("input", { bubbles: true }));
    const notes = document.querySelector(".ab-manuscript-notes") as HTMLTextAreaElement;
    notes.value = "Keep the new reveal understated.";
    notes.dispatchEvent(new Event("input", { bubbles: true }));
    (document.querySelector('[data-manuscript-submit="review"]') as HTMLButtonElement).click();

    await expect.poll(() => document.querySelector(".ab-manuscript-launcher-status")?.textContent)
      .toContain("pending review");
    expect(document.querySelector(".ab-manuscript-editor-shell")).toBeNull();
    expect(document.querySelector<HTMLElement>(".prose")?.hidden).toBe(false);
    const proposal = requests.find(
      ({ url, method }) => url.endsWith("/revision-proposals") && method === "POST",
    );
    expect(proposal?.body).toEqual({
      proposalType: "chapter_replacement",
      chapterId: CHAPTER,
      baseRevision: 12,
      baseContentHash: HASH,
      proposedContent: "Edited chapter prose.",
      changeSummary: "Tighten the ending.",
      notes: "Keep the new reveal understated.",
    });
    expect(proposal?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);
    expect(requests.some(({ url }) => url.includes("chapter-submissions"))).toBe(false);
    expect(window.sessionStorage.length).toBe(1);
    expect(window.sessionStorage.getItem(
      `authorbot.chapter-draft.${PROJECT}.${CHAPTER}`,
    )).toContain("proposal-1");

    getProjectStore({ apiBase: API, project: PROJECT }).getState().reconcileEvent({
      id: 20,
      type: "revision_proposal_rejected",
      payload: { proposalId: "proposal-1" },
    });
    await expect.poll(() => document.querySelector(".ab-manuscript-launcher-status")?.textContent)
      .toContain("Revision rejected");
    expect((document.querySelector(".ab-manuscript-edit") as HTMLButtonElement).disabled)
      .toBe(false);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });

  it("offers one-click apply only to a reviewing maintainer", async () => {
    stubFetch({
      role: "maintainer",
      capabilities: ["chapters:read", "revisions:write", "revisions:review"],
      proposalStatus: 202,
    });
    mount();
    await expect.poll(() => document.querySelector(".ab-manuscript-edit")).toBeTruthy();
    (document.querySelector(".ab-manuscript-edit") as HTMLButtonElement).click();
    await expect.poll(() => createSurface.mock.calls.length).toBe(1);
    surfaceMarkdown = "Maintainer revision.";
    lastSurfaceOptions?.onMarkdownChange?.(surfaceMarkdown);
    (document.querySelector(".ab-manuscript-apply") as HTMLButtonElement).click();

    await expect.poll(() => document.querySelector(".ab-manuscript-launcher-status")?.textContent)
      .toContain("approved and applying");
    expect(requests.find(({ url, method }) =>
      url.endsWith("/revision-proposals") && method === "POST")?.body).toMatchObject({
        proposalType: "chapter_replacement",
        applyImmediately: true,
      });
    const store = getProjectStore({ apiBase: API, project: PROJECT });
    store.getState().reconcileEvent({
      id: 21,
      type: "revision_proposal_applied",
      payload: { revisionProposalId: "proposal-1", commitSha: "c".repeat(40) },
    });
    await expect.poll(() => document.querySelector(".ab-manuscript-launcher-status")?.textContent)
      .toContain("waiting for publication");
    expect(document.querySelector(".prose")?.textContent).toContain("Original chapter prose");
    store.getState().reconcileEvent({
      id: 22,
      type: "publication_updated",
      payload: {
        integratedCommit: "c".repeat(40),
        buildStatus: "building",
        deployedCommit: null,
      },
    });
    await expect.poll(() => document.querySelector(".ab-manuscript-launcher-status")?.textContent)
      .toContain("Publishing chapter changes");
    expect(document.querySelector(".prose")?.textContent).toContain("Original chapter prose");
    store.getState().reconcileEvent({
      id: 23,
      type: "publication_updated",
      payload: {
        integratedCommit: "c".repeat(40),
        buildStatus: "succeeded",
        deployedCommit: "c".repeat(40),
      },
    });
    await expect.poll(() => document.querySelector(".ab-manuscript-launcher-status")?.textContent)
      .toContain("changes are deployed");
    expect(window.sessionStorage.length).toBe(0);
  });

  it("retains an ambiguous draft and reuses its idempotency key on retry", async () => {
    stubFetch({
      capabilities: ["chapters:read", "revisions:write"],
      proposalNetworkFailures: 2,
    });
    mount();
    await expect.poll(() => document.querySelector(".ab-manuscript-edit")).toBeTruthy();
    (document.querySelector(".ab-manuscript-edit") as HTMLButtonElement).click();
    await expect.poll(() => createSurface.mock.calls.length).toBe(1);
    surfaceMarkdown = "Draft that survived transport failure.";
    lastSurfaceOptions?.onMarkdownChange?.(surfaceMarkdown);

    const submit = document.querySelector(
      '[data-manuscript-submit="review"]',
    ) as HTMLButtonElement;
    submit.click();
    await expect.poll(() => document.querySelector(".ab-manuscript-error")?.textContent)
      .toContain("network error");
    expect(document.querySelector(".ab-manuscript-editor-shell")).toBeTruthy();
    expect(window.sessionStorage.length).toBe(1);
    submit.click();
    await expect.poll(() => document.querySelector(".ab-manuscript-editor-shell")).toBeNull();
    const keys = requests
      .filter(({ url }) => url.endsWith("/revision-proposals"))
      .map(({ idempotencyKey }) => idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it("closes a failed editor when a late correlated feed event proves it landed", async () => {
    stubFetch({
      capabilities: ["chapters:read", "revisions:write"],
      proposalNetworkFailures: 2,
    });
    mount();
    await expect.poll(() => document.querySelector(".ab-manuscript-edit")).toBeTruthy();
    (document.querySelector(".ab-manuscript-edit") as HTMLButtonElement).click();
    await expect.poll(() => createSurface.mock.calls.length).toBe(1);
    surfaceMarkdown = "The server accepted this draft after the response was lost.";
    lastSurfaceOptions?.onMarkdownChange?.(surfaceMarkdown);
    (document.querySelector('[data-manuscript-submit="review"]') as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-manuscript-error")?.textContent)
      .toContain("network error");

    const correlationId = requests.find(({ url }) =>
      url.endsWith("/revision-proposals"))?.correlationId;
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/u);
    getProjectStore({ apiBase: API, project: PROJECT }).getState().reconcileEvent({
      id: 24,
      type: "revision_proposal_created",
      payload: { proposalId: "proposal-late", correlationId },
    });

    await expect.poll(() => document.querySelector(".ab-manuscript-editor-shell")).toBeNull();
    expect(document.querySelector<HTMLElement>(".prose")?.hidden).toBe(false);
    expect(document.querySelector(".ab-manuscript-launcher-status")?.textContent)
      .toContain("pending review");
    expect(window.sessionStorage.getItem(
      `authorbot.chapter-draft.${PROJECT}.${CHAPTER}`,
    )).toContain("proposal-late");
  });

  it("restores only an exact-base draft and keeps its loss warning active", async () => {
    saveChapterDraft(window.sessionStorage, PROJECT, {
      chapterId: CHAPTER,
      title: "Loose Ends",
      body: "Saved in-progress prose.",
      baseRevision: 12,
      baseContentHash: HASH,
      changeSummary: "Finish the saved pass.",
      notes: "",
      caret: null,
      focus: "body",
    });
    stubFetch({ capabilities: ["chapters:read", "revisions:write"] });
    mount();
    await expect.poll(() => document.querySelector(".ab-manuscript-edit")).toBeTruthy();
    (document.querySelector(".ab-manuscript-edit") as HTMLButtonElement).click();
    await expect.poll(() => createSurface.mock.calls.length).toBe(1);

    expect(createSurface.mock.calls[0]?.[0].markdown).toBe("Saved in-progress prose.");
    expect((document.querySelector(".ab-manuscript-summary") as HTMLInputElement).value)
      .toBe("Finish the saved pass.");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  });

  it("never hides or overwrites a stale-base saved draft", async () => {
    const staleHash = `sha256:${"b".repeat(64)}`;
    saveChapterDraft(window.sessionStorage, PROJECT, {
      chapterId: CHAPTER,
      title: "Loose Ends",
      body: "Saved prose from the older revision.",
      baseRevision: 11,
      baseContentHash: staleHash,
      changeSummary: "Older local pass.",
      notes: "Do not lose this.",
      caret: null,
      focus: "body",
    });
    stubFetch({
      capabilities: ["chapters:read", "revisions:write"],
      proposalStatus: 409,
    });
    mount();
    await expect.poll(() => document.querySelector(".ab-manuscript-edit")).toBeTruthy();
    (document.querySelector(".ab-manuscript-edit") as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-manuscript-recovery")).toBeTruthy();

    expect(createSurface).not.toHaveBeenCalled();
    expect(document.querySelector(".ab-manuscript-recovery-prose")?.textContent)
      .toBe("Saved prose from the older revision.");
    expect(window.sessionStorage.getItem(
      `authorbot.chapter-draft.${PROJECT}.${CHAPTER}`,
    )).toContain(staleHash);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    (document.querySelector(".ab-manuscript-recovery .ab-primary") as HTMLButtonElement).click();
    await expect.poll(() => createSurface.mock.calls.length).toBe(1);
    expect(createSurface.mock.calls[0]?.[0].markdown)
      .toBe("Saved prose from the older revision.");
    expect(document.querySelector(".ab-manuscript-stale-warning")?.textContent)
      .toContain("revision 11");
    // Even identical visible prose stays a stale-base draft when repository
    // metadata changed; the base hash is part of the loss-protection identity.
    surfaceMarkdown = "Original chapter prose.";
    lastSurfaceOptions?.onMarkdownChange?.(surfaceMarkdown);
    expect(window.sessionStorage.getItem(
      `authorbot.chapter-draft.${PROJECT}.${CHAPTER}`,
    )).toContain(staleHash);
    surfaceMarkdown = "Continued work on the older revision.";
    lastSurfaceOptions?.onMarkdownChange?.(surfaceMarkdown);
    (document.querySelector('[data-manuscript-submit="review"]') as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-manuscript-error")?.textContent)
      .toContain("Your draft is still here");
    expect(requests.find(({ url, method }) =>
      url.endsWith("/revision-proposals") && method === "POST")?.body).toMatchObject({
        baseRevision: 11,
        baseContentHash: staleHash,
        proposedContent: "Continued work on the older revision.",
      });
    expect(window.sessionStorage.getItem(
      `authorbot.chapter-draft.${PROJECT}.${CHAPTER}`,
    )).toContain("Continued work on the older revision.");
  });

  it("keeps a conflict open with its draft and review context", async () => {
    stubFetch({
      capabilities: ["chapters:read", "revisions:write"],
      proposalStatus: 409,
    });
    mount();
    await expect.poll(() => document.querySelector(".ab-manuscript-edit")).toBeTruthy();
    (document.querySelector(".ab-manuscript-edit") as HTMLButtonElement).click();
    await expect.poll(() => createSurface.mock.calls.length).toBe(1);
    surfaceMarkdown = "Locally edited prose.";
    lastSurfaceOptions?.onMarkdownChange?.(surfaceMarkdown);
    const summary = document.querySelector(".ab-manuscript-summary") as HTMLInputElement;
    summary.value = "Local ending edit.";
    summary.dispatchEvent(new Event("input", { bubbles: true }));
    (document.querySelector('[data-manuscript-submit="review"]') as HTMLButtonElement).click();

    await expect.poll(() => document.querySelector(".ab-manuscript-error")?.textContent)
      .toContain("Your draft is still here");
    expect(document.querySelector(".ab-manuscript-editor-shell")).toBeTruthy();
    expect(window.sessionStorage.getItem(
      `authorbot.chapter-draft.${PROJECT}.${CHAPTER}`,
    )).toContain("Local ending edit.");
  });

  it("preserves the extension callback without requiring it for normal submissions", async () => {
    stubFetch({ capabilities: ["chapters:read", "revisions:write"] });
    const host = mount();
    await expect.poll(() => document.querySelector(".ab-manuscript-edit")).toBeTruthy();
    (document.querySelector(".ab-manuscript-edit") as HTMLButtonElement).click();
    await expect.poll(() => createSurface.mock.calls.length).toBe(1);
    surfaceMarkdown = "Extension-handled prose.";
    let received: ChapterRevisionSubmitEventDetail["draft"] | null = null;
    host.addEventListener(CHAPTER_REVISION_SUBMIT_EVENT, (event) => {
      const detail = (event as CustomEvent<ChapterRevisionSubmitEventDetail>).detail;
      detail.handle = async (draft) => {
        received = draft;
        return { ok: true, message: "Extension accepted revision." };
      };
    });
    (document.querySelector('[data-manuscript-submit="review"]') as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-manuscript-launcher-status")?.textContent)
      .toBe("Extension accepted revision.");
    expect(received).toMatchObject({
      chapterId: CHAPTER,
      markdown: "Extension-handled prose.",
      baseContentHash: HASH,
    });
    expect(requests.some(({ url }) => url.endsWith("/revision-proposals"))).toBe(false);
  });

  it("restores reading on Cancel", async () => {
    stubFetch({ capabilities: ["chapters:read", "revisions:write"] });
    mount();
    await expect.poll(() => document.querySelector(".ab-manuscript-edit")).toBeTruthy();
    (document.querySelector(".ab-manuscript-edit") as HTMLButtonElement).click();
    await expect.poll(() => createSurface.mock.calls.length).toBe(1);

    (document.querySelector(".ab-manuscript-editor-actions .ab-btn") as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-manuscript-editor-shell")).toBeNull();
    expect(document.querySelector<HTMLElement>(".prose")?.hidden).toBe(false);
    expect(document.activeElement).toBe(document.querySelector(".ab-manuscript-edit"));
  });

  it("restores the untouched reading view when the lazy editor refuses source", async () => {
    stubFetch({ capabilities: ["chapters:read", "revisions:write"] });
    createSurface.mockRejectedValueOnce(new Error("raw HTML is not allowed"));
    mount();
    await expect.poll(() => document.querySelector(".ab-manuscript-edit")).toBeTruthy();
    (document.querySelector(".ab-manuscript-edit") as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-manuscript-launcher-status")?.textContent)
      .toContain("raw HTML is not allowed");
    expect(document.querySelector<HTMLElement>(".prose")?.hidden).toBe(false);
    expect(document.querySelector(".ab-manuscript-editor-shell")).toBeNull();
  });

  it("refuses to edit when an older source response has no content hash", async () => {
    stubFetch({
      capabilities: ["chapters:read", "revisions:write"],
      sourceHash: null,
    });
    mount();
    await expect.poll(() => document.querySelector(".ab-manuscript-edit")).toBeTruthy();
    (document.querySelector(".ab-manuscript-edit") as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-manuscript-launcher-status")?.textContent)
      .toContain("content hash");
    expect(createSurface).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>(".prose")?.hidden).toBe(false);
  });
});
