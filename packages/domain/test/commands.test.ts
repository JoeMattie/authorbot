import { describe, expect, it } from "vitest";
import {
  MAX_BODY_BYTES,
  createAnnotationCommandSchema,
  createReplyCommandSchema,
  mintAgentTokenCommandSchema,
  normalizeBody,
  utf8ByteLength,
  withdrawAnnotationCommandSchema,
} from "../src/index.js";

const CHAPTER_ID = "0190f27d-8ea5-7e43-a6f2-64d6939ff3b4";
const BLOCK_ID = "0190f27e-76db-79c2-a455-a16916f79126";
const ANNOTATION_ID = "0190f301-7045-7b2d-9d91-95b3c8228b54";
const UUID_V4 = "9b2c8f70-1234-4c56-8def-0123456789ab";

const rangeCommand = {
  chapterId: CHAPTER_ID,
  kind: "suggestion",
  scope: "range",
  chapterRevision: 4,
  target: {
    blockId: BLOCK_ID,
    textPosition: { start: 118, end: 163 },
    textQuote: { exact: "the text selected", prefix: "before ", suffix: " after" },
  },
  body: "Tighten this sentence.",
} as const;

function withTextPosition(start: number, end: number) {
  return {
    ...rangeCommand,
    target: { ...rangeCommand.target, textPosition: { start, end } },
  };
}

describe("utf8ByteLength", () => {
  it("counts ASCII, 2-, 3-, and 4-byte sequences", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("€")).toBe(3);
    expect(utf8ByteLength("𝄞")).toBe(4);
    expect(utf8ByteLength("")).toBe(0);
  });
});

describe("createAnnotationCommandSchema", () => {
  it("accepts a range suggestion (design section 10.1 payload)", () => {
    expect(createAnnotationCommandSchema.safeParse(rangeCommand).success).toBe(true);
  });

  it("accepts a block comment with a blockId-only target", () => {
    const result = createAnnotationCommandSchema.safeParse({
      chapterId: CHAPTER_ID,
      kind: "comment",
      scope: "block",
      chapterRevision: 1,
      target: { blockId: BLOCK_ID },
      body: "About this paragraph.",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a chapter-scope annotation without a target", () => {
    const result = createAnnotationCommandSchema.safeParse({
      chapterId: CHAPTER_ID,
      kind: "comment",
      scope: "chapter",
      chapterRevision: 2,
      body: "Chapter-wide note.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects textPosition.end === start", () => {
    expect(createAnnotationCommandSchema.safeParse(withTextPosition(10, 10)).success).toBe(false);
  });

  it("rejects textPosition.end < start", () => {
    expect(createAnnotationCommandSchema.safeParse(withTextPosition(20, 5)).success).toBe(false);
  });

  it("rejects negative or non-integer positions", () => {
    expect(createAnnotationCommandSchema.safeParse(withTextPosition(-1, 5)).success).toBe(false);
    expect(createAnnotationCommandSchema.safeParse(withTextPosition(0.5, 5)).success).toBe(false);
  });

  it("accepts a body of exactly 32 KiB and rejects one byte more", () => {
    const exact = { ...rangeCommand, body: "a".repeat(MAX_BODY_BYTES) };
    expect(createAnnotationCommandSchema.safeParse(exact).success).toBe(true);
    const over = { ...rangeCommand, body: "a".repeat(MAX_BODY_BYTES + 1) };
    expect(createAnnotationCommandSchema.safeParse(over).success).toBe(false);
  });

  it("measures the body limit in UTF-8 bytes, not characters", () => {
    // 16384 three-byte chars = 49152 bytes > 32 KiB although only 16384 chars.
    const multibyte = { ...rangeCommand, body: "€".repeat(16384) };
    expect(createAnnotationCommandSchema.safeParse(multibyte).success).toBe(false);
    // 10922 * 3 = 32766 bytes fits.
    const fits = { ...rangeCommand, body: "€".repeat(10922) };
    expect(createAnnotationCommandSchema.safeParse(fits).success).toBe(true);
  });

  it("rejects an empty body", () => {
    expect(
      createAnnotationCommandSchema.safeParse({ ...rangeCommand, body: "" }).success,
    ).toBe(false);
    // whitespace-only bodies normalize to empty and are rejected too
    expect(
      createAnnotationCommandSchema.safeParse({ ...rangeCommand, body: "  \n\r\n " }).success,
    ).toBe(false);
  });

  it("normalizes the body at intake: CRLF folded, whitespace trimmed", () => {
    // Regression: DB stored the raw body while the Git artifact renderer
    // trimmed + CRLF-folded, so a projection rebuild changed served bytes.
    const parsed = createAnnotationCommandSchema.parse({
      ...rangeCommand,
      body: "line1\r\nline2\n\n",
    });
    expect(parsed.body).toBe("line1\nline2");
    expect(normalizeBody("    indented code\n")).toBe("indented code");
    expect(normalizeBody("plain")).toBe("plain");

    const reply = createReplyCommandSchema.parse({
      annotationId: ANNOTATION_ID,
      body: "  reply\r\ntext  ",
    });
    expect(reply.body).toBe("reply\ntext");
  });

  it("rejects a range annotation without textQuote or textPosition", () => {
    const { textQuote: _q, ...noQuote } = rangeCommand.target;
    expect(
      createAnnotationCommandSchema.safeParse({ ...rangeCommand, target: noQuote }).success,
    ).toBe(false);
    const { textPosition: _p, ...noPosition } = rangeCommand.target;
    expect(
      createAnnotationCommandSchema.safeParse({ ...rangeCommand, target: noPosition }).success,
    ).toBe(false);
  });

  it("rejects a block target carrying range selectors (strict object)", () => {
    const result = createAnnotationCommandSchema.safeParse({
      chapterId: CHAPTER_ID,
      kind: "comment",
      scope: "block",
      chapterRevision: 1,
      target: { blockId: BLOCK_ID, textPosition: { start: 0, end: 5 } },
      body: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a chapter-scope annotation with a target", () => {
    const result = createAnnotationCommandSchema.safeParse({
      chapterId: CHAPTER_ID,
      kind: "comment",
      scope: "chapter",
      chapterRevision: 1,
      target: { blockId: BLOCK_ID },
      body: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing target for range and block scopes", () => {
    for (const scope of ["range", "block"] as const) {
      const result = createAnnotationCommandSchema.safeParse({
        chapterId: CHAPTER_ID,
        kind: "comment",
        scope,
        chapterRevision: 1,
        body: "x",
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects unknown kind, unknown scope, revision < 1, non-UUIDv7 ids", () => {
    expect(
      createAnnotationCommandSchema.safeParse({ ...rangeCommand, kind: "vote" }).success,
    ).toBe(false);
    expect(
      createAnnotationCommandSchema.safeParse({ ...rangeCommand, scope: "book" }).success,
    ).toBe(false);
    expect(
      createAnnotationCommandSchema.safeParse({ ...rangeCommand, chapterRevision: 0 }).success,
    ).toBe(false);
    expect(
      createAnnotationCommandSchema.safeParse({ ...rangeCommand, chapterId: UUID_V4 }).success,
    ).toBe(false);
    expect(
      createAnnotationCommandSchema.safeParse({
        ...rangeCommand,
        target: { ...rangeCommand.target, blockId: UUID_V4 },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown extra fields", () => {
    expect(
      createAnnotationCommandSchema.safeParse({ ...rangeCommand, sneaky: true }).success,
    ).toBe(false);
  });
});

describe("createReplyCommandSchema", () => {
  it("accepts a reply and an optional parent reply", () => {
    expect(
      createReplyCommandSchema.safeParse({ annotationId: ANNOTATION_ID, body: "Agreed." })
        .success,
    ).toBe(true);
    expect(
      createReplyCommandSchema.safeParse({
        annotationId: ANNOTATION_ID,
        parentReplyId: BLOCK_ID,
        body: "Nested.",
      }).success,
    ).toBe(true);
  });

  it("applies the same 32 KiB body rule", () => {
    expect(
      createReplyCommandSchema.safeParse({
        annotationId: ANNOTATION_ID,
        body: "a".repeat(MAX_BODY_BYTES + 1),
      }).success,
    ).toBe(false);
    expect(
      createReplyCommandSchema.safeParse({ annotationId: ANNOTATION_ID, body: "" }).success,
    ).toBe(false);
  });

  it("rejects a non-UUIDv7 annotation or parent id", () => {
    expect(
      createReplyCommandSchema.safeParse({ annotationId: UUID_V4, body: "x" }).success,
    ).toBe(false);
    expect(
      createReplyCommandSchema.safeParse({
        annotationId: ANNOTATION_ID,
        parentReplyId: "not-a-uuid",
        body: "x",
      }).success,
    ).toBe(false);
  });
});

describe("mintAgentTokenCommandSchema", () => {
  const valid = { name: "review-bot", scopes: ["chapters:read", "annotations:write"] };

  it("accepts a valid mint command and defaults expiry to 30 days", () => {
    const result = mintAgentTokenCommandSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.expiresInDays).toBe(30);
    }
  });

  it("accepts explicit expiry within 1..90 days", () => {
    expect(mintAgentTokenCommandSchema.safeParse({ ...valid, expiresInDays: 1 }).success).toBe(true);
    expect(mintAgentTokenCommandSchema.safeParse({ ...valid, expiresInDays: 90 }).success).toBe(true);
  });

  it("rejects expiry outside the bound or fractional", () => {
    expect(mintAgentTokenCommandSchema.safeParse({ ...valid, expiresInDays: 0 }).success).toBe(false);
    expect(mintAgentTokenCommandSchema.safeParse({ ...valid, expiresInDays: 91 }).success).toBe(false);
    expect(mintAgentTokenCommandSchema.safeParse({ ...valid, expiresInDays: 2.5 }).success).toBe(false);
  });

  it("rejects unknown scopes (scopes ⊆ known scopes)", () => {
    expect(
      mintAgentTokenCommandSchema.safeParse({ ...valid, scopes: ["votes:write"] }).success,
    ).toBe(false);
    expect(
      mintAgentTokenCommandSchema.safeParse({ ...valid, scopes: ["chapters:read", "admin"] })
        .success,
    ).toBe(false);
  });

  it("rejects empty and duplicate scope lists", () => {
    expect(mintAgentTokenCommandSchema.safeParse({ ...valid, scopes: [] }).success).toBe(false);
    expect(
      mintAgentTokenCommandSchema.safeParse({
        ...valid,
        scopes: ["chapters:read", "chapters:read"],
      }).success,
    ).toBe(false);
  });

  it("rejects an empty or over-long name", () => {
    expect(mintAgentTokenCommandSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
    expect(
      mintAgentTokenCommandSchema.safeParse({ ...valid, name: "n".repeat(101) }).success,
    ).toBe(false);
  });

  it("rejects unknown extra fields", () => {
    expect(
      mintAgentTokenCommandSchema.safeParse({ ...valid, token: "authorbot_x" }).success,
    ).toBe(false);
  });
});

describe("withdrawAnnotationCommandSchema", () => {
  it("accepts a UUIDv7 annotation id", () => {
    expect(
      withdrawAnnotationCommandSchema.safeParse({ annotationId: ANNOTATION_ID }).success,
    ).toBe(true);
  });

  it("rejects missing, malformed, or extra fields", () => {
    expect(withdrawAnnotationCommandSchema.safeParse({}).success).toBe(false);
    expect(
      withdrawAnnotationCommandSchema.safeParse({ annotationId: UUID_V4 }).success,
    ).toBe(false);
    expect(
      withdrawAnnotationCommandSchema.safeParse({ annotationId: ANNOTATION_ID, force: true })
        .success,
    ).toBe(false);
  });
});
