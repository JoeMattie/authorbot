import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invalidFixturesRoot } from "@authorbot/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";

const binPath = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const exampleRepo = path.join(workspaceRoot, "examples", "book-repo");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeOutDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "authorbot-cli-build-"));
  tempDirs.push(dir);
  return dir;
}

function runBin(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    cwd: workspaceRoot,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("authorbot build (built dist)", () => {
  it("handles usage errors with exit code 2", () => {
    if (!existsSync(binPath)) {
      throw new Error(
        "dist/bin.js is missing; run `pnpm --filter @authorbot/cli build` before testing",
      );
    }
    expect(runBin(["build"]).status).toBe(2);
    expect(runBin(["build", "a", "b"]).status).toBe(2);
    expect(runBin(["build", exampleRepo, "--nope"]).status).toBe(2);
    expect(runBin(["build", path.join(workspaceRoot, "no-such-repo")]).status).toBe(2);
    const help = runBin(["build", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--include-drafts");
    expect(help.stdout).toContain("--api-url");
    expect(runBin(["build", exampleRepo, "--api-url"]).status).toBe(2);
  });

  it("refuses to build an invalid repository unless --force", async () => {
    const out = await makeOutDir();
    const outTarget = path.join(out, "site");
    const refused = runBin([
      "build",
      path.join(invalidFixturesRoot, "raw-html-forbidden"),
      "--out",
      outTarget,
    ]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("build refused");
    expect(existsSync(path.join(outTarget, "index.html"))).toBe(false);
  });

  it(
    "builds the example repo: pages, manifest, and draft exclusion",
    { timeout: 240_000 },
    async () => {
      const out = await makeOutDir();
      const result = runBin(["build", exampleRepo, "--out", out]);
      expect(result.status, result.stderr).toBe(0);

      expect(existsSync(path.join(out, "index.html"))).toBe(true);
      expect(existsSync(path.join(out, "chapters", "baseline", "index.html"))).toBe(true);
      expect(existsSync(path.join(out, "chapters", "null-results", "index.html"))).toBe(
        true,
      );
      expect(existsSync(path.join(out, "chapters", "the-window"))).toBe(false);
      expect(existsSync(path.join(out, "story", "index.html"))).toBe(true);
      expect(existsSync(path.join(out, "story", "timeline", "index.html"))).toBe(true);
      expect(existsSync(path.join(out, "story", "characters", "index.html"))).toBe(true);

      const manifest = JSON.parse(
        await readFile(path.join(out, "authorbot-build.json"), "utf8"),
      ) as { schema: string; chapters: { slug: string }[] };
      expect(manifest.schema).toBe("authorbot.build/v1");
      expect(manifest.chapters.map((chapter) => chapter.slug)).toEqual([
        "baseline",
        "null-results",
      ]);
    },
  );

  it(
    "passes --api-url through to the publisher (Phase 2b islands)",
    { timeout: 240_000 },
    async () => {
      const out = await makeOutDir();
      const result = runBin([
        "build",
        exampleRepo,
        "--out",
        out,
        "--api-url",
        "/my-book",
      ]);
      expect(result.status, result.stderr).toBe(0);
      const page = await readFile(
        path.join(out, "chapters", "baseline", "index.html"),
        "utf8",
      );
      expect(page).toContain('data-api-base="/my-book"');
      expect(page).toContain('<script type="module" src="/_astro/authorbot-collab.js">');
      expect(page).toContain("Content-Security-Policy");
      // The CLI never sets the dev-login flag (programmatic builds only).
      expect(page).not.toContain("data-dev-login");
      expect(existsSync(path.join(out, "_astro", "authorbot-collab.js"))).toBe(true);
      expect(existsSync(path.join(out, "_astro", "authorbot-collab.css"))).toBe(true);
      // Story pages stay script-free.
      const story = await readFile(path.join(out, "story", "index.html"), "utf8");
      expect(story).not.toContain("<script");
    },
  );

  it(
    "includes drafts with a banner under --include-drafts",
    { timeout: 240_000 },
    async () => {
      const out = await makeOutDir();
      const result = runBin(["build", exampleRepo, "--out", out, "--include-drafts"]);
      expect(result.status, result.stderr).toBe(0);
      const page = await readFile(
        path.join(out, "chapters", "the-window", "index.html"),
        "utf8",
      );
      expect(page).toContain("draft-banner");
    },
  );
});
