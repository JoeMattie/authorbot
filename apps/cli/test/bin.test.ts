import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invalidFixturesRoot } from "@authorbot/test-fixtures";
import { describe, expect, it } from "vitest";
import type { Finding } from "../src/index.js";

const binPath = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));

interface JsonReport {
  valid: boolean;
  errors: Finding[];
  warnings: Finding[];
}

function runBin(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [binPath, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("authorbot bin (built dist)", () => {
  it("covers exit codes 0, 1, 2 and the --json shape", () => {
    if (!existsSync(binPath)) {
      throw new Error(
        "dist/bin.js is missing; run `pnpm --filter @authorbot/cli build` before testing",
      );
    }

    // Exit 0: valid repo, --json shape.
    const ok = runBin(["validate", path.join(workspaceRoot, "examples", "book-repo"), "--json"]);
    expect(ok.status).toBe(0);
    const okReport = JSON.parse(ok.stdout) as JsonReport;
    expect(okReport.valid).toBe(true);
    expect(okReport.errors).toEqual([]);
    expect(Array.isArray(okReport.warnings)).toBe(true);

    // Exit 1: invalid fixture, error findings carry the contract shape.
    const bad = runBin(["validate", path.join(invalidFixturesRoot, "missing-book-yml"), "--json"]);
    expect(bad.status).toBe(1);
    const badReport = JSON.parse(bad.stdout) as JsonReport;
    expect(badReport.valid).toBe(false);
    expect(badReport.errors.map((finding) => finding.code)).toContain("BOOK_CONFIG_MISSING");
    for (const finding of badReport.errors) {
      expect(finding.severity).toBe("error");
      expect(typeof finding.path).toBe("string");
      expect(typeof finding.message).toBe("string");
    }

    // Exit 2: usage / I/O error.
    const missing = runBin(["validate", path.join(workspaceRoot, "no-such-repo")]);
    expect(missing.status).toBe(2);
    const usage = runBin([]);
    expect(usage.status).toBe(2);
  });

  it("resolves relative paths against the process cwd, ignoring INIT_CWD", () => {
    // pnpm/npm export INIT_CWD to every nested process; honoring it would
    // resolve relative paths against the wrong base (or silently validate a
    // wrong same-named repository) when a script cds before running the CLI.
    const result = spawnSync(
      process.execPath,
      [binPath, "validate", path.join("examples", "book-repo")],
      {
        encoding: "utf8",
        cwd: workspaceRoot,
        env: { ...process.env, INIT_CWD: "/nonexistent" },
      },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("exposes `upgrade` as a real command", () => {
    // templates/book-repo/package.json ships `"upgrade": "authorbot upgrade"`,
    // so this being wired up is the difference between a script that works
    // and one that errors in an author's terminal.
    const top = runBin(["--help"]);
    expect(top.status).toBe(0);
    expect(top.stdout).toContain("upgrade [path]");

    const help = runBin(["upgrade", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--dry-run");
    expect(help.stdout).toContain("Exit codes (--check)");

    expect(runBin(["upgrade", "--nope"]).status).toBe(2);
    expect(runBin(["upgrade", "a", "b"]).status).toBe(2);

    // A directory with no package.json is rejected before anything reaches
    // the network, so this stays offline.
    const notABook = runBin(["upgrade", workspaceRoot, "--check"]);
    expect(notABook.status).toBe(2);
    expect(notABook.stderr).toContain("does not depend on @authorbot/cli");
  });
});
