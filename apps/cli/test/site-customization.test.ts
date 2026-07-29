import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validFixturesRoot } from "@authorbot/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { validateBookRepo } from "../src/index.js";

/**
 * Site-customization surface (0.1.51): `publication.nav_links` hrefs are
 * validated by the shared schema (so validate rejects exactly what the
 * build rejects), and `authorbot-site.json` is a reserved output name that
 * a book's `public/` may not shadow silently.
 */

const tempDirs: string[] = [];

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "authorbot-sitecustom-"));
  tempDirs.push(dir);
  await cp(path.join(validFixturesRoot, "minimal"), dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function withNavLinks(root: string, entries: [string, string][]): Promise<void> {
  await appendFile(
    path.join(root, "book.yml"),
    [
      "publication:",
      "  nav_links:",
      ...entries.flatMap(([label, href]) => [
        `    - label: "${label}"`,
        `      href: "${href}"`,
      ]),
      "",
    ].join("\n"),
  );
}

describe("publication.nav_links validation", () => {
  it("accepts a book-relative link", async () => {
    const repo = await makeRepo();
    await withNavLinks(repo, [["Story map", "/story-map/"]]);
    const report = await validateBookRepo(repo);
    expect(report.valid).toBe(true);
    expect(report.warnings).toEqual([]);
  });

  it.each([
    "javascript:alert(1)",
    "https://example.com/",
    "//evil.example/",
    "no-leading-slash",
    "/../secrets/",
  ])("rejects the unsafe href %s", async (href) => {
    const repo = await makeRepo();
    await withNavLinks(repo, [["Bad", href]]);
    const report = await validateBookRepo(repo);
    expect(report.valid).toBe(false);
    const finding = report.errors.find((entry) => entry.code === "BOOK_CONFIG_INVALID");
    expect(finding?.pointer).toContain("/publication/nav_links/0/href");
  });
});

describe("authorbot-site.json reservation", () => {
  it("warns when public/ shadows the site-data JSON", async () => {
    const repo = await makeRepo();
    await mkdir(path.join(repo, "public"), { recursive: true });
    await writeFile(path.join(repo, "public", "authorbot-site.json"), "{}");
    const report = await validateBookRepo(repo);
    expect(report.valid).toBe(true);
    const warning = report.warnings.find((entry) => entry.code === "PATH_UNSAFE");
    expect(warning?.message).toContain("authorbot-site.json");
  });

  it("rejects a chapter_url routing under the reserved name", async () => {
    const repo = await makeRepo();
    await appendFile(
      path.join(repo, "book.yml"),
      ["publication:", "  chapter_url: /authorbot-site.json/{slug}/", ""].join("\n"),
    );
    const report = await validateBookRepo(repo);
    expect(report.valid).toBe(false);
    const finding = report.errors.find((entry) => entry.code === "PATH_UNSAFE");
    expect(finding?.message).toContain("reserved path");
  });
});
