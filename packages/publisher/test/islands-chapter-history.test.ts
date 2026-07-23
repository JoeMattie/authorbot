// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthorbotChapterHistory,
  resetChapterHistoryPanelLoaderForTests,
  setChapterHistoryPanelLoaderForTests,
} from "../site/src/islands/chapter-history-entry.js";
import { AuthorbotChapterHistoryPanel } from "../site/src/islands/chapter-history-panel.js";
import {
  getProjectStore,
  resetProjectStoresForTests,
} from "../site/src/islands/project-store.js";

const API = "http://api.test";
const PROJECT = "hollow-creek-anomaly";
const CHAPTER = "chapter-1";

if (customElements.get("authorbot-chapter-history") === undefined) {
  customElements.define("authorbot-chapter-history", AuthorbotChapterHistory);
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const revision = (value: number, current = false) => ({
  revision: value,
  contentHash: `sha256:${value}`,
  commitSha: `commit-${value}`,
  createdAt: `2026-07-2${value}T12:00:00Z`,
  author: { id: "writer-1", displayName: "Writer <script>", type: "human" },
  changeSummary: value === 1 ? "Original chapter" : `Revision ${value}`,
  origin: "chapter_edit",
  status: "published",
  isCurrent: current,
});

function content(value: number): string {
  return value === 3 ? "Current <img src=x onerror=alert(1)>\n" : `Revision ${value}\n`;
}

function stubApi(
  effectiveCapabilities = ["history:read", "revisions:write", "revisions:read"],
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${API}/v1/me`) {
        return json({
          actor: { id: "editor-1", displayName: "Editor", externalIdentity: "github:editor" },
          memberships: [{ role: "editor" }],
          // Deliberately broad legacy shadows prove the canonical projection
          // is authoritative for every History affordance.
          scopes: ["history:read", "revisions:write", "revisions:read"],
          capabilityMode: "canonical",
          grantedCapabilities: effectiveCapabilities,
          roleCapabilityCeiling: ["history:read", "revisions:write", "revisions:read"],
          effectiveCapabilities,
          legacyEffectiveActions: [],
        });
      }
      if (url.endsWith(`/chapters/${CHAPTER}/history?limit=50`)) {
        return json({
          items: [revision(3, true), revision(2), revision(1)],
          current: { ...revision(3, true), status: "published" },
          nextCursor: null,
        });
      }
      const detailMatch = url.match(/\/history\/(\d+)\?compare=(previous|current)$/u);
      if (detailMatch !== null) {
        const selected = Number(detailMatch[1]);
        const compare = detailMatch[2] as "previous" | "current";
        const comparisonRevision =
          compare === "previous"
            ? selected > 1
              ? selected - 1
              : null
            : selected < 3
              ? 3
              : null;
        return json({
          chapterId: CHAPTER,
          compare,
          selected: { ...revision(selected, selected === 3), content: content(selected) },
          comparison:
            comparisonRevision === null
              ? null
              : {
                  ...revision(comparisonRevision, comparisonRevision === 3),
                  content: content(comparisonRevision),
                },
          current: { ...revision(3, true), status: "published" },
          diff:
            comparisonRevision === null
              ? null
              : {
                  fromRevision: compare === "previous" ? comparisonRevision : selected,
                  toRevision: compare === "previous" ? selected : comparisonRevision,
                  unifiedDiff: [
                    "--- a/chapter.md",
                    "+++ b/chapter.md",
                    "@@ -1 +1 @@",
                    `-${content(compare === "previous" ? comparisonRevision : selected).trimEnd()}`,
                    `+${content(compare === "previous" ? selected : comparisonRevision).trimEnd()}`,
                    "",
                  ].join("\n"),
                  computationLimited: false,
                },
        });
      }
      if (url.endsWith("/history/2/restore") && init?.method === "POST") {
        return json(
          {
            proposalId: "proposal-restore",
            status: "pending_review",
            correlationId: "correlation-restore",
          },
          201,
        );
      }
      if (url.includes("/events?")) return json({ detail: "event feed unavailable" }, 404);
      return json({ detail: `unexpected ${url}` }, 404);
    }),
  );
}

function mount(chapterRevision = "2"): AuthorbotChapterHistory {
  const prose = document.createElement("div");
  prose.className = "prose";
  prose.textContent = "The deployed chapter remains readable.";
  document.body.append(prose);
  const host = document.createElement("authorbot-chapter-history") as AuthorbotChapterHistory;
  Object.assign(host.dataset, {
    apiBase: API,
    project: PROJECT,
    base: "/book/",
    chapterId: CHAPTER,
    chapterTitle: "Signal",
    chapterRevision,
    chapterStatus: "published",
  });
  document.body.append(host);
  return host;
}

beforeEach(() => {
  document.body.textContent = "";
  globalThis.history.replaceState(null, "", "/");
  resetProjectStoresForTests();
  setChapterHistoryPanelLoaderForTests(async () => ({ AuthorbotChapterHistoryPanel }));
});

afterEach(() => {
  document.body.textContent = "";
  resetChapterHistoryPanelLoaderForTests();
  vi.unstubAllGlobals();
});

describe("inline chapter history", () => {
  it("opens the exact accepted revision named by a contributor history link", async () => {
    stubApi();
    const loader = vi.fn(async () => ({ AuthorbotChapterHistoryPanel }));
    setChapterHistoryPanelLoaderForTests(loader);
    globalThis.history.replaceState(null, "", "/#authorbot-history-revision-2");

    const host = mount();

    await expect.poll(() => host.querySelector(".ab-history-detail-header h3")?.textContent).toBe(
      "Revision 2 of 3",
    );
    expect(loader).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".ab-history-trigger")?.getAttribute("aria-expanded")).toBe("true");
    expect(
      host.querySelector('.ab-history-revision[data-revision="2"]')?.id,
    ).toBe("authorbot-history-revision-2");

    globalThis.history.replaceState(null, "", "/#authorbot-history-revision-1");
    globalThis.dispatchEvent(new HashChangeEvent("hashchange"));
    await expect.poll(() => host.querySelector(".ab-history-detail-header h3")?.textContent).toBe(
      "Revision 1 of 3",
    );

    // An explicit deep link to current remains useful, but current never
    // becomes an ordinary timeline row.
    globalThis.history.replaceState(null, "", "/#authorbot-history-revision-3");
    globalThis.dispatchEvent(new HashChangeEvent("hashchange"));
    await expect.poll(() => host.querySelector(".ab-history-detail-header h3")?.textContent).toBe(
      "Revision 3 of 3",
    );
    expect(
      host.querySelector('.ab-history-revision[data-revision="3"]'),
    ).toBeNull();
  });

  it("shows a calm empty history state when the chapter has no prior revision", async () => {
    const detailCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${API}/v1/me`) {
          return json({
            actor: { id: "editor-1", displayName: "Editor", externalIdentity: "github:editor" },
            memberships: [{ role: "editor" }],
            scopes: ["history:read"],
            capabilityMode: "canonical",
            grantedCapabilities: ["history:read"],
            roleCapabilityCeiling: ["history:read"],
            effectiveCapabilities: ["history:read"],
            legacyEffectiveActions: [],
          });
        }
        if (url.endsWith(`/chapters/${CHAPTER}/history?limit=50`)) {
          return json({
            items: [revision(1, true)],
            current: { ...revision(1, true), status: "published" },
            nextCursor: null,
          });
        }
        if (/\/history\/\d+\?/u.test(url)) detailCalls.push(url);
        if (url.includes("/events?")) return json({ detail: "event feed unavailable" }, 404);
        return json({ detail: `unexpected ${url}` }, 404);
      }),
    );
    const host = mount("1");
    await expect.poll(() => host.querySelector<HTMLButtonElement>(".ab-history-trigger")).toBeTruthy();
    host.querySelector<HTMLButtonElement>(".ab-history-trigger")?.click();

    await expect.poll(() => host.querySelector(".ab-history-detail-loading")?.textContent).toContain(
      "no earlier revisions",
    );
    expect(host.querySelectorAll(".ab-history-revision")).toHaveLength(0);
    expect(host.querySelector(".ab-history-list-empty")?.textContent).toContain(
      "No earlier revisions",
    );
    expect(host.querySelector<HTMLButtonElement>(".ab-history-step")?.disabled).toBe(true);
    expect(detailCalls).toEqual([]);
  });

  it("loads only on expansion, walks to the original, compares current, restores a proposal, and returns focus on Escape", async () => {
    stubApi();
    const loader = vi.fn(async () => ({ AuthorbotChapterHistoryPanel }));
    setChapterHistoryPanelLoaderForTests(loader);
    const host = mount();

    await expect.poll(() => host.querySelector<HTMLButtonElement>(".ab-history-trigger")).toBeTruthy();
    const trigger = host.querySelector<HTMLButtonElement>(".ab-history-trigger")!;
    expect(loader).not.toHaveBeenCalled();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-controls")).toMatch(/^ab-chapter-history-/u);

    trigger.click();
    await expect.poll(() => host.querySelector(".ab-history-detail-header h3")?.textContent).toBe(
      "Revision 2 of 3",
    );
    expect(loader).toHaveBeenCalledTimes(1);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector("authorbot-chapter-history-panel")?.getAttribute("role")).toBe(
      "region",
    );
    expect(host.querySelector(".ab-history-current-copy")?.textContent).toContain(
      "Current published revision: 3",
    );
    expect(host.querySelector(".ab-history-current-copy")?.textContent).toContain(
      "deployed reading page still shows revision 2",
    );
    expect(host.querySelector(".ab-history-snapshot code")?.textContent).toBe(content(2));
    expect(host.querySelector(".ab-history-snapshot img")).toBeNull();
    expect(host.querySelector('.ab-history-revision[data-revision="3"]')).toBeNull();

    const revisionTwo = host.querySelector<HTMLButtonElement>(
      '.ab-history-revision[data-revision="2"]',
    )!;
    expect(revisionTwo.textContent).toContain("commit commit-2");
    const revisionOne = host.querySelector<HTMLButtonElement>(
      '.ab-history-revision[data-revision="1"]',
    )!;
    expect(revisionTwo.tabIndex).toBe(0);
    expect(revisionOne.tabIndex).toBe(-1);
    expect(
      Array.from(
        host.querySelectorAll<HTMLButtonElement>(".ab-history-revision"),
      ).filter((button) => button.tabIndex === 0),
    ).toEqual([revisionTwo]);
    const selectedMetadata = host.querySelector(".ab-history-selected-meta")?.textContent ?? "";
    expect(selectedMetadata).toContain("Publication statepublished");
    expect(selectedMetadata).toContain("Commitcommit-2");
    expect(selectedMetadata).toContain("AuthorWriter <script>");
    expect(host.querySelector(".ab-history-selected-meta script")).toBeNull();

    const currentCompare = host.querySelector<HTMLButtonElement>(
      'button[data-compare="current"]',
    )!;
    currentCompare.click();
    await expect.poll(() =>
      Array.from(
        host.querySelectorAll(".ab-history-diff .ab-revision-diff-snapshot code"),
        (node) => node.textContent,
      ),
    ).toEqual([content(2), content(3)]);
    expect(host.querySelector(".ab-history-diff-heading")?.textContent).toContain(
      "Revision 2 compared with current revision 3",
    );

    host.querySelector<HTMLButtonElement>(".ab-history-restore-button")?.click();
    await expect.poll(() => host.querySelector(".ab-history-restore-success")?.textContent).toContain(
      "submitted as a proposal for review",
    );
    expect(host.querySelector<HTMLAnchorElement>(".ab-history-review-link")?.pathname).toBe(
      "/book/revisions/",
    );

    // Direct-list keyboard navigation follows newest-first visual order.
    const focusedTwo = host.querySelector<HTMLButtonElement>(
      '.ab-history-revision[data-revision="2"]',
    )!;
    focusedTwo.focus();
    focusedTwo.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await expect.poll(() => host.querySelector(".ab-history-detail-header h3")?.textContent).toBe(
      "Revision 1 of 3",
    );
    await expect.poll(() => host.querySelector(".ab-history-no-comparison")?.textContent).toContain(
      "original revision",
    );
    expect(document.activeElement?.getAttribute("data-revision")).toBe("1");
    expect(revisionOne.tabIndex).toBe(0);
    expect(revisionTwo.tabIndex).toBe(-1);

    const panel = host.querySelector("authorbot-chapter-history-panel")!;
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.hasAttribute("hidden")).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps history invisible without history:read and hides restore without revisions:write", async () => {
    stubApi([]);
    const denied = mount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(denied.querySelector(".ab-history-trigger")).toBeNull();

    denied.remove();
    resetProjectStoresForTests();
    stubApi(["history:read"]);
    const readOnly = mount();
    await expect.poll(() => readOnly.querySelector<HTMLButtonElement>(".ab-history-trigger")).toBeTruthy();
    readOnly.querySelector<HTMLButtonElement>(".ab-history-trigger")?.click();
    await expect.poll(() => readOnly.querySelector(".ab-history-detail-header h3")?.textContent).toBe(
      "Revision 2 of 3",
    );
    await expect.poll(() => readOnly.querySelector(".ab-history-restore")?.textContent).toContain(
      "cannot propose restoring",
    );
    expect(readOnly.querySelector(".ab-history-restore-button")).toBeNull();

    readOnly.remove();
    resetProjectStoresForTests();
    stubApi(["history:read", "revisions:write"]);
    const writeWithoutRead = mount();
    await expect.poll(() =>
      writeWithoutRead.querySelector<HTMLButtonElement>(".ab-history-trigger"),
    ).toBeTruthy();
    writeWithoutRead.querySelector<HTMLButtonElement>(".ab-history-trigger")?.click();
    await expect.poll(() =>
      writeWithoutRead.querySelector(".ab-history-detail-header h3")?.textContent,
    ).toBe("Revision 2 of 3");
    await expect.poll(() =>
      writeWithoutRead.querySelector<HTMLButtonElement>(".ab-history-restore-button"),
    ).toBeTruthy();
    writeWithoutRead.querySelector<HTMLButtonElement>(".ab-history-restore-button")?.click();
    await expect.poll(() =>
      writeWithoutRead.querySelector(".ab-history-restore-success")?.textContent,
    ).toContain("submitted as a proposal for review");
    expect(writeWithoutRead.querySelector(".ab-history-review-link")).toBeNull();
  });

  it("preserves the active visual diff and focus across unrelated project updates", async () => {
    stubApi();
    const host = mount();
    await expect.poll(() =>
      host.querySelector<HTMLButtonElement>(".ab-history-trigger"),
    ).toBeTruthy();
    host.querySelector<HTMLButtonElement>(".ab-history-trigger")?.click();
    await expect.poll(() => host.querySelector(".ab-history-detail-header h3")?.textContent).toBe(
      "Revision 2 of 3",
    );
    host.querySelector<HTMLButtonElement>('button[data-compare="current"]')?.click();
    await expect.poll(() => host.querySelector(".ab-revision-diff-visual")).toBeTruthy();

    const diff = host.querySelector<HTMLElement>(".ab-history-diff")!;
    const visual = host.querySelector<HTMLElement>(".ab-revision-diff-visual")!;
    const focused = host.querySelector<HTMLButtonElement>(
      'button[data-compare="current"]',
    )!;
    focused.focus();
    expect(document.activeElement).toBe(focused);

    getProjectStore({ apiBase: API, project: PROJECT }).setState({
      workItemsStatus: "loading",
    });
    await Promise.resolve();

    expect(host.querySelector(".ab-history-diff")).toBe(diff);
    expect(host.querySelector(".ab-revision-diff-visual")).toBe(visual);
    expect(document.activeElement).toBe(focused);
  });

  it("retains the active diff DOM, focus, and layout while older history pages merge", async () => {
    let resolveOlder!: (response: Response) => void;
    const older = new Promise<Response>((resolve) => {
      resolveOlder = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${API}/v1/me`) {
          return json({
            actor: { id: "editor-1", displayName: "Editor", externalIdentity: "github:editor" },
            memberships: [{ role: "editor" }],
            scopes: ["history:read", "revisions:write", "revisions:read"],
            capabilityMode: "canonical",
            grantedCapabilities: ["history:read", "revisions:write", "revisions:read"],
            roleCapabilityCeiling: ["history:read", "revisions:write", "revisions:read"],
            effectiveCapabilities: ["history:read", "revisions:write", "revisions:read"],
            legacyEffectiveActions: [],
          });
        }
        if (url.endsWith(`/chapters/${CHAPTER}/history?limit=50`)) {
          return json({
            items: [revision(103, true), revision(102)],
            current: { ...revision(103, true), status: "published" },
            nextCursor: "2",
          });
        }
        if (url.endsWith(`/chapters/${CHAPTER}/history?limit=50&cursor=2`)) {
          return older;
        }
        const detailMatch = url.match(/\/history\/(\d+)\?compare=(previous|current)$/u);
        if (detailMatch !== null) {
          const selected = Number(detailMatch[1]);
          const compare = detailMatch[2] as "previous" | "current";
          const comparisonRevision = compare === "previous" ? selected - 1 : 103;
          return json({
            chapterId: CHAPTER,
            compare,
            selected: { ...revision(selected), content: `Revision ${selected}\n` },
            comparison: {
              ...revision(comparisonRevision, comparisonRevision === 103),
              content: `Revision ${comparisonRevision}\n`,
            },
            current: { ...revision(103, true), status: "published" },
            diff: {
              fromRevision: compare === "previous" ? comparisonRevision : selected,
              toRevision: compare === "previous" ? selected : comparisonRevision,
              unifiedDiff: [
                "--- a/chapter.md",
                "+++ b/chapter.md",
                "@@ -1 +1 @@",
                `-Revision ${compare === "previous" ? comparisonRevision : selected}`,
                `+Revision ${compare === "previous" ? selected : comparisonRevision}`,
                "",
              ].join("\n"),
              computationLimited: false,
            },
          });
        }
        if (url.includes("/events?")) return json({ detail: "event feed unavailable" }, 404);
        return json({ detail: `unexpected ${url}` }, 404);
      }),
    );

    const host = mount("102");
    await expect.poll(() =>
      host.querySelector<HTMLButtonElement>(".ab-history-trigger"),
    ).toBeTruthy();
    host.querySelector<HTMLButtonElement>(".ab-history-trigger")?.click();
    await expect.poll(() => host.querySelector(".ab-history-detail-header h3")?.textContent).toBe(
      "Revision 102 of 103",
    );
    await expect.poll(() => host.querySelector(".ab-revision-diff-visual")).toBeTruthy();

    const diff = host.querySelector<HTMLElement>(".ab-history-diff")!;
    const visual = host.querySelector<HTMLElement>(".ab-revision-diff-visual")!;
    const inline = host.querySelector<HTMLButtonElement>(
      '.ab-revision-diff-layout-button[data-layout="line-by-line"]',
    )!;
    inline.click();
    inline.focus();
    expect(visual.dataset.layout).toBe("line-by-line");
    expect(document.activeElement).toBe(inline);

    resolveOlder(
      json({
        items: [revision(101), revision(100)],
        current: { ...revision(103, true), status: "published" },
        nextCursor: null,
      }),
    );
    await expect.poll(() =>
      host.querySelector('.ab-history-revision[data-revision="100"]'),
    ).toBeTruthy();

    expect(host.querySelector(".ab-history-diff")).toBe(diff);
    expect(host.querySelector(".ab-revision-diff-visual")).toBe(visual);
    expect(document.activeElement).toBe(inline);
    expect(inline.getAttribute("aria-pressed")).toBe("true");

    host.querySelector<HTMLButtonElement>('button[data-compare="current"]')?.click();
    await expect.poll(() =>
      host.querySelector<HTMLElement>(".ab-revision-diff-visual")?.dataset.layout,
    ).toBe("line-by-line");
  });

  it("rebuilds an unchanged timeline after the panel disconnects and reconnects", async () => {
    stubApi();
    const host = mount();
    await expect.poll(() =>
      host.querySelector<HTMLButtonElement>(".ab-history-trigger"),
    ).toBeTruthy();
    host.querySelector<HTMLButtonElement>(".ab-history-trigger")?.click();
    await expect.poll(() =>
      host.querySelectorAll(".ab-history-revision").length,
    ).toBe(2);

    const panel = host.querySelector("authorbot-chapter-history-panel")!;
    panel.remove();
    host.append(panel);

    await expect.poll(() =>
      panel.querySelectorAll(".ab-history-revision").length,
    ).toBe(2);
    expect(
      panel.querySelector('.ab-history-revision[aria-current="true"]')
        ?.getAttribute("data-revision"),
    ).toBe("2");
  });

  it("leaves the chapter readable and reports a terminal lazy-chunk failure once", async () => {
    stubApi();
    const failure = vi.fn(async () => {
      throw new TypeError("history chunk unavailable");
    });
    setChapterHistoryPanelLoaderForTests(failure);
    const host = mount();
    await expect.poll(() => host.querySelector<HTMLButtonElement>(".ab-history-trigger")).toBeTruthy();
    const trigger = host.querySelector<HTMLButtonElement>(".ab-history-trigger")!;
    trigger.click();
    await expect.poll(() => host.querySelector(".ab-history-entry-status")?.textContent).toContain(
      "History could not load",
    );
    expect(trigger.disabled).toBe(false);
    expect(host.querySelector("authorbot-chapter-history-panel")).toBeNull();
    expect(document.querySelector(".prose")?.textContent).toContain("remains readable");

    trigger.click();
    await Promise.resolve();
    expect(failure).toHaveBeenCalledTimes(1);
  });
});
