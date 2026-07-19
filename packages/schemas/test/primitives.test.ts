import { describe, it } from "vitest";
import {
  actorRefSchema,
  isoDurationSchema,
  nodeIdOf,
  nodeIdSchema,
  slugSchema,
  timestampSchema,
  uuidv7Schema,
} from "../src/index.js";
import { expectInvalid, expectValid } from "./helpers.js";
import { BAD_UUID_V4, UUIDS } from "./samples.js";

describe("uuidv7Schema", () => {
  it("accepts a lowercase UUIDv7", () => {
    expectValid(uuidv7Schema, UUIDS.book);
  });
  it("rejects a UUIDv4 (wrong version nibble)", () => {
    expectInvalid(uuidv7Schema, BAD_UUID_V4);
  });
  it("rejects uppercase", () => {
    expectInvalid(uuidv7Schema, UUIDS.book.toUpperCase());
  });
  it("rejects a bad variant nibble", () => {
    expectInvalid(uuidv7Schema, "0190f27c-6e65-7ca5-c596-9f093d577aba");
  });
  it("rejects a non-uuid string", () => {
    expectInvalid(uuidv7Schema, "not-a-uuid");
  });
});

describe("nodeIdSchema", () => {
  it("accepts every known kind", () => {
    for (const id of ["premise:main", "arc:one", "part:one", "chapter:opening", "scene:x1", "beat:midpoint", "event:first-contact", "character:protagonist", "location:main-lab", "concept:causal-projector", "rule:no-retcons"]) {
      expectValid(nodeIdSchema, id);
    }
  });
  it("rejects an unknown kind", () => {
    expectInvalid(nodeIdSchema, "volume:one");
  });
  it("rejects an uppercase slug", () => {
    expectInvalid(nodeIdSchema, "event:First-Contact");
  });
  it("rejects a slug starting with a hyphen", () => {
    expectInvalid(nodeIdSchema, "event:-bad");
  });
  it("rejects a missing slug", () => {
    expectInvalid(nodeIdSchema, "event:");
  });
});

describe("nodeIdOf", () => {
  it("accepts only the requested kind", () => {
    expectValid(nodeIdOf("character"), "character:protagonist");
    expectInvalid(nodeIdOf("character"), "event:first-contact");
  });
});

describe("actorRefSchema", () => {
  it("accepts known namespaces", () => {
    expectValid(actorRefSchema, "github:octocat");
    expectValid(actorRefSchema, "agent:reviewer-1");
    expectValid(actorRefSchema, "system:rule-engine");
  });
  it("rejects an unknown namespace", () => {
    expectInvalid(actorRefSchema, "twitter:someone");
  });
  it("rejects an empty identifier", () => {
    expectInvalid(actorRefSchema, "github:");
  });
  it("rejects whitespace in the identifier", () => {
    expectInvalid(actorRefSchema, "github:octo cat");
  });
});

describe("slugSchema", () => {
  it("accepts a simple slug", () => {
    expectValid(slugSchema, "example-serial");
  });
  it("rejects path separators", () => {
    expectInvalid(slugSchema, "a/b");
  });
  it("rejects leading dots", () => {
    expectInvalid(slugSchema, "..");
  });
  it("rejects uppercase", () => {
    expectInvalid(slugSchema, "Bad");
  });
  it("rejects a leading hyphen", () => {
    expectInvalid(slugSchema, "-bad");
  });
});

describe("timestampSchema", () => {
  it("accepts RFC 3339 UTC", () => {
    expectValid(timestampSchema, "2026-07-19T18:00:00Z");
    expectValid(timestampSchema, "2026-07-19T18:00:00.123Z");
  });
  it("rejects a numeric offset", () => {
    expectInvalid(timestampSchema, "2026-07-19T18:00:00+02:00");
  });
  it("rejects a missing Z", () => {
    expectInvalid(timestampSchema, "2026-07-19T18:00:00");
  });
  it("rejects a space separator", () => {
    expectInvalid(timestampSchema, "2026-07-19 18:00:00Z");
  });
  it("rejects month 13", () => {
    expectInvalid(timestampSchema, "2026-13-01T00:00:00Z");
  });
  it("rejects hour 24", () => {
    expectInvalid(timestampSchema, "2026-07-19T24:00:00Z");
  });
  it("rejects missing seconds", () => {
    expectInvalid(timestampSchema, "2026-07-19T18:00Z");
  });
  it("rejects calendar-invalid day-of-month overflow", () => {
    expectInvalid(timestampSchema, "2026-02-30T12:00:00Z");
    expectInvalid(timestampSchema, "2026-04-31T12:00:00Z");
    expectInvalid(timestampSchema, "2026-06-31T12:00:00Z");
  });
  it("rejects february 29 outside leap years, accepts it in leap years", () => {
    expectInvalid(timestampSchema, "2025-02-29T12:00:00Z");
    expectInvalid(timestampSchema, "2100-02-29T12:00:00Z"); // century non-leap
    expectValid(timestampSchema, "2024-02-29T12:00:00Z");
    expectValid(timestampSchema, "2000-02-29T12:00:00Z"); // 400-year leap
  });
  it("accepts a leap second only at 23:59:60Z", () => {
    expectValid(timestampSchema, "2026-12-31T23:59:60Z");
    expectInvalid(timestampSchema, "2026-07-19T18:00:60Z");
    expectInvalid(timestampSchema, "2026-07-19T23:58:60Z");
  });
});

describe("isoDurationSchema", () => {
  it("accepts common durations", () => {
    expectValid(isoDurationSchema, "PT30M");
    expectValid(isoDurationSchema, "PT4H");
    expectValid(isoDurationSchema, "P1D");
  });
  it("rejects a bare P or PT", () => {
    expectInvalid(isoDurationSchema, "P");
    expectInvalid(isoDurationSchema, "PT");
  });
  it("rejects a missing designator", () => {
    expectInvalid(isoDurationSchema, "30M");
    expectInvalid(isoDurationSchema, "PT30");
  });
});
