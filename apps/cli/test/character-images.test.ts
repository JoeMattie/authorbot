import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validFixturesRoot } from "@authorbot/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { validateBookRepo, type ValidationReport } from "../src/index.js";

/**
 * Character `image` validation (0.1.50): the path must be a safe
 * repo-relative path under `public/`, and a named-but-absent image is a
 * warning (the build skips it until the binary lands). Mirrors the
 * `publication.cover_images` ladder.
 */

const tempDirs: string[] = [];

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "authorbot-character-images-"));
  tempDirs.push(dir);
  await cp(path.join(validFixturesRoot, "minimal"), dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function withCharacter(root: string, image: string): Promise<void> {
  await mkdir(path.join(root, "story", "characters"), { recursive: true });
  await writeFile(
    path.join(root, "story", "characters", "mara.md"),
    [
      "---",
      "schema: authorbot.character/v1",
      "id: character:mara",
      "name: Mara Voss",
      `image: ${image}`,
      "---",
      "",
      "Body.",
      "",
    ].join("\n"),
  );
}

const codesOf = (findings: ValidationReport["errors"]): string[] =>
  findings.map((finding) => finding.code);

describe("character image validation", () => {
  it("accepts an existing image under public/", async () => {
    const repo = await makeRepo();
    await withCharacter(repo, "public/characters/mara.png");
    await mkdir(path.join(repo, "public", "characters"), { recursive: true });
    await writeFile(path.join(repo, "public", "characters", "mara.png"), "png");
    const report = await validateBookRepo(repo);
    expect(report.valid).toBe(true);
    expect(report.warnings).toEqual([]);
  });

  it("rejects a traversal path", async () => {
    const repo = await makeRepo();
    await withCharacter(repo, "public/../secrets.png");
    const report = await validateBookRepo(repo);
    expect(report.valid).toBe(false);
    const finding = report.errors.find((entry) => entry.code === "PATH_UNSAFE");
    expect(finding?.message).toContain("contains path traversal");
    expect(finding?.path).toBe("story/characters/mara.md");
    expect(finding?.pointer).toBe("/image");
  });

  it("rejects an absolute path", async () => {
    const repo = await makeRepo();
    await withCharacter(repo, "/etc/passwd");
    const report = await validateBookRepo(repo);
    expect(report.valid).toBe(false);
    expect(codesOf(report.errors)).toContain("PATH_UNSAFE");
  });

  it("rejects an image outside public/", async () => {
    const repo = await makeRepo();
    await withCharacter(repo, "assets/mara.png");
    const report = await validateBookRepo(repo);
    expect(report.valid).toBe(false);
    const finding = report.errors.find((entry) => entry.code === "CHARACTER_FILE_INVALID");
    expect(finding?.message).toContain("must live under public/");
    expect(finding?.pointer).toBe("/image");
  });

  it("warns about a named image that does not exist yet", async () => {
    const repo = await makeRepo();
    await withCharacter(repo, "public/characters/pending.png");
    const report = await validateBookRepo(repo);
    expect(report.valid).toBe(true);
    const warning = report.warnings.find((entry) => entry.code === "CHARACTER_FILE_INVALID");
    expect(warning?.message).toContain("does not exist yet");
  });
});
