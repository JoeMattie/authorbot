import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validFixturesRoot } from "@authorbot/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { validateBookRepo, type ValidationReport } from "../src/index.js";

/**
 * `publication.cover_images` validation (0.1.49): entries must be safe
 * repo-relative paths under `public/`, a configured-but-absent image is a
 * warning (the binary may land later), and a `public/` entry shadowing a
 * generated output path is warned about.
 */

const tempDirs: string[] = [];

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "authorbot-covers-"));
  tempDirs.push(dir);
  await cp(path.join(validFixturesRoot, "minimal"), dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function withCovers(root: string, entries: string[]): Promise<void> {
  await appendFile(
    path.join(root, "book.yml"),
    ["publication:", "  cover_images:", ...entries.map((entry) => `    - ${entry}`), ""].join(
      "\n",
    ),
  );
}

const codesOf = (findings: ValidationReport["errors"]): string[] =>
  findings.map((finding) => finding.code);

describe("publication.cover_images validation", () => {
  it("accepts an existing cover under public/", async () => {
    const repo = await makeRepo();
    await withCovers(repo, ["public/covers/one.png"]);
    await mkdir(path.join(repo, "public", "covers"), { recursive: true });
    await writeFile(path.join(repo, "public", "covers", "one.png"), "png");
    const report = await validateBookRepo(repo);
    expect(report.valid).toBe(true);
    expect(report.warnings).toEqual([]);
  });

  it("rejects a traversal path", async () => {
    const repo = await makeRepo();
    await withCovers(repo, ["public/../secrets.png"]);
    const report = await validateBookRepo(repo);
    expect(report.valid).toBe(false);
    expect(codesOf(report.errors)).toContain("PATH_UNSAFE");
  });

  it("rejects a cover outside public/", async () => {
    const repo = await makeRepo();
    await withCovers(repo, ["assets/cover.png"]);
    const report = await validateBookRepo(repo);
    expect(report.valid).toBe(false);
    const finding = report.errors.find((entry) => entry.code === "BOOK_CONFIG_INVALID");
    expect(finding?.message).toContain("must live under public/");
    expect(finding?.pointer).toBe("/publication/cover_images/0");
  });

  it("warns about a configured cover that does not exist yet", async () => {
    const repo = await makeRepo();
    await withCovers(repo, ["public/covers/pending.png"]);
    const report = await validateBookRepo(repo);
    expect(report.valid).toBe(true);
    const warning = report.warnings.find((entry) => entry.code === "BOOK_CONFIG_INVALID");
    expect(warning?.message).toContain("does not exist yet");
  });

  it("warns when public/ shadows a generated output path", async () => {
    const repo = await makeRepo();
    await mkdir(path.join(repo, "public", "story"), { recursive: true });
    await writeFile(path.join(repo, "public", "story", "index.html"), "shadow");
    const report = await validateBookRepo(repo);
    expect(report.valid).toBe(true);
    const warning = report.warnings.find((entry) => entry.code === "PATH_UNSAFE");
    expect(warning?.message).toContain("may shadow built pages");
  });
});
