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

  it("uses Diff2Html word matching for granular highlights inside changed lines", () => {
    const diff = [
      "--- a/chapter.md",
      "+++ b/chapter.md",
      "@@ -1 +1 @@",
      "-She would organise the old archive before sunrise.",
      "+She would organize the new archive before sunrise.",
      "",
    ].join("\n");
    const rendered = renderRevisionDiffHtml(diff, "line-by-line");
    expect(rendered).toContain('<del class="d2h-change">organise</del>');
    expect(rendered).toContain('<ins class="d2h-change">organize</ins>');
    expect(rendered).toContain("<del>old</del>");
    expect(rendered).toContain("<ins>new</ins>");
  });

  it("keeps word matching for prose lines beyond Diff2Html's 200-character default", () => {
    const paragraph = (lead: string): string =>
      `${lead} ${"archive corridor evidence remained carefully catalogued for the winter hearing. ".repeat(4)}`;
    const diff = [
      "--- a/chapter.md",
      "+++ b/chapter.md",
      "@@ -1,2 +1,2 @@",
      `-${paragraph("Alpha")}organise the old archive before sunrise.`,
      `-${paragraph("Beta")}measure the western annex before sunset.`,
      `+${paragraph("Beta")}measure the eastern annex before sunset.`,
      `+${paragraph("Alpha")}organize the new archive before sunrise.`,
      "",
    ].join("\n");

    const rendered = renderRevisionDiffHtml(diff, "line-by-line");
    expect(rendered).toContain('<del class="d2h-change">western</del>');
    expect(rendered).toContain('<ins class="d2h-change">eastern</ins>');
  });
});

describe("revision diff progressive renderer", () => {
  it("keeps exact snapshots available to assistive technology while enhancement is pending", () => {
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
    expect(fallback?.classList.contains("ab-revision-diff-fallback-accessible")).toBe(true);
    expect(fallback?.querySelector<HTMLElement>("summary")?.tabIndex).toBe(-1);
    expect(snapshots[0]?.getAttribute("aria-label")).toBe("Before");
    expect(snapshots[1]?.getAttribute("aria-label")).toBe("After");
    expect(snapshots[0]?.querySelector("code")?.textContent).toBe(HOSTILE);
    expect(snapshots[1]?.querySelector("code")?.textContent).toBe(`After & ${HOSTILE}`);
    expect(node.querySelector("img, script")).toBeNull();

    resolveCore({ renderRevisionDiffHtml });
    return handle.ready;
  });

  it("offers both layouts, forces inline when compact, and restores a wide preference", async () => {
    const media = new FakeMedia();
    const layouts: string[] = [];
    const preferred: string[] = [];
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
      {
        ...mediaOptions(media),
        coreLoader,
        onPreferredLayoutChange: (layout) => preferred.push(layout),
      } as RevisionDiffRenderOptions,
    );

    await expect(handle.ready).resolves.toBe("enhanced");
    expect(coreLoader).toHaveBeenCalledTimes(1);
    expect(layouts).toEqual(["side-by-side"]);
    expect(node.querySelector<HTMLElement>(".ab-revision-diff-visual")?.dataset.layout).toBe(
      "side-by-side",
    );
    const inline = node.querySelector<HTMLButtonElement>(
      '.ab-revision-diff-layout-button[data-layout="line-by-line"]',
    )!;
    const sideBySide = node.querySelector<HTMLButtonElement>(
      '.ab-revision-diff-layout-button[data-layout="side-by-side"]',
    )!;
    const controls = node.querySelector<HTMLElement>(".ab-revision-diff-layout")!;
    expect(controls.hidden).toBe(false);
    expect(inline.textContent).toBe("Inline");
    expect(sideBySide.textContent).toBe("Side by side");
    expect(sideBySide.getAttribute("aria-pressed")).toBe("true");
    expect(sideBySide.disabled).toBe(false);

    sideBySide.click();
    expect(layouts).toEqual(["side-by-side"]);
    inline.click();
    expect(layouts).toEqual(["side-by-side", "line-by-line"]);
    expect(inline.getAttribute("aria-pressed")).toBe("true");
    expect(preferred).toEqual(["side-by-side", "line-by-line"]);

    // A compact viewport always stays inline and makes side-by-side
    // unavailable. Returning wide keeps the explicit inline preference.
    media.setMobile(true);
    expect(layouts).toEqual(["side-by-side", "line-by-line", "line-by-line"]);
    expect(node.querySelector<HTMLElement>(".ab-revision-diff-visual")?.dataset.layout).toBe(
      "line-by-line",
    );
    expect(sideBySide.disabled).toBe(true);
    expect(controls.hidden).toBe(true);
    media.setMobile(false);
    expect(layouts.at(-1)).toBe("line-by-line");
    expect(controls.hidden).toBe(false);

    // A wide side-by-side choice is temporarily overridden, not discarded,
    // when the viewport can no longer fit two reading measures.
    sideBySide.click();
    expect(layouts.at(-1)).toBe("side-by-side");
    expect(preferred).toEqual(["side-by-side", "line-by-line", "side-by-side"]);
    media.setMobile(true);
    expect(layouts.at(-1)).toBe("line-by-line");
    expect(sideBySide.disabled).toBe(true);
    media.setMobile(false);
    expect(layouts.at(-1)).toBe("side-by-side");
    expect(sideBySide.disabled).toBe(false);
    expect(coreLoader).toHaveBeenCalledTimes(1);

    handle.destroy();
    const count = layouts.length;
    media.setMobile(true);
    expect(layouts).toHaveLength(count);
  });

  it("removes line-number gutters and keeps exact snapshots screen-reader-only after enhancement", async () => {
    const numbered = [
      "--- a/chapter.md",
      "+++ b/chapter.md",
      "@@ -12 +12 @@",
      "-Before.",
      "+After.",
      "",
    ].join("\n");
    const node = host();
    const handle = renderRevisionDiff(
      node,
      {
        unifiedDiff: numbered,
        before: "Before.",
        after: "After.",
      },
      // Force the real side-by-side template: its hunk row uses
      // `.d2h-code-side-line`, unlike the compact inline template.
      mediaOptions(new FakeMedia()),
    );

    await expect(handle.ready).resolves.toBe("enhanced");
    expect(
      node.querySelector(".d2h-code-linenumber, .d2h-code-side-linenumber"),
    ).toBeNull();
    expect(node.querySelector(".ab-revision-diff-visual")?.textContent).not.toContain(
      "@@ -12 +12 @@",
    );
    const fallback = node.querySelector<HTMLDetailsElement>(".ab-revision-diff-fallback")!;
    expect(fallback.open).toBe(true);
    expect(fallback.hasAttribute("hidden")).toBe(false);
    expect(fallback.classList.contains("ab-revision-diff-fallback-accessible")).toBe(true);
    expect(fallback.querySelector<HTMLElement>("summary")?.tabIndex).toBe(-1);
    expect(
      Array.from(fallback.querySelectorAll("code"), (code) => code.textContent),
    ).toEqual(["Before.", "After."]);
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
    expect(noDiff.querySelector("summary")?.hasAttribute("tabindex")).toBe(false);

    const failed = host();
    const failedHandle = renderRevisionDiff(
      failed,
      { unifiedDiff: UNIFIED, before: "Before.", after: "After." },
      { coreLoader: async () => Promise.reject(new TypeError("chunk unavailable")) },
    );
    await expect(failedHandle.ready).resolves.toBe("fallback");
    const fallback = failed.querySelector<HTMLDetailsElement>("details");
    expect(fallback?.open).toBe(true);
    expect(fallback?.classList.contains("ab-revision-diff-fallback-accessible")).toBe(false);
    expect(fallback?.querySelector("summary")?.hasAttribute("tabindex")).toBe(false);
    expect(failed.querySelector('[role="status"]')?.textContent).toContain(
      "plain-text comparison",
    );
  });
});
