import path from "node:path";
import { fileURLToPath } from "node:url";
import { validFixturesRoot } from "@authorbot/test-fixtures";
import { describe, expect, it } from "vitest";
import { validateBookRepo } from "../src/index.js";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));

const repos: ReadonlyArray<readonly [string, string]> = [
  ["examples/book-repo", path.join(workspaceRoot, "examples", "book-repo")],
  ["templates/book-repo", path.join(workspaceRoot, "templates", "book-repo")],
  ["fixtures/valid/minimal", path.join(validFixturesRoot, "minimal")],
];

describe("valid repositories validate with zero errors", () => {
  for (const [name, dir] of repos) {
    it(name, async () => {
      const report = await validateBookRepo(dir);
      expect(report.errors).toEqual([]);
      expect(report.valid).toBe(true);
    });
  }

  it("examples warnings are only unresolved location:* references (Phase 0 rule)", async () => {
    const examples = repos[0];
    if (examples === undefined) {
      throw new Error("missing examples repo entry");
    }
    const report = await validateBookRepo(examples[1]);
    for (const warning of report.warnings) {
      expect(warning.code).toBe("TIMELINE_REF_UNRESOLVED");
      expect(warning.message).toContain("location:");
    }
  });
});
