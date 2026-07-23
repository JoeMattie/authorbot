// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterNotesTargetAdapter } from "../site/src/islands/chapter-notes-presentation.js";
import {
  AuthorbotPlanningDocumentEditor,
  joinCharacterDocument,
  splitCharacterDocument,
} from "../site/src/islands/planning-document-editor.js";
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
const OUTLINE_PATH = "story/outline.yml";
const OUTLINE = "schema: authorbot.story-graph/v1\nnodes: []\n";
const HASH = `sha256:${"a".repeat(64)}`;
const CHARACTER_PATH = "story/characters/mara.md";
const CHARACTER = [
  "---",
  "schema: authorbot.character/v1",
  "id: character:mara",
  "name: Mara Voss",
  "---",
  "",
  "Original character notes.",
  "",
].join("\n");

if (customElements.get("authorbot-planning-document-editor") === undefined) {
  customElements.define(
    "authorbot-planning-document-editor",
    AuthorbotPlanningDocumentEditor,
  );
}

interface RequestCall {
  url: string;
  method: string;
  body: unknown;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function me(role: string, capabilities: string[]) {
  return {
    actor: { id: "actor-1", displayName: "Mara", externalIdentity: "github:mara" },
    memberships: [{ role }],
    // Deliberately broad old scopes prove the canonical projection wins.
    scopes: ["revisions:write", "revisions:review"],
    capabilityMode: "human",
    grantedCapabilities: capabilities,
    roleCapabilityCeiling: capabilities,
    effectiveCapabilities: capabilities,
    legacyEffectiveActions: [],
  };
}

function stubFetch(options: {
  role?: string;
  capabilities: string[];
  kind?: "outline" | "character";
  source?: string;
  targetId?: string;
  proposalStatus?: number;
  calls?: RequestCall[];
}): void {
  const kind = options.kind ?? "outline";
  const path = kind === "character" ? CHARACTER_PATH : OUTLINE_PATH;
  const targetId = options.targetId ?? (kind === "character" ? "character:mara" : "outline");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    options.calls?.push({ url, method, body });
    if (url === `${API}/v1/me`) {
      return json(200, me(options.role ?? "editor", options.capabilities));
    }
    if (url.includes("/repository-documents/source?")) {
      return json(200, {
        target: {
          kind,
          id: targetId,
          path,
          label: kind === "character" ? "Mara Voss" : "Outline",
        },
        content: options.source ?? (kind === "character" ? CHARACTER : OUTLINE),
        contentHash: HASH,
      });
    }
    if (url.endsWith("/revision-proposals") && method === "POST") {
      const status = options.proposalStatus ?? 201;
      return status === 201 || status === 202
        ? json(status, {
            proposalId: "proposal-1",
            operationId: status === 202 ? "operation-1" : null,
            correlationId: "correlation-1",
            status: status === 202 ? "applying" : "pending_review",
          })
        : json(status, { detail: status === 409 ? "base content changed" : "invalid document" });
    }
    return json(404, { detail: "not found" });
  }));
}

function mountOutline(): AuthorbotPlanningDocumentEditor {
  document.body.innerHTML = `<main>
    <authorbot-planning-document-editor
      data-api-base="${API}"
      data-project="${PROJECT}"
      data-kind="outline"
      data-target-id="outline"
      data-path="${OUTLINE_PATH}"
      data-label="Outline"
      data-reading-id="outline-reading"></authorbot-planning-document-editor>
    <div id="outline-reading"><p>Rendered outline</p></div>
  </main>`;
  return document.querySelector("authorbot-planning-document-editor") as AuthorbotPlanningDocumentEditor;
}

function mountCharacter(): AuthorbotPlanningDocumentEditor {
  document.body.innerHTML = `<main>
    <authorbot-planning-document-editor
      data-api-base="${API}"
      data-project="${PROJECT}"
      data-kind="character"
      data-target-id="character:mara"
      data-path="${CHARACTER_PATH}"
      data-label="Mara Voss"
      data-reading-id="character-reading"></authorbot-planning-document-editor>
    <div id="character-reading"><p>Rendered character</p></div>
  </main>`;
  return document.querySelector("authorbot-planning-document-editor") as AuthorbotPlanningDocumentEditor;
}

let createSurface: ReturnType<
  typeof vi.fn<(options: ManuscriptSurfaceOptions) => Promise<ManuscriptSurfaceSession>>
>;
let surfaceMarkdown: string;
let lastSurfaceOptions: ManuscriptSurfaceOptions | null;

beforeEach(() => {
  resetProjectStoresForTests();
  window.sessionStorage.clear();
  surfaceMarkdown = "";
  lastSurfaceOptions = null;
  createSurface = vi.fn(async (options: ManuscriptSurfaceOptions) => {
    lastSurfaceOptions = options;
    surfaceMarkdown = options.markdown;
    const editor = document.createElement("div");
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-label", options.accessibleName);
    options.root.append(editor);
    return {
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
      submit: vi.fn(async () => ({ ok: false, message: "not used" })),
      destroy: vi.fn(async () => {}),
    };
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

describe("repository planning document editor", () => {
  it("splits and reassembles a complete character artifact", () => {
    expect(splitCharacterDocument(CHARACTER)).toEqual({
      metadata: [
        "schema: authorbot.character/v1",
        "id: character:mara",
        "name: Mara Voss",
      ].join("\n"),
      body: "Original character notes.",
    });
    expect(joinCharacterDocument("id: character:mara", "Notes.")).toBe(
      "---\nid: character:mara\n---\n\nNotes.\n",
    );
  });

  it("keeps reading static and source unloaded until an exact write capability activates Edit", async () => {
    const calls: RequestCall[] = [];
    stubFetch({ capabilities: ["revisions:write"], calls });
    mountOutline();
    await expect.poll(() => document.querySelector(".ab-planning-edit")).toBeTruthy();

    expect(document.querySelector<HTMLElement>("#outline-reading")?.hidden).toBe(false);
    expect(calls.some(({ url }) => url.includes("repository-documents"))).toBe(false);
    expect(createSurface).not.toHaveBeenCalled();

    (document.querySelector(".ab-planning-edit") as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-planning-source")).toBeTruthy();
    expect(document.querySelector<HTMLElement>("#outline-reading")?.hidden).toBe(true);
    expect((document.querySelector(".ab-planning-source") as HTMLTextAreaElement).value)
      .toBe(OUTLINE);
    expect(createSurface).not.toHaveBeenCalled();
    expect(calls.find(({ url }) => url.includes("repository-documents"))?.url).toContain(
      "kind=outline&path=story%2Foutline.yml",
    );
  });

  it("does not infer Edit or Apply from a maintainer role and broad old scopes", async () => {
    stubFetch({ role: "maintainer", capabilities: [] });
    mountOutline();
    await expect.poll(() => (fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    expect(document.querySelector(".ab-planning-edit")).toBeNull();
  });

  it("offers atomic Apply only to a reviewing maintainer and sends the complete command", async () => {
    const calls: RequestCall[] = [];
    stubFetch({
      role: "maintainer",
      capabilities: ["revisions:write", "revisions:review"],
      proposalStatus: 202,
      calls,
    });
    mountOutline();
    await expect.poll(() => document.querySelector(".ab-planning-edit")).toBeTruthy();
    (document.querySelector(".ab-planning-edit") as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-planning-source")).toBeTruthy();

    const source = document.querySelector(".ab-planning-source") as HTMLTextAreaElement;
    source.value = "schema: authorbot.story-graph/v1\nnodes:\n  - id: premise:main\n";
    source.dispatchEvent(new Event("input", { bubbles: true }));
    const summary = document.querySelector(".ab-planning-summary") as HTMLInputElement;
    summary.value = "Add the premise.";
    summary.dispatchEvent(new Event("input", { bubbles: true }));
    (document.querySelector(".ab-planning-apply") as HTMLButtonElement).click();

    await expect.poll(() => document.querySelector(".ab-planning-launcher-status")?.textContent)
      .toContain("update after deployment");
    expect(document.querySelector<HTMLElement>("#outline-reading")?.hidden).toBe(false);
    expect(calls.find(({ url, method }) => url.endsWith("/revision-proposals") && method === "POST")?.body)
      .toEqual({
        proposalType: "repository_document",
        targetKind: "outline",
        targetPath: OUTLINE_PATH,
        baseContentHash: HASH,
        proposedContent: source.value,
        changeSummary: "Add the premise.",
        applyImmediately: true,
      });
  });

  it("keeps a failed stale draft open, saved, and protected from accidental loss", async () => {
    stubFetch({ capabilities: ["revisions:write"], proposalStatus: 409 });
    mountOutline();
    await expect.poll(() => document.querySelector(".ab-planning-edit")).toBeTruthy();
    (document.querySelector(".ab-planning-edit") as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-planning-source")).toBeTruthy();
    const source = document.querySelector(".ab-planning-source") as HTMLTextAreaElement;
    source.value = `${OUTLINE}# local edit\n`;
    source.dispatchEvent(new Event("input", { bubbles: true }));

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    (document.querySelector('[data-planning-submit="review"]') as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-planning-error")?.textContent)
      .toContain("Your draft is still here");
    expect((document.querySelector(".ab-planning-source") as HTMLTextAreaElement).value)
      .toContain("# local edit");
    expect(window.sessionStorage.length).toBe(1);

    vi.stubGlobal("confirm", vi.fn(() => false));
    (document.querySelector(".ab-planning-actions .ab-btn") as HTMLButtonElement).click();
    await Promise.resolve();
    expect(document.querySelector(".ab-planning-editor-shell")).toBeTruthy();
  });

  it("edits character frontmatter plus a lazy Milkdown body as one proposal", async () => {
    const calls: RequestCall[] = [];
    stubFetch({
      capabilities: ["revisions:write"],
      kind: "character",
      source: CHARACTER,
      calls,
    });
    mountCharacter();
    await expect.poll(() => document.querySelector(".ab-planning-edit")).toBeTruthy();
    expect(createSurface).not.toHaveBeenCalled();
    (document.querySelector(".ab-planning-edit") as HTMLButtonElement).click();
    await expect.poll(() => createSurface.mock.calls.length).toBe(1);
    expect(lastSurfaceOptions).toMatchObject({
      activation: "edit",
      markdown: "Original character notes.",
      blockIds: [],
      allowBlockNotes: false,
      accessibleName: "Character notes for Mara Voss",
    });
    expect(document.querySelector(".ab-planning-apply")).toBeNull();

    const metadata = document.querySelector(".ab-planning-metadata") as HTMLTextAreaElement;
    metadata.value = metadata.value.replace("name: Mara Voss", "name: Mara Voss Prime");
    metadata.dispatchEvent(new Event("input", { bubbles: true }));
    surfaceMarkdown = "Revised **character** notes.";
    lastSurfaceOptions?.onMarkdownChange?.(surfaceMarkdown);
    (document.querySelector('[data-planning-submit="review"]') as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-planning-launcher-status")?.textContent)
      .toBe("Revision submitted for review.");

    const command = calls.find(
      ({ url, method }) => url.endsWith("/revision-proposals") && method === "POST",
    )?.body as Record<string, unknown>;
    expect(command).toMatchObject({
      proposalType: "repository_document",
      targetKind: "character",
      targetPath: CHARACTER_PATH,
      baseContentHash: HASH,
    });
    expect(command["applyImmediately"]).toBeUndefined();
    expect(command["proposedContent"]).toContain("name: Mara Voss Prime");
    expect(command["proposedContent"]).toContain("Revised **character** notes.");
  });
});
