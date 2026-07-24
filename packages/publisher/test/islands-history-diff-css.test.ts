import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const historyCss = await readFile(
  new URL("../site/src/islands/chapter-history.css", import.meta.url),
  "utf8",
);
const diffCss = await readFile(
  new URL("../site/src/islands/revision-diff.css", import.meta.url),
  "utf8",
);

describe("chapter history and diff layout CSS", () => {
  it("uses the live manuscript measure for the Notes-replacement layout and pins a bounded rail", () => {
    expect(historyCss).toContain("--ab-chapter-reading-measure: 700px");
    expect(historyCss).toContain("max-width: var(--ab-chapter-reading-measure)");
    expect(historyCss).toContain("@media (min-width: 1600px)");
    expect(historyCss).toContain(
      "var(--ab-manuscript-surface-width, var(--ab-chapter-reading-measure))",
    );
    expect(historyCss).toMatch(
      /\.ab-history-rail\s*\{[\s\S]*?position: fixed;[\s\S]*?max-height: none;[\s\S]*?overflow-y: auto;/u,
    );
    expect(historyCss).not.toContain("radial-gradient");
    expect(historyCss).toContain("background: var(--surface-page, var(--bg, #1b1815))");
    expect(diffCss).toMatch(
      /\.ab-revision-diff-visual\s*\{[\s\S]*?background: var\(--surface-page, var\(--bg, #1b1815\)\);/u,
    );
    expect(historyCss).toContain(
      'font: 400 19px/1.75 var(--font-body, "Source Serif 4", Georgia, serif)',
    );
  });

  it("renders the accessible prose diff directly, removes gutters, and inherits manuscript type", () => {
    expect(diffCss).not.toContain(".ab-revision-diff-fallback-accessible");
    expect(diffCss).toMatch(
      /\.d2h-code-linenumber,[\s\S]*?\.d2h-code-side-linenumber\s*\{\s*display: none !important;/u,
    );
    expect(diffCss).toContain("@media (max-width: 1599px)");
    expect(diffCss).toMatch(
      /\.ab-revision-diff-layout\s*\{\s*display: none;/u,
    );
    expect(diffCss).toMatch(
      /\.ab-history-diff \.ab-prose-diff-line\s*\{[\s\S]*?font: inherit;[\s\S]*?line-height: inherit;/u,
    );
    expect(diffCss).toContain("background-color: rgb(224 85 79 / 34%) !important");
    expect(diffCss).toContain("background-color: rgb(70 164 112 / 38%) !important");
  });
});
