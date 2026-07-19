import { describe, it } from "vitest";
import { bookConfigSchema } from "../src/index.js";
import { clone, expectInvalid, expectValid } from "./helpers.js";
import { BAD_UUID_V4, UUIDS, validBook } from "./samples.js";

describe("bookConfigSchema", () => {
  it("accepts the design 8.2 example", () => {
    expectValid(bookConfigSchema, validBook);
  });

  it("accepts a minimal config", () => {
    expectValid(bookConfigSchema, {
      schema: "authorbot.book/v1",
      id: UUIDS.book,
      title: "Example Serial",
      slug: "example-serial",
      language: "en",
    });
  });

  it("rejects a wrong schema discriminator", () => {
    const bad = clone(validBook);
    bad.schema = "authorbot.book/v2";
    expectInvalid(bookConfigSchema, bad);
  });

  it("rejects a missing title", () => {
    const bad = clone(validBook);
    delete bad.title;
    expectInvalid(bookConfigSchema, bad);
  });

  it("rejects an unknown top-level key", () => {
    const bad = clone(validBook);
    bad.github_app_secret = "nope";
    expectInvalid(bookConfigSchema, bad);
  });

  it("rejects an unknown nested key", () => {
    const bad = clone(validBook);
    bad.content.allow_scripts = true;
    expectInvalid(bookConfigSchema, bad);
  });

  it("rejects a UUIDv4 id", () => {
    const bad = clone(validBook);
    bad.id = BAD_UUID_V4;
    expectInvalid(bookConfigSchema, bad);
  });

  it("rejects a bad slug", () => {
    const bad = clone(validBook);
    bad.slug = "Example Serial";
    expectInvalid(bookConfigSchema, bad);
  });

  it("rejects a bad language tag", () => {
    const bad = clone(validBook);
    bad.language = "english (US)";
    expectInvalid(bookConfigSchema, bad);
  });

  it("rejects a non-boolean raw_html", () => {
    const bad = clone(validBook);
    bad.content.raw_html = "false";
    expectInvalid(bookConfigSchema, bad);
  });
});
