import { describe, expect, it } from "vitest";
import { parseChapterMarkdown } from "../src/index.js";

const UUID_A = "0190f27e-1a93-7b61-996a-9f94849d27a8";

describe("parseChapterMarkdown", () => {
  it("parses YAML frontmatter into raw data", () => {
    const source = [
      "---",
      "schema: authorbot.chapter/v1",
      "id: 0190f27d-8ea5-7e43-a6f2-64d6939ff3b4",
      "slug: opening",
      "order: 10",
      "authors:",
      "  - actor: github:octocat",
      "---",
      "",
      `<!-- authorbot:block id="${UUID_A}" -->`,
      "The first paragraph.",
      "",
    ].join("\n");

    const parsed = parseChapterMarkdown(source);
    expect(parsed.frontmatterError).toBeUndefined();
    expect(parsed.frontmatter).toMatchObject({
      schema: "authorbot.chapter/v1",
      slug: "opening",
      order: 10,
      authors: [{ actor: "github:octocat" }],
    });
    expect(parsed.ast.type).toBe("root");
    expect(parsed.blocks.markers).toHaveLength(1);
  });

  it("returns undefined frontmatter when the document has none", () => {
    const parsed = parseChapterMarkdown("Just a paragraph.\n");
    expect(parsed.frontmatter).toBeUndefined();
    expect(parsed.frontmatterError).toBeUndefined();
  });

  it("reports unparseable YAML without throwing", () => {
    const source = ["---", "title: [unclosed", "---", "", "Body.", ""].join("\n");
    const parsed = parseChapterMarkdown(source);
    expect(parsed.frontmatter).toBeUndefined();
    expect(parsed.frontmatterError).toBeTypeOf("string");
  });

  it("does not treat the frontmatter node as a semantic block", () => {
    const source = ["---", "title: x", "---", "", "Unmarked paragraph.", ""].join("\n");
    const parsed = parseChapterMarkdown(source);
    expect(parsed.blocks.unmarked).toHaveLength(1);
    expect(parsed.blocks.unmarked[0]?.blockType).toBe("paragraph");
  });
});
