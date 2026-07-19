import { describe, expect, it } from "vitest";
import { parseChapterMarkdown } from "../src/index.js";

const UUID_A = "0190f27e-1a93-7b61-996a-9f94849d27a8";
const UUID_B = "0190f27e-76db-79c2-a455-a16916f79126";
const UUID_C = "0190f301-7045-7b2d-9d91-95b3c8228b54";

function markerLine(id: string): string {
  return `<!-- authorbot:block id="${id}" -->`;
}

describe("extractBlocks", () => {
  it("associates markers with paragraphs, headings, code blocks, and blockquotes", () => {
    const source = [
      markerLine(UUID_A),
      "# Heading",
      "",
      markerLine(UUID_B),
      "A paragraph.",
      "",
      markerLine(UUID_C),
      "```js",
      "code();",
      "```",
      "",
      markerLine(UUID_A),
      "> Quoted.",
      "",
    ].join("\n");

    const { blocks } = parseChapterMarkdown(source);
    expect(blocks.markers.map((m) => m.blockType)).toEqual([
      "heading",
      "paragraph",
      "code",
      "blockquote",
    ]);
    expect(blocks.markers.every((m) => m.valid)).toBe(true);
    expect(blocks.unmarked).toHaveLength(0);
    expect(blocks.malformed).toHaveLength(0);
    expect(blocks.markers.every((m) => m.position !== undefined)).toBe(true);
    expect(blocks.markers.every((m) => m.blockPosition !== undefined)).toBe(true);
  });

  it("associates a marker with the block on the immediately next line (no blank line)", () => {
    const source = [markerLine(UUID_A), "Adjacent paragraph.", ""].join("\n");
    const { blocks } = parseChapterMarkdown(source);
    expect(blocks.markers).toHaveLength(1);
    expect(blocks.markers[0]).toMatchObject({
      id: UUID_A,
      valid: true,
      blockType: "paragraph",
    });
    expect(blocks.unmarked).toHaveLength(0);
  });

  it("keeps marker association stable when surrounding content is edited", () => {
    const before = [
      markerLine(UUID_A),
      "Original paragraph.",
      "",
      markerLine(UUID_B),
      "Second paragraph.",
      "",
    ].join("\n");
    const after = [
      "# A brand new heading inserted above",
      "",
      markerLine(UUID_A),
      "Original paragraph, now reworded a little.",
      "",
      "An unmarked interloper paragraph.",
      "",
      markerLine(UUID_B),
      "Second paragraph.",
      "",
    ].join("\n");

    const first = parseChapterMarkdown(before).blocks;
    const second = parseChapterMarkdown(after).blocks;

    expect(first.markers.map((m) => m.id)).toEqual([UUID_A, UUID_B]);
    expect(second.markers.map((m) => m.id)).toEqual([UUID_A, UUID_B]);
    expect(second.markers.map((m) => m.blockType)).toEqual(["paragraph", "paragraph"]);
    expect(second.markers.every((m) => m.valid)).toBe(true);
    // The inserted heading and paragraph are unmarked; the marked blocks are not.
    expect(second.unmarked.map((u) => u.blockType)).toEqual(["heading", "paragraph"]);
  });

  it("reports a marker without a following block as malformed (missing_block)", () => {
    const source = ["Intro paragraph.", "", markerLine(UUID_A), ""].join("\n");
    const { blocks } = parseChapterMarkdown(source);
    expect(blocks.markers).toHaveLength(1);
    expect(blocks.markers[0]).toMatchObject({ id: UUID_A, valid: false, blockType: null });
    expect(blocks.markers[0]?.blockPosition).toBeUndefined();
    expect(blocks.malformed).toHaveLength(1);
    expect(blocks.malformed[0]).toMatchObject({ reason: "missing_block", id: UUID_A });
  });

  it("reports a marker followed only by another marker as missing its block", () => {
    const source = [markerLine(UUID_A), markerLine(UUID_B), "Paragraph.", ""].join("\n");
    const { blocks } = parseChapterMarkdown(source);
    expect(blocks.markers).toHaveLength(2);
    expect(blocks.markers[0]).toMatchObject({ id: UUID_A, valid: false, blockType: null });
    expect(blocks.markers[1]).toMatchObject({ id: UUID_B, valid: true, blockType: "paragraph" });
    expect(blocks.malformed.map((m) => m.reason)).toEqual(["missing_block"]);
  });

  it("returns all markers on duplicate ids (dedup policy belongs to callers)", () => {
    const source = [
      markerLine(UUID_A),
      "First.",
      "",
      markerLine(UUID_A),
      "Second.",
      "",
    ].join("\n");
    const { blocks } = parseChapterMarkdown(source);
    expect(blocks.markers.map((m) => m.id)).toEqual([UUID_A, UUID_A]);
    expect(blocks.markers.every((m) => m.valid)).toBe(true);
    expect(blocks.malformed).toHaveLength(0);
  });

  it("flags non-uuidv7 ids as invalid_id but still reports the marker", () => {
    const cases = [
      "not-a-uuid",
      "0190F27E-1A93-7B61-996A-9F94849D27A8", // uppercase
      "0190f27e-1a93-4b61-996a-9f94849d27a8", // version 4
      "0190f27e-1a93-7b61-c96a-9f94849d27a8", // bad variant nibble
    ];
    for (const id of cases) {
      const source = [markerLine(id), "Paragraph.", ""].join("\n");
      const { blocks } = parseChapterMarkdown(source);
      expect(blocks.markers).toHaveLength(1);
      expect(blocks.markers[0]).toMatchObject({ id, valid: false, blockType: "paragraph" });
      expect(blocks.malformed.map((m) => m.reason)).toEqual(["invalid_id"]);
    }
  });

  it("flags marker-like comments with bad syntax", () => {
    const cases = [
      '<!-- authorbot:block id=missing-quotes -->',
      "<!-- authorbot:block -->",
      `<!-- authorbot:block id="${UUID_A}" --> trailing junk`,
      `<!--authorbot:block id ="${UUID_A}"-->`,
    ];
    for (const raw of cases) {
      const source = [raw, "Paragraph.", ""].join("\n");
      const { blocks } = parseChapterMarkdown(source);
      expect(blocks.markers).toHaveLength(0);
      expect(blocks.malformed.some((m) => m.reason === "bad_syntax")).toBe(true);
      // A block preceded only by a broken marker counts as unmarked.
      expect(blocks.unmarked.map((u) => u.blockType)).toEqual(["paragraph"]);
    }
  });

  it("tolerates flexible internal whitespace in well-formed markers", () => {
    const source = [`<!--  authorbot:block   id="${UUID_A}"  -->`, "Paragraph.", ""].join("\n");
    const { blocks } = parseChapterMarkdown(source);
    expect(blocks.markers[0]).toMatchObject({ id: UUID_A, valid: true });
    expect(blocks.malformed).toHaveLength(0);
  });

  it("reports unmarked required blocks of each kind", () => {
    const source = [
      "# Unmarked heading",
      "",
      "Unmarked paragraph.",
      "",
      "```",
      "unmarked code",
      "```",
      "",
      "> Unmarked quote.",
      "",
    ].join("\n");
    const { blocks } = parseChapterMarkdown(source);
    expect(blocks.unmarked.map((u) => u.blockType)).toEqual([
      "heading",
      "paragraph",
      "code",
      "blockquote",
    ]);
  });

  it("does not require markers on lists, tables, or thematic breaks", () => {
    const source = ["- item one", "- item two", "", "---", ""].join("\n");
    const { blocks } = parseChapterMarkdown(source);
    expect(blocks.unmarked).toHaveLength(0);
  });

  it("accepts a marker before a list as an optional association", () => {
    const source = [markerLine(UUID_A), "- item one", "- item two", ""].join("\n");
    const { blocks } = parseChapterMarkdown(source);
    expect(blocks.markers[0]).toMatchObject({ id: UUID_A, valid: true, blockType: "list" });
  });

  it("accepts a marker before a blockquote paragraph (contract-optional unit)", () => {
    const source = [
      markerLine(UUID_A),
      `> ${markerLine(UUID_B)}`,
      "> A quoted paragraph, marked per contract section 3.",
      "",
    ].join("\n");
    const { blocks } = parseChapterMarkdown(source);
    expect(blocks.markers.map((m) => m.id)).toEqual([UUID_A, UUID_B]);
    expect(blocks.markers.map((m) => m.blockType)).toEqual(["blockquote", "paragraph"]);
    expect(blocks.markers.every((m) => m.valid)).toBe(true);
    expect(blocks.malformed).toHaveLength(0);
    expect(blocks.unmarked).toHaveLength(0);
  });

  it("accepts a marker inside a list item (tight and loose spellings)", () => {
    const tight = [
      markerLine(UUID_A),
      `- ${markerLine(UUID_B)}`,
      "  A marked list item.",
      "- An unmarked list item.",
      "",
    ].join("\n");
    const loose = [
      markerLine(UUID_A),
      `- ${markerLine(UUID_B)}`,
      "",
      "  A marked list item.",
      "",
    ].join("\n");
    for (const source of [tight, loose]) {
      const { blocks } = parseChapterMarkdown(source);
      expect(blocks.markers.map((m) => m.id)).toEqual([UUID_A, UUID_B]);
      expect(blocks.markers.every((m) => m.valid)).toBe(true);
      expect(blocks.malformed).toHaveLength(0);
      expect(blocks.unmarked).toHaveLength(0);
    }
  });

  it("does not require markers on nested blocks (blockquote paragraphs, list items)", () => {
    const source = [
      markerLine(UUID_A),
      "> First quoted paragraph.",
      ">",
      "> Second quoted paragraph, unmarked.",
      "",
    ].join("\n");
    const { blocks } = parseChapterMarkdown(source);
    expect(blocks.unmarked).toHaveLength(0);
    expect(blocks.malformed).toHaveLength(0);
  });

  it("reports a nested marker with no following block as missing_block", () => {
    const source = [markerLine(UUID_A), `> Quoted text.`, `> ${markerLine(UUID_B)}`, ""].join("\n");
    const { blocks } = parseChapterMarkdown(source);
    expect(blocks.malformed.map((m) => m.reason)).toEqual(["missing_block"]);
    expect(blocks.markers.find((m) => m.id === UUID_B)?.valid).toBe(false);
  });

  it("does not associate a marker across blank lines (immediately-before rule)", () => {
    const source = [markerLine(UUID_A), "", "", "A paragraph three lines later.", ""].join("\n");
    const { blocks } = parseChapterMarkdown(source);
    expect(blocks.markers).toHaveLength(1);
    expect(blocks.markers[0]).toMatchObject({ id: UUID_A, valid: false, blockType: null });
    expect(blocks.malformed.map((m) => m.reason)).toEqual(["missing_block"]);
    // The paragraph is not claimed by the stale marker, so it is unmarked.
    expect(blocks.unmarked.map((u) => u.blockType)).toEqual(["paragraph"]);
  });

  it("flags a marker-like comment inside a paragraph as not_own_line", () => {
    const source = [`Some prose ${markerLine(UUID_A)} continues here.`, ""].join("\n");
    const { blocks } = parseChapterMarkdown(source);
    expect(blocks.markers).toHaveLength(0);
    expect(blocks.malformed.some((m) => m.reason === "not_own_line")).toBe(true);
  });

  it("ignores non-marker authorbot comments for block extraction", () => {
    const source = [
      "<!-- authorbot:original:start -->",
      "Original text paragraph.",
      "<!-- authorbot:original:end -->",
      "",
    ].join("\n");
    const { blocks } = parseChapterMarkdown(source);
    expect(blocks.markers).toHaveLength(0);
    expect(blocks.malformed).toHaveLength(0);
    expect(blocks.unmarked.map((u) => u.blockType)).toEqual(["paragraph"]);
  });
});
