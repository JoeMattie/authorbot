import { describe, it } from "vitest";
import { annotationSchema, replySchema } from "../src/index.js";
import { clone, expectInvalid, expectValid } from "./helpers.js";
import {
  BAD_UUID_V4,
  validBlockAnnotation,
  validChapterAnnotation,
  validRangeAnnotation,
  validReply,
} from "./samples.js";

describe("annotationSchema", () => {
  it("accepts a range annotation with the design 10.1 selector", () => {
    expectValid(annotationSchema, validRangeAnnotation);
  });

  it("accepts a block annotation", () => {
    expectValid(annotationSchema, validBlockAnnotation);
  });

  it("accepts a chapter annotation without a target", () => {
    expectValid(annotationSchema, validChapterAnnotation);
  });

  it("rejects a chapter annotation carrying a target", () => {
    const bad = clone(validChapterAnnotation);
    bad.target = { blockId: validBlockAnnotation.target.blockId };
    expectInvalid(annotationSchema, bad);
  });

  it("rejects a range annotation without a target", () => {
    const bad = clone(validRangeAnnotation);
    delete bad.target;
    expectInvalid(annotationSchema, bad);
  });

  it("rejects a range target without textQuote", () => {
    const bad = clone(validRangeAnnotation);
    delete bad.target.textQuote;
    expectInvalid(annotationSchema, bad);
  });

  it("rejects snake_case selector keys", () => {
    const bad = clone(validRangeAnnotation);
    bad.target = {
      block_id: bad.target.blockId,
      text_position: bad.target.textPosition,
      text_quote: bad.target.textQuote,
    };
    expectInvalid(annotationSchema, bad);
  });

  it("rejects a block target with extra selector fields", () => {
    const bad = clone(validBlockAnnotation);
    bad.target.textPosition = { start: 0, end: 10 };
    expectInvalid(annotationSchema, bad);
  });

  it("rejects an unknown scope", () => {
    const bad = clone(validRangeAnnotation);
    bad.scope = "paragraph";
    expectInvalid(annotationSchema, bad);
  });

  it("rejects an unknown kind", () => {
    const bad = clone(validRangeAnnotation);
    bad.kind = "complaint";
    expectInvalid(annotationSchema, bad);
  });

  it("rejects an unknown status", () => {
    const bad = clone(validRangeAnnotation);
    bad.status = "pending";
    expectInvalid(annotationSchema, bad);
  });

  it("rejects a UUIDv4 id", () => {
    const bad = clone(validRangeAnnotation);
    bad.id = BAD_UUID_V4;
    expectInvalid(annotationSchema, bad);
  });

  it("rejects a UUIDv4 blockId", () => {
    const bad = clone(validRangeAnnotation);
    bad.target.blockId = BAD_UUID_V4;
    expectInvalid(annotationSchema, bad);
  });

  it("rejects chapter_revision 0", () => {
    const bad = clone(validRangeAnnotation);
    bad.chapter_revision = 0;
    expectInvalid(annotationSchema, bad);
  });

  it("rejects a negative textPosition start", () => {
    const bad = clone(validRangeAnnotation);
    bad.target.textPosition.start = -1;
    expectInvalid(annotationSchema, bad);
  });

  it("rejects a bad created_at", () => {
    const bad = clone(validRangeAnnotation);
    bad.created_at = "yesterday";
    expectInvalid(annotationSchema, bad);
  });

  it("rejects an unknown key", () => {
    const bad = clone(validRangeAnnotation);
    bad.votes = 3;
    expectInvalid(annotationSchema, bad);
  });
});

describe("replySchema", () => {
  it("accepts a minimal reply", () => {
    expectValid(replySchema, validReply);
  });

  it("accepts a threaded reply with timestamps", () => {
    const threaded = clone(validReply);
    threaded.parent_reply_id = validReply.id;
    threaded.updated_at = "2026-07-19T18:11:00Z";
    expectValid(replySchema, threaded);
  });

  it("rejects a missing annotation_id", () => {
    const bad = clone(validReply);
    delete bad.annotation_id;
    expectInvalid(replySchema, bad);
  });

  it("rejects a UUIDv4 id", () => {
    const bad = clone(validReply);
    bad.id = BAD_UUID_V4;
    expectInvalid(replySchema, bad);
  });

  it("rejects a bad author namespace", () => {
    const bad = clone(validReply);
    bad.author = "email:someone@example.com";
    expectInvalid(replySchema, bad);
  });

  it("rejects an unknown key", () => {
    const bad = clone(validReply);
    bad.body = "inline body not allowed";
    expectInvalid(replySchema, bad);
  });

  it("rejects a wrong schema discriminator", () => {
    const bad = clone(validReply);
    bad.schema = "authorbot.annotation/v1";
    expectInvalid(replySchema, bad);
  });
});
