import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const collabCss = await readFile(
  new URL("../site/src/islands/collab.css", import.meta.url),
  "utf8",
);
const collabElement = await readFile(
  new URL("../site/src/islands/collab-element.ts", import.meta.url),
  "utf8",
);
const notesPresentation = await readFile(
  new URL("../site/src/islands/chapter-notes-presentation.ts", import.meta.url),
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

  it("anchors desktop notes in paragraph document space without a viewport rail", () => {
    expect(collabCss).toMatch(
      /\.chapter-reading-layout\.ab-reading-layout > \.ab-gutter\s*\{[\s\S]*?position: relative;[\s\S]*?align-self: stretch;[\s\S]*?height: auto;[\s\S]*?max-height: none;/u,
    );
    expect(collabElement).toContain(
      "const anchorTop = anchor?.getBoundingClientRect().top ?? hostTop",
    );
    expect(collabElement).toContain(
      "documentAnchorStackPosition(",
    );
    expect(collabElement).not.toContain("ab-note-overflow-shelf");
    expect(collabElement).not.toContain("packNoteRail");
  });

  it("does not observe prose visibility or mutate notes while scrolling", () => {
    expect(collabElement).not.toContain("observeTargetVisibility");
    expect(notesPresentation).not.toContain("observeVisibility");
    expect(notesPresentation).not.toContain("IntersectionObserver");
    expect(notesPresentation).not.toContain(
      'window.addEventListener("scroll"',
    );
  });

  it("reconciles store updates without clearing mounted note surfaces", () => {
    expect(collabElement).toContain("reconcileElementChildren(");
    expect(collabElement).not.toContain('this.cardsHost.textContent = "";');
    expect(collabElement).not.toContain(
      "this.discussionThreadsHost.replaceChildren();",
    );
  });

  it("pins the rail heading and brings an opened card in front of its peeking stack", () => {
    expect(collabCss).toMatch(
      /\.ab-rail-head\s*\{[\s\S]*?position: sticky;[\s\S]*?z-index: 200;[\s\S]*?top: 69px;/u,
    );
    expect(collabCss).toMatch(
      /\.ab-gutter \.ab-card-shell\s*\{[\s\S]*?z-index: var\(--ab-anchor-depth, 1\);/u,
    );
    expect(collabCss).toMatch(
      /\.ab-gutter \.ab-card\.ab-note-expanded,[\s\S]*?\.ab-gutter \.ab-card\.ab-active,[\s\S]*?\.ab-gutter \.ab-card:focus-within\s*\{[\s\S]*?z-index: 100;/u,
    );
    expect(collabElement).toContain(
      "documentAnchorStackPosition(",
    );
    expect(collabElement).toContain('import { gsap } from "gsap";');
    expect(collabElement).toContain("gsap.fromTo(");
    expect(collabElement).toContain("gsap.to(card, {");
    expect(collabElement).toContain("height: collapsedHeight");
    expect(collabElement).toContain("height: expandedHeight");
    expect(collabElement).not.toMatch(/\bscale[XY]?:/u);
  });

  it("keeps mobile inline notes dense without shrinking their touch controls", () => {
    expect(collabCss).toMatch(
      /\.ab-inline-notes:not\(:empty\)\s*\{[\s\S]*?margin: 0 0 0\.75rem;/u,
    );
    expect(collabCss).toMatch(
      /\.ab-inline-notes \.ab-card\s*\{[\s\S]*?padding: 10px 11px;/u,
    );
    expect(collabCss).toMatch(
      /\.ab-inline-notes \.ab-override\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto;[\s\S]*?margin-top: 7px;[\s\S]*?padding-top: 7px;/u,
    );
    expect(collabCss).toMatch(
      /@media \(pointer: coarse\)\s*\{[\s\S]*?\.ab-vote-btn\s*\{[\s\S]*?min-height: 44px;/u,
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
