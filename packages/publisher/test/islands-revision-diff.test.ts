// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderRevisionDiffHtml } from "../site/src/islands/revision-diff-core.js";
import {
  renderRevisionDiff,
  type RevisionDiffRenderOptions,
} from "../site/src/islands/revision-diff.js";

const UNIFIED = [
  "--- a/chapter.md",
  "+++ b/chapter.md",
  "@@ -1 +1 @@",
  "-Before.",
  "+After.",
  "",
].join("\n");

const HOSTILE = '<img src=x onerror="globalThis.pwned=true"> <script>alert(1)</script>';

class FakeMedia {
  matches = false;
  private listeners = new Set<() => void>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type !== "change") return;
    this.listeners.add(() => {
      if (typeof listener === "function") listener(new Event("change"));
      else listener.handleEvent(new Event("change"));
    });
  }

  removeEventListener(_type: string, _listener: EventListenerOrEventListenerObject): void {
    // Each test owns one short-lived media object; destroy behavior is asserted
    // through render counts rather than callback identity in this fake.
    this.listeners.clear();
  }

  setMobile(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.listeners) listener();
  }
}

function host(): HTMLDivElement {
  const node = document.createElement("div");
  document.body.append(node);
  return node;
}

function mediaOptions(media: FakeMedia): Pick<RevisionDiffRenderOptions, "mediaQuery"> {
  return {
    mediaQuery: media as unknown as NonNullable<RevisionDiffRenderOptions["mediaQuery"]>,
  };
}

afterEach(() => {
  document.body.textContent = "";
  delete (globalThis as { pwned?: boolean }).pwned;
});

describe("revision diff core", () => {
  it("renders only the requested core layout without a file list or syntax highlighter", () => {
    const wide = renderRevisionDiffHtml(UNIFIED, "side-by-side");
    expect(wide).toContain("d2h-files-diff");
    expect(wide).not.toContain("d2h-file-list");
    expect(wide).not.toContain("hljs");

    const mobile = renderRevisionDiffHtml(UNIFIED, "line-by-line");
    expect(mobile).toContain("d2h-file-diff");
    expect(mobile).not.toContain("d2h-file-list");
    expect(mobile).not.toContain("hljs");
  });

  it("escapes hostile prose in Diff2Html output", () => {
    const diff = [
      "--- a/chapter.md",
      "+++ b/chapter.md",
      "@@ -1 +1 @@",
      "-safe",
      `+${HOSTILE}`,
      "",
    ].join("\n");
    const rendered = renderRevisionDiffHtml(diff, "line-by-line");
    expect(rendered).toContain("&lt;img");
    expect(rendered).toContain("&lt;script&gt;");
    expect(rendered).not.toMatch(/<img\b/i);
    expect(rendered).not.toMatch(/<script\b/i);
  });
});

describe("revision diff progressive renderer", () => {
  it("shows a labelled, exact plain-text fallback before the lazy core resolves", () => {
    let resolveCore!: (core: { renderRevisionDiffHtml: typeof renderRevisionDiffHtml }) => void;
    const pending = new Promise<{ renderRevisionDiffHtml: typeof renderRevisionDiffHtml }>(
      (resolve) => {
        resolveCore = resolve;
      },
    );
    const node = host();
    const handle = renderRevisionDiff(
      node,
      { unifiedDiff: UNIFIED, before: HOSTILE, after: `After & ${HOSTILE}`, label: "Draft 9" },
      { coreLoader: () => pending },
    );

    const fallback = node.querySelector<HTMLDetailsElement>(".ab-revision-diff-fallback");
    const snapshots = node.querySelectorAll<HTMLElement>(".ab-revision-diff-snapshot");
    expect(node.getAttribute("aria-label")).toBe("Draft 9");
    expect(fallback?.open).toBe(true);
    expect(snapshots[0]?.getAttribute("aria-label")).toBe("Before");
    expect(snapshots[1]?.getAttribute("aria-label")).toBe("After");
    expect(snapshots[0]?.querySelector("code")?.textContent).toBe(HOSTILE);
    expect(snapshots[1]?.querySelector("code")?.textContent).toBe(`After & ${HOSTILE}`);
    expect(node.querySelector("img, script")).toBeNull();

    resolveCore({ renderRevisionDiffHtml });
    return handle.ready;
  });

  it("loads once, chooses side-by-side on wide screens, and redraws line-by-line on mobile", async () => {
    const media = new FakeMedia();
    const layouts: string[] = [];
    const coreLoader = vi.fn(async () => ({
      renderRevisionDiffHtml: (_diff: string, layout: string) => {
        layouts.push(layout);
        return `<div class="d2h-wrapper"><span>${layout}</span></div>`;
      },
    }));
    const node = host();
    const handle = renderRevisionDiff(
      node,
      { unifiedDiff: UNIFIED, before: "Before.", after: "After." },
      { ...mediaOptions(media), coreLoader } as RevisionDiffRenderOptions,
    );

    await expect(handle.ready).resolves.toBe("enhanced");
    expect(coreLoader).toHaveBeenCalledTimes(1);
    expect(layouts).toEqual(["side-by-side"]);
    expect(node.querySelector<HTMLElement>(".ab-revision-diff-visual")?.dataset.layout).toBe(
      "side-by-side",
    );

    media.setMobile(true);
    expect(layouts).toEqual(["side-by-side", "line-by-line"]);
    expect(node.querySelector<HTMLElement>(".ab-revision-diff-visual")?.dataset.layout).toBe(
      "line-by-line",
    );
    expect(coreLoader).toHaveBeenCalledTimes(1);

    handle.destroy();
    media.setMobile(false);
    expect(layouts).toHaveLength(2);
  });

  it("sanitizes hostile renderer markup before inserting the supplemental visual diff", async () => {
    const node = host();
    const handle = renderRevisionDiff(
      node,
      { unifiedDiff: UNIFIED, before: "safe", after: HOSTILE },
      {
        coreLoader: async () => ({
          renderRevisionDiffHtml: () =>
            '<div class="d2h-wrapper" onclick="globalThis.pwned=true">' +
            '<img src=x onerror="globalThis.pwned=true"><script>globalThis.pwned=true</script>' +
            '<span style="background:url(javascript:alert(1))">Visible text</span></div>',
        }),
      },
    );

    await expect(handle.ready).resolves.toBe("enhanced");
    const visual = node.querySelector(".ab-revision-diff-visual");
    expect(visual?.querySelector("img, script, style, input, label, svg")).toBeNull();
    expect(visual?.querySelector("[onclick], [onerror], [style], [src]")).toBeNull();
    expect(visual?.textContent).toContain("Visible text");
    expect((globalThis as { pwned?: boolean }).pwned).toBeUndefined();
    expect(node.querySelector(".ab-revision-diff-fallback code")?.textContent).toBe("safe");
  });

  it("does not request the core without a unified diff and keeps fallback open on chunk failure", async () => {
    const withoutDiffLoader = vi.fn();
    const noDiff = host();
    const noDiffHandle = renderRevisionDiff(
      noDiff,
      { unifiedDiff: null, before: "Before.", after: "After." },
      { coreLoader: withoutDiffLoader },
    );
    await expect(noDiffHandle.ready).resolves.toBe("fallback");
    expect(withoutDiffLoader).not.toHaveBeenCalled();
    expect(noDiff.querySelector<HTMLDetailsElement>("details")?.open).toBe(true);

    const failed = host();
    const failedHandle = renderRevisionDiff(
      failed,
      { unifiedDiff: UNIFIED, before: "Before.", after: "After." },
      { coreLoader: async () => Promise.reject(new TypeError("chunk unavailable")) },
    );
    await expect(failedHandle.ready).resolves.toBe("fallback");
    expect(failed.querySelector<HTMLDetailsElement>("details")?.open).toBe(true);
    expect(failed.querySelector('[role="status"]')?.textContent).toContain(
      "plain-text comparison",
    );
  });
});
