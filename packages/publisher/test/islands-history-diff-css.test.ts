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
  it("uses one shared reading measure, expands to exactly two measures only when wide, and pins a bounded rail", () => {
    expect(historyCss).toContain("--ab-chapter-reading-measure: 700px");
    expect(historyCss).toContain("max-width: var(--ab-chapter-reading-measure)");
    expect(historyCss).toContain("@media (min-width: 1436px)");
    expect(historyCss).toContain(
      "calc(var(--ab-chapter-reading-measure) + var(--ab-chapter-reading-measure))",
    );
    expect(historyCss).toMatch(
      /\.ab-history-rail\s*\{[\s\S]*?position: sticky;[\s\S]*?max-height: calc\(100vh - 92px\);[\s\S]*?overflow-y: auto;/u,
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

  it("keeps the accessibility snapshots offscreen, removes gutters, and hides layout controls when compact", () => {
    const accessibleFallback =
      /\.ab-revision-diff-fallback-accessible\s*\{([\s\S]*?)\n\}/u.exec(diffCss)?.[1] ?? "";
    expect(accessibleFallback).toContain("clip-path: inset(50%)");
    expect(accessibleFallback).not.toContain("display: none");
    expect(diffCss).toMatch(
      /\.d2h-code-linenumber,[\s\S]*?\.d2h-code-side-linenumber\s*\{\s*display: none !important;/u,
    );
    expect(diffCss).toContain("@media (max-width: 1435px)");
    expect(diffCss).toMatch(
      /\.ab-revision-diff-layout\s*\{\s*display: none;/u,
    );
    expect(diffCss).toContain(
      'font-family: var(--font-body, "Source Serif 4", Georgia, serif)',
    );
  });
});
