import { describe, expect, it } from "vitest";
import {
  appendAttributionEntry,
  attributionFilePath,
  parseAttributionArtifact,
  renderAttributionArtifact,
} from "../src/attribution-artifact.js";
import { uuidv7 } from "./helpers.js";

const CHAPTER_ID = uuidv7();

describe("attribution artifact rendering", () => {
  it("renders a schema-valid file at the contract path and round-trips", () => {
    const workItemId = uuidv7();
    const file = renderAttributionArtifact({
      chapterId: CHAPTER_ID,
      entries: [{ revision: 3, actor: "github:jparish", workItemId }],
    });
    expect(file.path).toBe(`.authorbot/attribution/${CHAPTER_ID}.yml`);
    expect(file.path).toBe(attributionFilePath(CHAPTER_ID));
    const parsed = parseAttributionArtifact(file.content);
    expect(parsed.schema).toBe("authorbot.attribution/v1");
    expect(parsed.chapter_id).toBe(CHAPTER_ID);
    expect(parsed.entries).toEqual([
      { revision: 3, actor: "github:jparish", work_item_id: workItemId },
    ]);
  });

  it("is byte-stable for identical input", () => {
    const input = {
      chapterId: CHAPTER_ID,
      entries: [{ revision: 3, actor: "github:jparish", workItemId: uuidv7() }],
    };
    expect(renderAttributionArtifact(input).content).toBe(
      renderAttributionArtifact(input).content,
    );
  });

  it("omits commit by default and round-trips an explicit commit", () => {
    const noCommit = renderAttributionArtifact({
      chapterId: CHAPTER_ID,
      entries: [{ revision: 3, actor: "github:jparish", workItemId: uuidv7() }],
    });
    expect(noCommit.content).not.toContain("commit");
    const withCommit = renderAttributionArtifact({
      chapterId: CHAPTER_ID,
      entries: [{ revision: 3, actor: "github:jparish", commit: "a".repeat(40) }],
    });
    expect(parseAttributionArtifact(withCommit.content).entries[0]?.commit).toBe("a".repeat(40));
  });

  it("rejects schema-invalid input (empty entries, bad actor ref)", () => {
    expect(() => renderAttributionArtifact({ chapterId: CHAPTER_ID, entries: [] })).toThrow();
    expect(() =>
      renderAttributionArtifact({
        chapterId: CHAPTER_ID,
        entries: [{ revision: 1, actor: "not-a-ref" }],
      }),
    ).toThrow();
  });

  it("rejects unparseable and non-mapping YAML on parse", () => {
    expect(() => parseAttributionArtifact(": {")).toThrow(/unparseable/);
    expect(() => parseAttributionArtifact("- just\n- a list\n")).toThrow(/not a mapping/);
  });
});

describe("appendAttributionEntry", () => {
  const first = { revision: 3, actor: "github:jparish", workItemId: uuidv7() };

  it("creates the file for a null prior", () => {
    const result = appendAttributionEntry(null, CHAPTER_ID, first);
    expect(result.appended).toBe(true);
    expect(parseAttributionArtifact(result.file.content).entries).toHaveLength(1);
  });

  it("appends in order and stays byte-stable across appends", () => {
    const one = appendAttributionEntry(null, CHAPTER_ID, first);
    const second = { revision: 4, actor: "agent:muse-7", workItemId: uuidv7() };
    const two = appendAttributionEntry(one.file.content, CHAPTER_ID, second);
    expect(two.appended).toBe(true);
    const parsed = parseAttributionArtifact(two.file.content);
    expect(parsed.entries.map((entry) => entry.revision)).toEqual([3, 4]);
    expect(parsed.entries.map((entry) => entry.actor)).toEqual([
      "github:jparish",
      "agent:muse-7",
    ]);
    // Re-rendering the same logical content produces identical bytes.
    const again = appendAttributionEntry(one.file.content, CHAPTER_ID, second);
    expect(again.file.content).toBe(two.file.content);
  });

  it("is idempotent: an equal (revision, work item) entry is not re-appended", () => {
    const one = appendAttributionEntry(null, CHAPTER_ID, first);
    const replay = appendAttributionEntry(one.file.content, CHAPTER_ID, first);
    expect(replay.appended).toBe(false);
    expect(replay.file.content).toBe(one.file.content);
  });

  it("dedupes work-item-less entries by (revision, actor)", () => {
    const manual = { revision: 5, actor: "github:jparish" };
    const one = appendAttributionEntry(null, CHAPTER_ID, manual);
    const replay = appendAttributionEntry(one.file.content, CHAPTER_ID, manual);
    expect(replay.appended).toBe(false);
    // Same revision, different actor, still no work item: distinct entry.
    const other = appendAttributionEntry(one.file.content, CHAPTER_ID, {
      revision: 5,
      actor: "github:other",
    });
    expect(other.appended).toBe(true);
  });

  it("distinguishes same-revision entries by work item id", () => {
    const one = appendAttributionEntry(null, CHAPTER_ID, first);
    const sameRevisionOtherItem = { revision: 3, actor: "github:jparish", workItemId: uuidv7() };
    expect(
      appendAttributionEntry(one.file.content, CHAPTER_ID, sameRevisionOtherItem).appended,
    ).toBe(true);
  });

  it("refuses a prior file belonging to another chapter", () => {
    const one = appendAttributionEntry(null, CHAPTER_ID, first);
    expect(() => appendAttributionEntry(one.file.content, uuidv7(), first)).toThrow(/mismatch/);
  });
});
