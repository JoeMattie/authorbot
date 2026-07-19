import { describe, expect, it } from "vitest";
import { normalizeBlockText, parseChapterMarkdown } from "../src/index.js";

function firstBlock(source: string) {
  const { ast } = parseChapterMarkdown(source);
  const node = ast.children[0];
  if (node === undefined) {
    throw new Error("no block parsed");
  }
  return node;
}

describe("normalizeBlockText", () => {
  it("applies NFC normalization", () => {
    // "Cafe" + combining acute accent (NFD source) must normalize to
    // precomposed \u00e9 in the output stream.
    const nfdSource = "Cafe\u0301 opens.\n";
    expect(nfdSource.normalize("NFC")).not.toBe(nfdSource);
    const result = normalizeBlockText(firstBlock(nfdSource));
    expect(result.text).toBe("Caf\u00e9 opens.");
    expect(result.text.includes("\u0301")).toBe(false);
  });

  it("collapses runs of whitespace to single spaces and trims", () => {
    const node = firstBlock("  A   paragraph\twith\n   soft breaks.  \n");
    expect(normalizeBlockText(node).text).toBe("A paragraph with soft breaks.");
  });

  it("flattens inline formatting into one text stream", () => {
    const node = firstBlock("Some *emphasized* and `coded` words in [a link](https://example.com).\n");
    expect(normalizeBlockText(node).text).toBe("Some emphasized and coded words in a link.");
  });

  it("excludes raw html and authorbot comments from the stream", () => {
    const node = firstBlock("Before <!-- authorbot:x --> after.\n");
    expect(normalizeBlockText(node).text).toBe("Before after.");
  });

  it("normalizes code block content", () => {
    const node = firstBlock("```js\nconst a = 1;\nconst b = 2;\n```\n");
    expect(normalizeBlockText(node).text).toBe("const a = 1; const b = 2;");
  });

  it("separates flow children of a blockquote", () => {
    const node = firstBlock("> First inner paragraph.\n>\n> Second inner paragraph.\n");
    expect(normalizeBlockText(node).text).toBe(
      "First inner paragraph. Second inner paragraph.",
    );
  });

  it("maps normalized ranges back to source positions", () => {
    const source = "Alpha *bravo* charlie.\n";
    const node = firstBlock(source);
    const result = normalizeBlockText(node);
    expect(result.text).toBe("Alpha bravo charlie.");

    // Three text nodes: "Alpha ", "bravo", " charlie."
    expect(result.segments).toHaveLength(3);
    const bravo = result.segments[1];
    expect(bravo).toBeDefined();
    expect(result.text.slice(bravo!.normStart, bravo!.normEnd)).toBe("bravo");
    // The source position points at the emphasized word in the raw source.
    const pos = bravo!.sourcePosition;
    expect(pos).toBeDefined();
    expect(source.slice(pos!.start.offset ?? 0, pos!.end.offset ?? 0)).toBe("bravo");

    // Segments are ordered and non-overlapping in the normalized stream.
    for (let i = 1; i < result.segments.length; i += 1) {
      expect(result.segments[i]!.normStart).toBeGreaterThanOrEqual(
        result.segments[i - 1]!.normEnd,
      );
    }
  });

  it("keeps normalized offsets stable across a surrounding-content edit", () => {
    const before = firstBlock("The selected span stays put.\n");
    const after = firstBlock("The selected span stays put.\n\nAnother paragraph appended.\n");
    expect(normalizeBlockText(before).text).toBe(normalizeBlockText(after).text);
  });
});
