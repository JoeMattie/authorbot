import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_ERRORS_FILENAME,
  VALIDATION_ERROR_CODES,
  listInvalidFixtures,
  listValidFixtures,
} from "../src/index.js";

describe("valid fixtures", () => {
  it("include a minimal repository with a book.yml", async () => {
    const fixtures = await listValidFixtures();
    const names = fixtures.map((f) => f.name);
    expect(names).toContain("minimal");
    const minimal = fixtures.find((f) => f.name === "minimal");
    expect(minimal).toBeDefined();
    await expect(
      access(path.join(minimal!.dir, "book.yml")),
    ).resolves.toBeUndefined();
  });
});

describe("invalid fixtures", () => {
  it("exist and each declares parseable expected errors", async () => {
    const fixtures = await listInvalidFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(22);
    for (const fixture of fixtures) {
      expect(fixture.expectedErrors.length).toBeGreaterThanOrEqual(1);
      for (const code of fixture.expectedErrors) {
        expect(VALIDATION_ERROR_CODES).toContain(code);
      }
    }
  });

  it("each contain repository content beyond the expectation file", async () => {
    const fixtures = await listInvalidFixtures();
    for (const fixture of fixtures) {
      const entries = await readdir(fixture.dir);
      const repoEntries = entries.filter(
        (entry) => entry !== EXPECTED_ERRORS_FILENAME,
      );
      expect(repoEntries.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("have unique names", async () => {
    const fixtures = await listInvalidFixtures();
    const names = fixtures.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("cover every contract section 5 error code (no code without a fixture)", async () => {
    // The invalid fixture suite is the end-to-end guard that the validator
    // still emits each stable code; a code claimed by no fixture would let a
    // regression in its emission path ship silently. There is currently no
    // intentionally test-only code; document any future exclusion here.
    const fixtures = await listInvalidFixtures();
    const covered = new Set(fixtures.flatMap((f) => [...f.expectedErrors]));
    const uncovered = VALIDATION_ERROR_CODES.filter((code) => !covered.has(code));
    expect(uncovered).toEqual([]);
  });
});
