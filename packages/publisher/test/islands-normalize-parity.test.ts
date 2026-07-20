// @vitest-environment happy-dom
import { normalizeBlockText, parseChapterMarkdown } from "@authorbot/markdown";
import { describe, expect, it } from "vitest";
import { renderAstToHtml } from "../src/render.js";
import { normalizeDomBlock } from "../site/src/islands/normalize.js";

/**
 * Phase 2b contract §2.2: the islands ship a mirror of the
 * `@authorbot/markdown` normalizer, "with unit tests proving parity on the
 * package's own normalization fixtures". Each fixture is normalized twice —
 * from the mdast AST (`normalizeBlockText`) and from the publisher-rendered
 * DOM (`normalizeDomBlock`) — and the streams must be identical.
 */

/** Fixture sources from packages/markdown/test/normalize.test.ts, plus the
 * rendered constructs Phase 1 emits (tables, lists, footnotes, images). */
const FIXTURES: Array<[name: string, source: string]> = [
  ["NFC normalization (NFD source)", "Cafe\u0301 opens.\n"],
  ["whitespace collapse and trim", "  A   paragraph\twith\n   soft breaks.  \n"],
  [
    "inline formatting flattens",
    "Some *emphasized* and `coded` words in [a link](https://example.com).\n",
  ],
  ["authorbot comments excluded", "Before <!-- authorbot:x --> after.\n"],
  ["code block content", "```js\nconst a = 1;\nconst b = 2;\n```\n"],
  [
    "blockquote flow separation",
    "> First inner paragraph.\n>\n> Second inner paragraph.\n",
  ],
  ["segment mapping fixture", "Alpha *bravo* charlie.\n"],
  ["surrounding-content stability fixture", "The selected span stays put.\n"],
  ["hard break", "line one\\\nline two\n"],
  ["heading", "## A Heading with *style*\n"],
  ["unordered list", "- alpha\n- beta gamma\n- delta\n"],
  ["ordered list", "1. first\n2. second\n"],
  ["task list", "- [x] done item\n- [ ] open item\n"],
  ["nested list", "- outer\n  - inner one\n  - inner two\n"],
  ["gfm table", "| a | b |\n| --- | --- |\n| c | d |\n"],
  ["strikethrough", "Keep ~~drop this~~ the rest.\n"],
  ["image contributes no text", "An ![alt text](https://example.com/i.png) image.\n"],
  [
    "escaped inline HTML contributes no text (raw_html false)",
    "Before <span>mid</span> after.\n",
  ],
  [
    "forbidden-scheme image alt contributes no text",
    "An ![alt words](javascript:x) image.\n",
  ],
  [
    "footnote reference contributes no text",
    "Text with a note.[^1]\n\n[^1]: The note body.\n",
  ],
  [
    "blockquote containing a list",
    "> Intro line.\n>\n> - one\n> - two\n",
  ],
];

function astStream(source: string): string {
  const { ast } = parseChapterMarkdown(source);
  const node = ast.children[0];
  if (node === undefined) {
    throw new Error("fixture parsed to no blocks");
  }
  return normalizeBlockText(node).text;
}

function domStream(source: string): string {
  const html = renderAstToHtml(parseChapterMarkdown(source).ast);
  const container = document.createElement("div");
  container.innerHTML = html; // trusted test fixture, publisher-rendered
  const block = container.firstElementChild;
  if (block === null) {
    throw new Error("fixture rendered to no elements");
  }
  return normalizeDomBlock(block);
}

describe("islands normalizer parity with @authorbot/markdown", () => {
  for (const [name, source] of FIXTURES) {
    it(name, () => {
      expect(domStream(source)).toBe(astStream(source));
    });
  }

  it("parity streams are non-trivial (fixtures actually exercise text)", () => {
    for (const [, source] of FIXTURES) {
      expect(astStream(source).length).toBeGreaterThan(0);
    }
  });

  it("expected literals hold for the canonical fixtures", () => {
    expect(domStream("Café opens.\n")).toBe("Café opens.");
    expect(domStream("  A   paragraph\twith\n   soft breaks.  \n")).toBe(
      "A paragraph with soft breaks.",
    );
    expect(domStream("```js\nconst a = 1;\nconst b = 2;\n```\n")).toBe(
      "const a = 1; const b = 2;",
    );
    expect(domStream("| a | b |\n| --- | --- |\n| c | d |\n")).toBe("a b c d");
    expect(domStream("- [x] done item\n- [ ] open item\n")).toBe("done item open item");
  });

  it("skips island-injected UI defensively", () => {
    const container = document.createElement("div");
    container.innerHTML = "<p id=\"b-1\">Prose text</p>";
    const block = container.firstElementChild as Element;
    const ui = document.createElement("span");
    ui.setAttribute("data-ab-ui", "true");
    ui.textContent = "Annotate";
    block.append(ui);
    expect(normalizeDomBlock(block)).toBe("Prose text");
  });
});
