import { describe, it } from "vitest";
import { releaseSchema } from "../src/index.js";
import { clone, expectInvalid, expectValid } from "./helpers.js";
import { BAD_UUID_V4, validRelease } from "./samples.js";

describe("releaseSchema", () => {
  it("accepts a release manifest", () => {
    expectValid(releaseSchema, validRelease);
  });

  it("accepts a release without notes", () => {
    const minimal = clone(validRelease);
    delete minimal.notes;
    expectValid(releaseSchema, minimal);
  });

  it("rejects empty chapters", () => {
    const bad = clone(validRelease);
    bad.chapters = [];
    expectInvalid(releaseSchema, bad);
  });

  it("rejects chapter revision 0", () => {
    const bad = clone(validRelease);
    bad.chapters[0].revision = 0;
    expectInvalid(releaseSchema, bad);
  });

  it("rejects a UUIDv4 release id", () => {
    const bad = clone(validRelease);
    bad.id = BAD_UUID_V4;
    expectInvalid(releaseSchema, bad);
  });

  it("rejects a bad created_at", () => {
    const bad = clone(validRelease);
    bad.created_at = "July 19, 2026";
    expectInvalid(releaseSchema, bad);
  });

  it("rejects an unknown key", () => {
    const bad = clone(validRelease);
    bad.tag = "v1.0.0";
    expectInvalid(releaseSchema, bad);
  });

  it("rejects an unknown chapter entry key", () => {
    const bad = clone(validRelease);
    bad.chapters[0].title = "Opening";
    expectInvalid(releaseSchema, bad);
  });
});
