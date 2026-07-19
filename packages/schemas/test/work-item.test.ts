import { describe, it } from "vitest";
import { workItemSchema } from "../src/index.js";
import { clone, expectInvalid, expectValid } from "./helpers.js";
import { BAD_UUID_V4, validWorkItem } from "./samples.js";

describe("workItemSchema", () => {
  it("accepts the design 13 example frontmatter", () => {
    expectValid(workItemSchema, validWorkItem);
  });

  it("accepts a planning item without chapter references", () => {
    const planning = clone(validWorkItem);
    planning.type = "planning";
    delete planning.source_annotation_id;
    delete planning.chapter_id;
    delete planning.base_revision;
    expectValid(workItemSchema, planning);
  });

  it("rejects an unknown type", () => {
    const bad = clone(validWorkItem);
    bad.type = "rewrite_book";
    expectInvalid(workItemSchema, bad);
  });

  it("rejects an unknown status", () => {
    const bad = clone(validWorkItem);
    bad.status = "in_progress";
    expectInvalid(workItemSchema, bad);
  });

  it("rejects an unknown priority", () => {
    const bad = clone(validWorkItem);
    bad.priority = "urgent";
    expectInvalid(workItemSchema, bad);
  });

  it("rejects a missing created_by", () => {
    const bad = clone(validWorkItem);
    delete bad.created_by;
    expectInvalid(workItemSchema, bad);
  });

  it("rejects lease material in frontmatter", () => {
    const bad = clone(validWorkItem);
    bad.lease_token = "secret";
    expectInvalid(workItemSchema, bad);
  });

  it("rejects a UUIDv4 id", () => {
    const bad = clone(validWorkItem);
    bad.id = BAD_UUID_V4;
    expectInvalid(workItemSchema, bad);
  });

  it("rejects base_revision 0", () => {
    const bad = clone(validWorkItem);
    bad.base_revision = 0;
    expectInvalid(workItemSchema, bad);
  });

  it("rejects a bad created_at", () => {
    const bad = clone(validWorkItem);
    bad.created_at = "2026-07-19";
    expectInvalid(workItemSchema, bad);
  });
});
