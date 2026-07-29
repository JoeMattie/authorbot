import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSite, SITE_JSON_FILENAME } from "../src/index.js";

/**
 * Site-data JSON (0.1.51): every build writes `authorbot-site.json` next to
 * `index.html` - the same model the generated pages embed, versioned
 * `authorbot.site/v1` - so book-authored custom pages under `public/` can
 * render structured story data without an authorbot release.
 */

const BOOK_ID = "0190f27c-6e65-7ca5-a596-9f093d577aba";
const CHAPTER_ID = "0190f27d-8ea5-7e43-a6f2-64d6939ff3b4";
const BLOCK = "0190f27e-1a93-7b61-996a-9f94849d27a8";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "authorbot-sitejson-repo-"));
  tempDirs.push(repo);
  await writeFile(
    path.join(repo, "book.yml"),
    [
      "schema: authorbot.book/v1",
      `id: ${BOOK_ID}`,
      "title: Data Book",
      "slug: data-book",
      "language: en",
      "",
    ].join("\n"),
  );
  await mkdir(path.join(repo, "chapters"), { recursive: true });
  await writeFile(
    path.join(repo, "chapters", "opening.md"),
    [
      "---",
      "schema: authorbot.chapter/v1",
      `id: ${CHAPTER_ID}`,
      "slug: opening",
      "title: Opening",
      "order: 10",
      "status: published",
      "revision: 1",
      "authors:",
      "  - actor: github:someone",
      "---",
      "",
      `<!-- authorbot:block id="${BLOCK}" -->`,
      "Prose of the opening.",
      "",
    ].join("\n"),
  );
  return repo;
}

async function makeOut(): Promise<string> {
  const out = await mkdtemp(path.join(os.tmpdir(), "authorbot-sitejson-out-"));
  tempDirs.push(out);
  return out;
}

describe("buildSite site-data JSON", () => {
  it("writes the versioned model next to index.html", async () => {
    const repo = await makeRepo();
    const out = await makeOut();
    await buildSite({ repoPath: repo, outDir: out, commit: null });

    const raw = await readFile(path.join(out, SITE_JSON_FILENAME), "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(data.schema).toBe("authorbot.site/v1");
    expect(data.basePath).toBe("/");
    expect(data).not.toHaveProperty("localDev");
    const chapters = data.chapters as { html: string; href: string }[];
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.html).toContain("Prose of the opening.");
    // The JSON embeds the same rendered prose as the chapter page.
    const page = await readFile(path.join(out, "chapters", "opening", "index.html"), "utf8");
    expect(page).toContain(chapters[0]?.html);
  }, 120000);

  it("nests under the base path so custom pages can fetch it relatively", async () => {
    const repo = await makeRepo();
    const out = await makeOut();
    await buildSite({
      repoPath: repo,
      outDir: out,
      commit: null,
      baseUrl: "https://example.org/books/test/",
    });
    const raw = await readFile(
      path.join(out, "books", "test", SITE_JSON_FILENAME),
      "utf8",
    );
    const data = JSON.parse(raw) as { basePath: string };
    expect(data.basePath).toBe("/books/test/");
  }, 120000);

  it("wins over a book-supplied public/authorbot-site.json", async () => {
    const repo = await makeRepo();
    const out = await makeOut();
    await mkdir(path.join(repo, "public"), { recursive: true });
    await writeFile(
      path.join(repo, "public", SITE_JSON_FILENAME),
      '{"impostor":true}\n',
    );
    await buildSite({ repoPath: repo, outDir: out, commit: null });
    const raw = await readFile(path.join(out, SITE_JSON_FILENAME), "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(data.impostor).toBeUndefined();
    expect(data.schema).toBe("authorbot.site/v1");
  }, 120000);
});
