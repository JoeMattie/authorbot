import { listInvalidFixtures } from "@authorbot/test-fixtures";
import { describe, expect, it } from "vitest";
import { validateBookRepo } from "../src/index.js";

const fixtures = await listInvalidFixtures();

describe("invalid fixtures fail with their documented codes", () => {
  it("enumerates the invalid fixture set", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(22);
  });

  for (const fixture of fixtures) {
    it(`${fixture.name} -> ${fixture.expectedErrors.join(", ")}`, async () => {
      const report = await validateBookRepo(fixture.dir);
      expect(report.valid).toBe(false);
      expect(report.errors.length).toBeGreaterThan(0);
      const codes = [...new Set(report.errors.map((finding) => finding.code))];
      for (const code of fixture.expectedErrors) {
        expect(codes).toContain(code);
      }
      for (const finding of report.errors) {
        expect(finding.severity).toBe("error");
        expect(finding.path.length).toBeGreaterThan(0);
        expect(finding.message.length).toBeGreaterThan(0);
      }
    });
  }
});
