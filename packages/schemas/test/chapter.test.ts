import { describe, it } from "vitest";
import { chapterFrontmatterSchema } from "../src/index.js";
import { clone, expectInvalid, expectValid } from "./helpers.js";
import { BAD_UUID_V4, validChapter } from "./samples.js";

describe("chapterFrontmatterSchema", () => {
  it("accepts the design 8.3 example", () => {
    expectValid(chapterFrontmatterSchema, validChapter);
  });

  it("accepts a draft without published_at or refs", () => {
    const draft = clone(validChapter);
    draft.status = "draft";
    delete draft.published_at;
    delete draft.timeline_refs;
    delete draft.character_refs;
    delete draft.summary;
    expectValid(chapterFrontmatterSchema, draft);
  });

  it("accepts an agent token display name beside its durable actor ref", () => {
    const chapter = clone(validChapter);
    chapter.authors = [{ actor: "agent:019f86bc-b85d-70ae-8ff5-1e6e55da458f", name: "drafter" }];
    expectValid(chapterFrontmatterSchema, chapter);
  });

  it("rejects an unknown status", () => {
    const bad = clone(validChapter);
    bad.status = "in_review";
    expectInvalid(chapterFrontmatterSchema, bad);
  });

  it("rejects revision 0", () => {
    const bad = clone(validChapter);
    bad.revision = 0;
    expectInvalid(chapterFrontmatterSchema, bad);
  });

  it("rejects a fractional revision", () => {
    const bad = clone(validChapter);
    bad.revision = 1.5;
    expectInvalid(chapterFrontmatterSchema, bad);
  });

  it("rejects missing authors", () => {
    const bad = clone(validChapter);
    delete bad.authors;
    expectInvalid(chapterFrontmatterSchema, bad);
  });

  it("rejects empty authors", () => {
    const bad = clone(validChapter);
    bad.authors = [];
    expectInvalid(chapterFrontmatterSchema, bad);
  });

  it("rejects a bad actor namespace", () => {
    const bad = clone(validChapter);
    bad.authors = [{ actor: "gitlab:octocat" }];
    expectInvalid(chapterFrontmatterSchema, bad);
  });

  it("rejects an unknown key", () => {
    const bad = clone(validChapter);
    bad.word_count = 1234;
    expectInvalid(chapterFrontmatterSchema, bad);
  });

  it("rejects a UUIDv4 id", () => {
    const bad = clone(validChapter);
    bad.id = BAD_UUID_V4;
    expectInvalid(chapterFrontmatterSchema, bad);
  });

  it("rejects a bad published_at timestamp", () => {
    const bad = clone(validChapter);
    bad.published_at = "2026-07-19T18:00:00+02:00";
    expectInvalid(chapterFrontmatterSchema, bad);
  });

  it("rejects a timeline ref of the wrong kind", () => {
    const bad = clone(validChapter);
    bad.timeline_refs = ["character:protagonist"];
    expectInvalid(chapterFrontmatterSchema, bad);
  });

  it("rejects a character ref of the wrong kind", () => {
    const bad = clone(validChapter);
    bad.character_refs = ["event:first-contact"];
    expectInvalid(chapterFrontmatterSchema, bad);
  });
});
