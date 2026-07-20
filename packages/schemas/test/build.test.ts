import { describe, it } from "vitest";
import { buildManifestSchema } from "../src/index.js";
import { clone, expectInvalid, expectValid } from "./helpers.js";
import { BAD_UUID_V4, validBuildManifest } from "./samples.js";

describe("buildManifestSchema", () => {
  it("accepts a build manifest", () => {
    expectValid(buildManifestSchema, validBuildManifest);
  });

  it("accepts a null commit (build outside a git work tree)", () => {
    const manifest = clone(validBuildManifest);
    manifest.commit = null;
    expectValid(buildManifestSchema, manifest);
  });

  it("accepts a manifest without base_url", () => {
    const manifest = clone(validBuildManifest);
    delete manifest.base_url;
    expectValid(buildManifestSchema, manifest);
  });

  it("accepts an empty chapter list", () => {
    const manifest = clone(validBuildManifest);
    manifest.chapters = [];
    expectValid(buildManifestSchema, manifest);
  });

  it("accepts draft chapters (an --include-drafts build)", () => {
    const manifest = clone(validBuildManifest);
    manifest.chapters[0].status = "draft";
    expectValid(buildManifestSchema, manifest);
  });

  it("rejects a missing commit field", () => {
    const bad = clone(validBuildManifest);
    delete bad.commit;
    expectInvalid(buildManifestSchema, bad);
  });

  it("rejects a non-hex commit", () => {
    const bad = clone(validBuildManifest);
    bad.commit = "not-a-sha";
    expectInvalid(buildManifestSchema, bad);
  });

  it("rejects a bad built_at", () => {
    const bad = clone(validBuildManifest);
    bad.built_at = "yesterday";
    expectInvalid(buildManifestSchema, bad);
  });

  it("rejects an empty publisher_version", () => {
    const bad = clone(validBuildManifest);
    bad.publisher_version = "";
    expectInvalid(buildManifestSchema, bad);
  });

  it("rejects a wrong schema discriminator", () => {
    const bad = clone(validBuildManifest);
    bad.schema = "authorbot.release/v1";
    expectInvalid(buildManifestSchema, bad);
  });

  it("rejects a UUIDv4 chapter id", () => {
    const bad = clone(validBuildManifest);
    bad.chapters[0].id = BAD_UUID_V4;
    expectInvalid(buildManifestSchema, bad);
  });

  it("rejects chapter revision 0", () => {
    const bad = clone(validBuildManifest);
    bad.chapters[0].revision = 0;
    expectInvalid(buildManifestSchema, bad);
  });

  it("rejects an unknown chapter status", () => {
    const bad = clone(validBuildManifest);
    bad.chapters[0].status = "retired";
    expectInvalid(buildManifestSchema, bad);
  });

  it("rejects an unknown key", () => {
    const bad = clone(validBuildManifest);
    bad.deployed_url = "https://example.org/";
    expectInvalid(buildManifestSchema, bad);
  });

  it("rejects an unknown chapter entry key", () => {
    const bad = clone(validBuildManifest);
    bad.chapters[0].href = "/chapters/the-window/";
    expectInvalid(buildManifestSchema, bad);
  });
});
