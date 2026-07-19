import { describe, it } from "vitest";
import { attributionSchema } from "../src/index.js";
import { clone, expectInvalid, expectValid } from "./helpers.js";
import { BAD_UUID_V4, validAttribution } from "./samples.js";

describe("attributionSchema", () => {
  it("accepts a full attribution record", () => {
    expectValid(attributionSchema, validAttribution);
  });

  it("accepts an entry without work_item_id or commit", () => {
    const minimal = clone(validAttribution);
    minimal.entries = [{ revision: 1, actor: "github:octocat" }];
    expectValid(attributionSchema, minimal);
  });

  it("rejects empty entries", () => {
    const bad = clone(validAttribution);
    bad.entries = [];
    expectInvalid(attributionSchema, bad);
  });

  it("rejects an entry without an actor", () => {
    const bad = clone(validAttribution);
    delete bad.entries[0].actor;
    expectInvalid(attributionSchema, bad);
  });

  it("rejects a non-hex commit", () => {
    const bad = clone(validAttribution);
    bad.entries[0].commit = "not-a-sha-zzzz";
    expectInvalid(attributionSchema, bad);
  });

  it("rejects revision 0", () => {
    const bad = clone(validAttribution);
    bad.entries[0].revision = 0;
    expectInvalid(attributionSchema, bad);
  });

  it("rejects a UUIDv4 chapter_id", () => {
    const bad = clone(validAttribution);
    bad.chapter_id = BAD_UUID_V4;
    expectInvalid(attributionSchema, bad);
  });

  it("rejects an unknown entry key", () => {
    const bad = clone(validAttribution);
    bad.entries[0].email = "octocat@example.com";
    expectInvalid(attributionSchema, bad);
  });
});
