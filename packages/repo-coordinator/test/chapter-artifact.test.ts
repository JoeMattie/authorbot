import { describe, expect, it } from "vitest";
import { applyChapterFrontmatterUpdate } from "../src/chapter-artifact.js";
import { chapterSourceFixture, uuidv7 } from "./helpers.js";

const CHAPTER_ID = uuidv7();

describe("applyChapterFrontmatterUpdate", () => {
  it("bumps the revision and appends the new author, preserving field order", () => {
    const source = chapterSourceFixture(CHAPTER_ID, 2);
    const { content, frontmatter } = applyChapterFrontmatterUpdate(source, {
      revision: 3,
      author: "github:jparish",
    });
    expect(frontmatter.revision).toBe(3);
    expect(frontmatter.authors).toEqual([
      { actor: "github:original-author" },
      { actor: "github:jparish" },
    ]);
    // Field order preserved: only revision line + authors gained a line.
    const keyOrder = (text: string): string[] =>
      text
        .split("---")[1]!
        .split("\n")
        .filter((line) => /^[a-z_]+:/.test(line))
        .map((line) => line.split(":")[0]!);
    expect(keyOrder(content)).toEqual(keyOrder(source));
  });

  it("preserves the body byte-for-byte and does not duplicate an existing author", () => {
    const body = '<!-- authorbot:block id="' + uuidv7() + '" -->\nExact   spacing\tkept.\n';
    const source = chapterSourceFixture(CHAPTER_ID, 4, {
      body,
      authors: ["github:original-author", "github:jparish"],
    });
    const { content, frontmatter } = applyChapterFrontmatterUpdate(source, {
      revision: 5,
      author: "github:jparish",
    });
    expect(frontmatter.authors).toHaveLength(2);
    expect(content.endsWith(`---\n\n${body}`)).toBe(true);
  });

  it("preserves YAML comments and untouched scalars", () => {
    const source = chapterSourceFixture(CHAPTER_ID, 2).replace(
      "title: Signal",
      "title: Signal # working title",
    );
    const { content } = applyChapterFrontmatterUpdate(source, {
      revision: 3,
      author: "github:jparish",
    });
    expect(content).toContain("title: Signal # working title");
    expect(content).toContain("summary: A chapter about honest instruments.");
  });

  it("is deterministic", () => {
    const source = chapterSourceFixture(CHAPTER_ID, 2);
    const update = { revision: 3, author: "github:jparish" } as const;
    expect(applyChapterFrontmatterUpdate(source, update).content).toBe(
      applyChapterFrontmatterUpdate(source, update).content,
    );
  });

  it("refuses a non-increasing revision", () => {
    const source = chapterSourceFixture(CHAPTER_ID, 3);
    expect(() =>
      applyChapterFrontmatterUpdate(source, { revision: 3, author: "github:jparish" }),
    ).toThrow(/must increase/);
    expect(() =>
      applyChapterFrontmatterUpdate(source, { revision: 2, author: "github:jparish" }),
    ).toThrow(/must increase/);
  });

  it("refuses files without frontmatter, revision, or authors", () => {
    expect(() =>
      applyChapterFrontmatterUpdate("no frontmatter", { revision: 2, author: "github:a" }),
    ).toThrow(/missing frontmatter/);
    const noRevision = chapterSourceFixture(CHAPTER_ID, 2).replace("revision: 2\n", "");
    expect(() =>
      applyChapterFrontmatterUpdate(noRevision, { revision: 3, author: "github:a" }),
    ).toThrow(/integer revision/);
    const noAuthors = chapterSourceFixture(CHAPTER_ID, 2)
      .replace("authors:\n", "")
      .replace("  - actor: github:original-author\n", "");
    expect(() =>
      applyChapterFrontmatterUpdate(noAuthors, { revision: 3, author: "github:a" }),
    ).toThrow(/authors/);
  });

  it("validates the result against the canonical chapter schema", () => {
    const badStatus = chapterSourceFixture(CHAPTER_ID, 2).replace(
      "status: draft",
      "status: not-a-status",
    );
    expect(() =>
      applyChapterFrontmatterUpdate(badStatus, { revision: 3, author: "github:a" }),
    ).toThrow();
  });
});
