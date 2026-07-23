// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorbotChapterSummaryEditor } from "../site/src/islands/chapter-summary-editor.js";
import { resetProjectStoresForTests } from "../site/src/islands/project-store.js";

const API = "http://api.test";
const PROJECT = "hollow-creek-anomaly";
const CHAPTER = "019cadfd-8900-7140-98fb-ceff64cada33";
const HASH = `sha256:${"a".repeat(64)}`;

if (customElements.get("authorbot-chapter-summary-editor") === undefined) {
  customElements.define(
    "authorbot-chapter-summary-editor",
    AuthorbotChapterSummaryEditor,
  );
}

interface RequestCall {
  url: string;
  method: string;
  body: unknown;
  idempotencyKey: string | null;
}

let requests: RequestCall[];

function me(role: string, capabilities: string[]) {
  return {
    actor: { id: "actor-1", displayName: "Mara", externalIdentity: "github:mara" },
    memberships: [{ role }],
    scopes: capabilities,
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
  currentSummary?: string | null;
  sourceHash?: string | null;
  proposalStatus?: number;
  proposalNetworkFailures?: number;
}): void {
  let failures = options.proposalNetworkFailures ?? 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined,
      idempotencyKey: headers.get("Idempotency-Key"),
    });
    if (url === `${API}/v1/me`) {
      return new Response(JSON.stringify(me(
        options.role ?? "contributor",
        options.capabilities,
      )), { status: 200 });
    }
    if (url.endsWith(`/chapters/${CHAPTER}/source`)) {
      return new Response(JSON.stringify({
        chapterId: CHAPTER,
        title: "Loose Ends",
        summary: options.currentSummary === undefined
          ? "The anomaly leaves one final choice."
          : options.currentSummary,
        revision: 12,
        ...(options.sourceHash === null ? {} : { contentHash: options.sourceHash ?? HASH }),
        status: "published",
        body: "Original chapter prose.",
      }), { status: 200 });
    }
    if (url.endsWith("/revision-proposals") && method === "POST") {
      if (failures > 0) {
        failures -= 1;
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

function mount(): AuthorbotChapterSummaryEditor {
  document.body.innerHTML = `<header class="chapter-header">
    <h1>Loose Ends</h1>
    <p class="chapter-deck">The published deck remains authoritative.</p>
    <authorbot-chapter-summary-editor
      data-api-base="${API}"
      data-project="${PROJECT}"
      data-chapter-id="${CHAPTER}"
      data-chapter-title="Loose Ends"></authorbot-chapter-summary-editor>
  </header>`;
  return document.querySelector(
    "authorbot-chapter-summary-editor",
  ) as AuthorbotChapterSummaryEditor;
}

beforeEach(() => {
  requests = [];
  resetProjectStoresForTests();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  resetProjectStoresForTests();
});

describe("chapter summary editor", () => {
  it("offers nothing to unauthorized readers and does not infer access from role", async () => {
    stubFetch({ role: "maintainer", capabilities: ["chapters:read"] });
    mount();
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(document.querySelector(".ab-summary-edit")).toBeNull();
    expect(requests.some(({ url }) => url.endsWith("/source"))).toBe(false);
  });

  it("loads the exact source only after activation and exposes an accessible contributor form", async () => {
    stubFetch({ capabilities: ["chapters:read", "summaries:write"] });
    mount();
    await expect.poll(() => document.querySelector(".ab-summary-edit")).toBeTruthy();
    expect(requests.some(({ url }) => url.endsWith("/source"))).toBe(false);

    (document.querySelector(".ab-summary-edit") as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-summary-editor-shell")).toBeTruthy();
    const shell = document.querySelector(".ab-summary-editor-shell") as HTMLElement;
    const headingId = shell.getAttribute("aria-labelledby");
    expect(headingId).toBeTruthy();
    expect(document.getElementById(headingId ?? "")?.textContent).toBe("Edit chapter summary");
    expect((document.querySelector(".ab-summary-editor-input") as HTMLTextAreaElement).value)
      .toBe("The anomaly leaves one final choice.");
    expect(document.querySelector(".ab-summary-apply")).toBeNull();
    expect(requests.filter(({ url }) => url.endsWith("/source"))).toHaveLength(1);
  });

  it("submits a contributor proposal, clears the form, and leaves the published deck unchanged", async () => {
    stubFetch({ capabilities: ["chapters:read", "summaries:write"] });
    mount();
    await expect.poll(() => document.querySelector(".ab-summary-edit")).toBeTruthy();
    (document.querySelector(".ab-summary-edit") as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-summary-editor-input")).toBeTruthy();

    const input = document.querySelector(".ab-summary-editor-input") as HTMLTextAreaElement;
    input.value = "A sharper account of the final choice.";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const notes = document.querySelector(".ab-summary-editor-notes") as HTMLTextAreaElement;
    notes.value = "Keeps the public outline concise.";
    notes.dispatchEvent(new Event("input", { bubbles: true }));
    (document.querySelector('[data-summary-submit="review"]') as HTMLButtonElement).click();

    await expect.poll(() => document.querySelector(".ab-summary-editor-shell")).toBeNull();
    expect(document.querySelector(".ab-summary-launcher-status")?.textContent)
      .toContain("submitted for review");
    expect(document.querySelector(".chapter-deck")?.textContent)
      .toBe("The published deck remains authoritative.");
    const proposal = requests.find(
      ({ url, method }) => url.endsWith("/revision-proposals") && method === "POST",
    );
    expect(proposal?.body).toEqual({
      proposalType: "chapter_summary",
      chapterId: CHAPTER,
      baseRevision: 12,
      baseContentHash: HASH,
      proposedContent: "A sharper account of the final choice.",
      changeSummary: "Update the chapter summary.",
      notes: "Keeps the public outline concise.",
    });
    expect(proposal?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("lets an exact reviewing maintainer clear and atomically apply the summary", async () => {
    stubFetch({
      role: "maintainer",
      capabilities: ["chapters:read", "summaries:write", "revisions:review"],
      proposalStatus: 202,
    });
    mount();
    await expect.poll(() => document.querySelector(".ab-summary-edit")).toBeTruthy();
    (document.querySelector(".ab-summary-edit") as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-summary-apply")).toBeTruthy();
    const input = document.querySelector(".ab-summary-editor-input") as HTMLTextAreaElement;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    (document.querySelector(".ab-summary-apply") as HTMLButtonElement).click();

    await expect.poll(() => document.querySelector(".ab-summary-editor-shell")).toBeNull();
    expect(document.querySelector(".ab-summary-launcher-status")?.textContent)
      .toContain("after deployment");
    expect(requests.find(({ url, method }) =>
      url.endsWith("/revision-proposals") && method === "POST")?.body).toEqual({
      proposalType: "chapter_summary",
      chapterId: CHAPTER,
      baseRevision: 12,
      baseContentHash: HASH,
      proposedContent: "",
      changeSummary: "Remove the chapter summary.",
      applyImmediately: true,
    });
  });

  it("keeps a transport-failed edit open, protects dirty navigation, and reuses its retry key", async () => {
    stubFetch({
      capabilities: ["chapters:read", "summaries:write"],
      proposalNetworkFailures: 2,
    });
    mount();
    await expect.poll(() => document.querySelector(".ab-summary-edit")).toBeTruthy();
    (document.querySelector(".ab-summary-edit") as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-summary-editor-input")).toBeTruthy();
    const input = document.querySelector(".ab-summary-editor-input") as HTMLTextAreaElement;
    input.value = "A local summary that must survive transport failure.";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    const submit = document.querySelector(
      '[data-summary-submit="review"]',
    ) as HTMLButtonElement;
    submit.click();
    await expect.poll(() => document.querySelector(".ab-summary-editor-error")?.textContent)
      .toContain("network error");
    expect(input.value).toContain("must survive");
    expect(document.querySelector(".ab-summary-editor-shell")).toBeTruthy();

    submit.click();
    await expect.poll(() => document.querySelector(".ab-summary-editor-shell")).toBeNull();
    const keys = requests
      .filter(({ url }) => url.endsWith("/revision-proposals"))
      .map(({ idempotencyKey }) => idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it("keeps a revision conflict open with the proposed summary and reviewer notes", async () => {
    stubFetch({
      capabilities: ["chapters:read", "summaries:write"],
      proposalStatus: 409,
    });
    mount();
    await expect.poll(() => document.querySelector(".ab-summary-edit")).toBeTruthy();
    (document.querySelector(".ab-summary-edit") as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-summary-editor-input")).toBeTruthy();
    const input = document.querySelector(".ab-summary-editor-input") as HTMLTextAreaElement;
    const notes = document.querySelector(".ab-summary-editor-notes") as HTMLTextAreaElement;
    input.value = "A summary based on the source that just moved.";
    notes.value = "Preserve this reviewer context.";
    (document.querySelector('[data-summary-submit="review"]') as HTMLButtonElement).click();

    await expect.poll(() => document.querySelector(".ab-summary-editor-error")?.textContent)
      .toContain("Your summary is still here");
    expect(document.querySelector(".ab-summary-editor-shell")).toBeTruthy();
    expect(input.value).toBe("A summary based on the source that just moved.");
    expect(notes.value).toBe("Preserve this reviewer context.");
  });

  it("refuses a source response without its hash before exposing editable metadata", async () => {
    stubFetch({
      capabilities: ["chapters:read", "summaries:write"],
      sourceHash: null,
    });
    mount();
    await expect.poll(() => document.querySelector(".ab-summary-edit")).toBeTruthy();
    (document.querySelector(".ab-summary-edit") as HTMLButtonElement).click();
    await expect.poll(() => document.querySelector(".ab-summary-launcher-status")?.textContent)
      .toContain("exact chapter identity and content hash");
    expect(document.querySelector(".ab-summary-editor-shell")).toBeNull();
  });
});
