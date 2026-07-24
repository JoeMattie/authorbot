import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const collabCss = await readFile(
  new URL("../site/src/islands/collab.css", import.meta.url),
  "utf8",
);
const siteCss = await readFile(
  new URL("../site/src/styles/site.css", import.meta.url),
  "utf8",
);
const workCss = await readFile(
  new URL("../site/src/islands/work.css", import.meta.url),
  "utf8",
);

describe("dogfood layout regressions", () => {
  it("keeps compact chips on their reserved baseline", () => {
    expect(collabCss).toMatch(
      /\.ab-chip\s*\{[\s\S]*?height: 11px;[\s\S]*?padding-top: 1px;/u,
    );
  });

  it("holds collaboration cards until their measured gutter layout is ready", () => {
    expect(collabCss).toMatch(
      /\.ab-gutter \.ab-cards\[data-layout-ready="false"\]\s*\{\s*visibility: hidden;/u,
    );
  });

  it("contains promoted cards without adding a second active outline", () => {
    expect(collabCss).toMatch(
      /\.ab-cards\s*\{[\s\S]*?min-width: 0;[\s\S]*?max-width: 100%;[\s\S]*?overflow-x: clip;/u,
    );
    expect(collabCss).toMatch(
      /\.ab-card\.ab-promoted\.ab-active\s*\{[\s\S]*?outline: 0;/u,
    );
  });

  it("keeps compact Discussion promotion in a green right-hand gutter", () => {
    expect(collabCss).toMatch(
      /\.ab-discussion-thread\s*\{[\s\S]*?padding: 18px 64px 18px 22px;/u,
    );
    expect(collabCss).toMatch(
      /\.ab-discussion-thread \.ab-override-compact \[data-override="promote"\]\s*\{[\s\S]*?right: 16px;[\s\S]*?var\(--green-400/u,
    );
  });

  it("does not cap character tables or overwrite the collaborator eyebrow typography", () => {
    expect(siteCss).toMatch(
      /\.character-prose \.table-wrap\s*\{[\s\S]*?max-width: none;/u,
    );
    expect(siteCss).toContain(".story-chapter-summaries li > p");
    expect(siteCss).not.toMatch(/\.story-chapter-summaries p\s*\{/u);
  });

  it("contains the New Chapter page inside a padded reading surface", () => {
    expect(siteCss).toMatch(
      /\.write-page\s*\{[\s\S]*?width: min\(100%, 840px\);[\s\S]*?margin: 0 auto;[\s\S]*?padding: 48px clamp\(18px, 5vw, 40px\) 120px;/u,
    );
  });

  it("lets the Work introduction use the full page measure", () => {
    const rule = /\.work-page \.work-intro\s*\{([\s\S]*?)\n\}/u.exec(workCss)?.[1] ?? "";
    expect(rule).not.toContain("max-width");
  });
});
