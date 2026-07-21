import { describe, expect, it } from "vitest";
import {
  applyBlockReplacement,
  applyChapterReplacement,
  applyRangeReplacement,
  generateUuidv7,
  isUuidv7,
  listMarkedBlocks,
  normalizeBlockText,
  parseChapterMarkdown,
  PatchError,
  stripBlockMarkers,
  type RangeTarget,
} from "../src/index.js";

const ID_A = "01900000-0000-7000-8000-00000000000a";
const ID_B = "01900000-0000-7000-8000-00000000000b";
const ID_C = "01900000-0000-7000-8000-00000000000c";

function marker(id: string): string {
  return `<!-- authorbot:block id="${id}" -->`;
}

function doc(blocks: [string, string][]): string {
  const body = blocks.map(([id, text]) => `${marker(id)}\n${text}`).join("\n\n");
  return `---\nschema: authorbot.chapter/v1\n---\n\n${body}\n`;
}

function quoteTarget(blockId: string, exact: string, extra?: Partial<RangeTarget>): RangeTarget {
  return { blockId, textQuote: { exact }, ...extra };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof PatchError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("expected a PatchError");
}

/** Deterministic UUIDv7 sequence for tests. */
function sequentialIds(): () => string {
  let n = 0;
  return () => `0190ffff-00${String(n++).padStart(2, "0")}-7000-8000-000000000000`;
}

describe("applyRangeReplacement", () => {
  const source = doc([
    [ID_A, "The drift appeared on a Tuesday."],
    [ID_B, "Mara logged *every* suspicion carefully."],
  ]);

  it("replaces exactly the declared span and nothing else", () => {
    const norm = "The drift appeared on a Tuesday.";
    const start = norm.indexOf("Tuesday");
    const result = applyRangeReplacement(
      source,
      quoteTarget(ID_A, "Tuesday", { textPosition: { start, end: start + 7 } }),
      "Wednesday",
    );
    expect(result.resolution).toBe("exact");
    expect(result.source).toContain("appeared on a Wednesday.");
    // Byte-level: everything outside the source span is unchanged.
    const ss = result.sourceSpan;
    expect(result.source.slice(0, ss.start)).toBe(source.slice(0, ss.start));
    expect(result.source.slice(ss.start, ss.end)).toBe("Wednesday");
    const removed = source.length - (result.source.length - "Wednesday".length + "Tuesday".length);
    expect(removed).toBe(0);
    expect(result.source.slice(ss.end)).toBe(source.slice(ss.start + "Tuesday".length));
    // Span points at the replacement in the new normalized stream.
    const block = listMarkedBlocks(result.source).find((b) => b.id === ID_A);
    expect(block).toBeDefined();
    const newNorm = normalizeBlockText(block!.node).text;
    expect(newNorm.slice(result.span.start, result.span.end)).toBe("Wednesday");
  });

  it("rebases via quote when the stored position is stale (relocated)", () => {
    const result = applyRangeReplacement(
      source,
      quoteTarget(ID_A, "Tuesday", { textPosition: { start: 0, end: 7 } }),
      "Friday",
    );
    expect(result.resolution).toBe("relocated");
    expect(result.source).toContain("appeared on a Friday.");
  });

  it("keeps all markers stable", () => {
    const result = applyRangeReplacement(source, quoteTarget(ID_A, "drift"), "signal");
    const before = parseChapterMarkdown(source).blocks.markers.map((m) => m.id);
    const after = parseChapterMarkdown(result.source).blocks.markers.map((m) => m.id);
    expect(after).toEqual(before);
  });

  it("supports deletion; span collapses to the insertion point", () => {
    const src = doc([[ID_A, "alpha beta gamma"]]);
    const result = applyRangeReplacement(src, quoteTarget(ID_A, "beta "), "");
    expect(result.source).toContain("alpha gamma");
    expect(result.span.start).toBe(result.span.end);
    expect(result.span.start).toBe("alpha ".length);
  });

  it("handles NFC unicode offsets in code units", () => {
    const src = doc([[ID_A, "Café opens 😀 today."]]);
    // Normalized: "Café opens 😀 today." - 😀 is two code units.
    const result = applyRangeReplacement(src, quoteTarget(ID_A, "😀"), "later");
    expect(result.source).toContain("Café opens later today.");
  });

  it("refuses when the source is NFD (offsets not byte-mappable)", () => {
    const src = doc([[ID_A, "Café opens today."]]);
    expect(codeOf(() => applyRangeReplacement(src, quoteTarget(ID_A, "opens"), "shuts"))).toBe(
      "not_contiguous",
    );
  });

  it("refuses when the source contains entity references", () => {
    const src = doc([[ID_A, "Fish &amp; chips forever."]]);
    expect(codeOf(() => applyRangeReplacement(src, quoteTarget(ID_A, "chips"), "mash"))).toBe(
      "not_contiguous",
    );
  });

  it("refuses spans crossing markup boundaries", () => {
    expect(
      codeOf(() => applyRangeReplacement(source, quoteTarget(ID_B, "logged every"), "kept no")),
    ).toBe("not_contiguous");
  });

  it("replaces inside inline code, preserving the backticks", () => {
    const src = doc([[ID_A, "Run `mara-cli sync` now."]]);
    const result = applyRangeReplacement(src, quoteTarget(ID_A, "sync"), "pull");
    expect(result.source).toContain("Run `mara-cli pull` now.");
  });

  it("replaces inside a fenced code block", () => {
    const src = doc([[ID_A, "```js\nconst a = 1;\n```"]]);
    const result = applyRangeReplacement(src, quoteTarget(ID_A, "a = 1;"), "a = 2;");
    expect(result.source).toContain("const a = 2;");
  });

  it("handles quotes at block start and end", () => {
    const src = doc([[ID_A, "alpha middle omega"]]);
    const atStart = applyRangeReplacement(src, quoteTarget(ID_A, "alpha"), "first");
    expect(atStart.source).toContain("first middle omega");
    const atEnd = applyRangeReplacement(src, quoteTarget(ID_A, "omega"), "last");
    expect(atEnd.source).toContain("alpha middle last");
  });

  it("rejects replacement containing marker-like comments (documented: reject, not escape)", () => {
    expect(
      codeOf(() =>
        applyRangeReplacement(
          source,
          quoteTarget(ID_A, "drift"),
          `x ${marker(ID_C)} y`,
        ),
      ),
    ).toBe("marker_in_replacement");
  });

  it("rejects multi-line range replacements", () => {
    expect(codeOf(() => applyRangeReplacement(source, quoteTarget(ID_A, "drift"), "a\nb"))).toBe(
      "invalid_replacement",
    );
  });

  it("throws target_missing for absent quotes", () => {
    expect(codeOf(() => applyRangeReplacement(source, quoteTarget(ID_A, "wormhole"), "x"))).toBe(
      "target_missing",
    );
  });

  it("throws target_ambiguous for repeated phrases without context", () => {
    const src = doc([[ID_A, "echo one echo two echo three"]]);
    expect(codeOf(() => applyRangeReplacement(src, quoteTarget(ID_A, "echo"), "x"))).toBe(
      "target_ambiguous",
    );
  });

  it("refuses a deletion that would empty the block (marker left dangling)", () => {
    const src = doc([[ID_A, "Solo."]]);
    expect(codeOf(() => applyRangeReplacement(src, quoteTarget(ID_A, "Solo."), ""))).toBe(
      "validation_failed",
    );
  });
});

describe("applyBlockReplacement", () => {
  const source = doc([
    [ID_A, "First paragraph text."],
    [ID_B, "Second paragraph text."],
  ]);

  it("replaces the block content and preserves its marker", () => {
    const result = applyBlockReplacement(source, ID_A, "Fresh content here.");
    expect(result.blockIds).toEqual([ID_A]);
    expect(result.source).toContain(`${marker(ID_A)}\nFresh content here.`);
    expect(result.source).toContain(`${marker(ID_B)}\nSecond paragraph text.`);
    // Outside the block: byte-identical.
    const blockStart = source.indexOf("First paragraph text.");
    expect(result.source.slice(0, blockStart)).toBe(source.slice(0, blockStart));
    expect(result.source.endsWith(source.slice(blockStart + "First paragraph text.".length))).toBe(
      true,
    );
  });

  it("gives fresh UUIDv7 markers to additional blocks in multi-block content", () => {
    const gen = sequentialIds();
    const result = applyBlockReplacement(
      source,
      ID_A,
      "One paragraph.\n\nAnother paragraph.\n\n## A heading",
      { generateId: gen },
    );
    expect(result.blockIds).toEqual([
      ID_A,
      "0190ffff-0000-7000-8000-000000000000",
      "0190ffff-0001-7000-8000-000000000000",
    ]);
    const parsed = parseChapterMarkdown(result.source);
    expect(parsed.blocks.malformed).toEqual([]);
    expect(parsed.blocks.unmarked).toEqual([]);
    expect(parsed.blocks.markers.map((m) => m.id)).toEqual([
      ID_A,
      "0190ffff-0000-7000-8000-000000000000",
      "0190ffff-0001-7000-8000-000000000000",
      ID_B,
    ]);
  });

  it("defaults to real UUIDv7 generation", () => {
    const result = applyBlockReplacement(source, ID_A, "One.\n\nTwo.");
    expect(result.blockIds).toHaveLength(2);
    expect(result.blockIds.slice(1).every((id) => isUuidv7(id))).toBe(true);
  });

  it("throws block_not_found for unknown ids", () => {
    expect(codeOf(() => applyBlockReplacement(source, ID_C, "x"))).toBe("block_not_found");
  });

  it("throws block_not_top_level for nested markers", () => {
    const nested = `---\nschema: authorbot.chapter/v1\n---\n\n${marker(ID_A)}\n> ${marker(ID_B)}\n> Quoted paragraph.\n`;
    expect(codeOf(() => applyBlockReplacement(nested, ID_B, "x"))).toBe("block_not_top_level");
  });

  it("rejects content containing marker comments", () => {
    expect(
      codeOf(() => applyBlockReplacement(source, ID_A, `${marker(ID_C)}\nSmuggled.`)),
    ).toBe("marker_in_replacement");
  });

  it("rejects empty content", () => {
    expect(codeOf(() => applyBlockReplacement(source, ID_A, "  \n"))).toBe("invalid_replacement");
  });

  it("rejects content that does not start with a markable block", () => {
    expect(codeOf(() => applyBlockReplacement(source, ID_A, "---\n\nAfter a rule."))).toBe(
      "invalid_replacement",
    );
  });
});

describe("applyChapterReplacement", () => {
  const contentA = "The drift appeared on a Tuesday.";
  const contentB = "Mara logged every suspicion.";
  const contentC = "Nothing respectable ever looks there.";
  const source = doc([
    [ID_A, contentA],
    [ID_B, contentB],
    [ID_C, contentC],
  ]);

  it("reuses ids for byte-identical blocks and mints fresh ids otherwise", () => {
    const gen = sequentialIds();
    const newBody = `${contentC}\n\nA brand new paragraph.\n\n${contentA}`;
    const result = applyChapterReplacement(source, newBody, { generateId: gen });
    expect(result.blocks).toEqual([
      { id: ID_C, reused: true },
      { id: "0190ffff-0000-7000-8000-000000000000", reused: false },
      { id: ID_A, reused: true },
    ]);
    const parsed = parseChapterMarkdown(result.source);
    expect(parsed.blocks.malformed).toEqual([]);
    expect(parsed.blocks.unmarked).toEqual([]);
    expect(parsed.blocks.markers.map((m) => m.id)).toEqual([
      ID_C,
      "0190ffff-0000-7000-8000-000000000000",
      ID_A,
    ]);
  });

  it("preserves the frontmatter byte-for-byte", () => {
    const result = applyChapterReplacement(source, "Only paragraph.");
    expect(result.source.startsWith("---\nschema: authorbot.chapter/v1\n---\n\n")).toBe(true);
  });

  it("consumes duplicate identical blocks in document order (stable matching)", () => {
    const dup = doc([
      [ID_A, "Twin text."],
      [ID_B, "Twin text."],
    ]);
    const result = applyChapterReplacement(dup, "Twin text.", {
      generateId: sequentialIds(),
    });
    expect(result.blocks).toEqual([{ id: ID_A, reused: true }]);
  });

  it("works without frontmatter", () => {
    const bare = `${marker(ID_A)}\n${contentA}\n`;
    const result = applyChapterReplacement(bare, contentA);
    expect(result.blocks).toEqual([{ id: ID_A, reused: true }]);
    expect(result.source.startsWith(marker(ID_A))).toBe(true);
  });

  it("rejects bodies containing marker comments (strip first)", () => {
    const marked = `${marker(ID_A)}\n${contentA}`;
    expect(codeOf(() => applyChapterReplacement(source, marked))).toBe("marker_in_replacement");
    // The documented escape hatch:
    const result = applyChapterReplacement(source, stripBlockMarkers(marked));
    expect(result.blocks).toEqual([{ id: ID_A, reused: true }]);
  });

  it("rejects bodies with no markable blocks", () => {
    expect(codeOf(() => applyChapterReplacement(source, "---\n"))).toBe("invalid_replacement");
  });
});

describe("stripBlockMarkers", () => {
  it("removes top-level and blockquote-nested marker lines only", () => {
    const body = [
      marker(ID_A),
      "Para one.",
      "",
      `> ${marker(ID_B)}`,
      "> Quoted.",
      "",
      "Plain <!-- not-a-marker --> line.",
    ].join("\n");
    expect(stripBlockMarkers(body)).toBe(
      ["Para one.", "", "> Quoted.", "", "Plain <!-- not-a-marker --> line."].join("\n"),
    );
  });
});

describe("generateUuidv7", () => {
  it("produces valid, unique lowercase UUIDv7s", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const id = generateUuidv7();
      expect(isUuidv7(id)).toBe(true);
      seen.add(id);
    }
    expect(seen.size).toBe(200);
  });

  it("encodes the timestamp in the first 48 bits", () => {
    const id = generateUuidv7(0x0190ffff0102);
    expect(id.startsWith("0190ffff-0102-7")).toBe(true);
  });

  it("rejects out-of-range timestamps", () => {
    expect(() => generateUuidv7(-1)).toThrow(RangeError);
    expect(() => generateUuidv7(2 ** 48)).toThrow(RangeError);
  });
});
