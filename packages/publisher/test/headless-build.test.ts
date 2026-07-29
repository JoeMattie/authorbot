import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSite, SITE_JSON_FILENAME } from "../src/index.js";

/**
 * Headless mode (0.1.53): `publication.mode: headless` emits no generated
 * pages and no islands - only the book's `public/` tree, the generated
 * image thumbnails under `_astro/`, `authorbot-site.json`, the manifest
 * (marked `mode: headless`), and `_headers`. The book owns the entire
 * frontend.
 */

const BOOK_ID = "0190f27c-6e65-7ca5-a596-9f093d577aba";
const CHAPTER_ID = "0190f27d-8ea5-7e43-a6f2-64d6939ff3b4";
const BLOCK = "0190f27e-1a93-7b61-996a-9f94849d27a8";
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "authorbot-headless-repo-"));
  tempDirs.push(repo);
  await writeFile(
    path.join(repo, "book.yml"),
    [
      "schema: authorbot.book/v1",
      `id: ${BOOK_ID}`,
      "title: Headless Book",
      "slug: headless-book",
      "language: en",
      "publication:",
      "  mode: headless",
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
  await mkdir(path.join(repo, "story", "characters"), { recursive: true });
  await writeFile(
    path.join(repo, "story", "characters", "mara.md"),
    [
      "---",
      "schema: authorbot.character/v1",
      "id: character:mara",
      "name: Mara Voss",
      "image: public/characters/mara.png",
      "---",
      "",
      "Body.",
      "",
    ].join("\n"),
  );
  await mkdir(path.join(repo, "public", "characters"), { recursive: true });
  await writeFile(path.join(repo, "public", "characters", "mara.png"), PNG_1X1);
  await writeFile(
    path.join(repo, "public", "index.html"),
    "<!doctype html><title>Book-owned frontend</title>\n",
  );
  return repo;
}

async function makeOut(): Promise<string> {
  const out = await mkdtemp(path.join(os.tmpdir(), "authorbot-headless-out-"));
  tempDirs.push(out);
  return out;
}

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

describe("buildSite in headless mode", () => {
  it("emits only public/, thumbnails, and the data artifacts", async () => {
    const repo = await makeRepo();
    const out = await makeOut();
    const manifest = await buildSite({ repoPath: repo, outDir: out, commit: null });

    // The book's frontend is the site root.
    const index = await readFile(path.join(out, "index.html"), "utf8");
    expect(index).toContain("Book-owned frontend");
    // Original assets pass through; thumbnails are still generated.
    expect(await exists(path.join(out, "characters", "mara.png"))).toBe(true);
    const site = JSON.parse(
      await readFile(path.join(out, SITE_JSON_FILENAME), "utf8"),
    ) as { schema: string; characters: { image?: { thumb: string } }[]; chapters: unknown[] };
    expect(site.schema).toBe("authorbot.site/v1");
    expect(site.chapters).toHaveLength(1);
    const thumb = site.characters[0]?.image?.thumb;
    expect(thumb).toMatch(/^\/_astro\/authorbot-character-mara\.[0-9a-f]{10}\.webp$/);
    expect(await exists(path.join(out, String(thumb).slice(1)))).toBe(true);
    // No generated pages, styles, or islands.
    expect(await exists(path.join(out, "chapters"))).toBe(false);
    expect(await exists(path.join(out, "story"))).toBe(false);
    // The manifest records the mode and still lists chapters.
    expect(manifest.mode).toBe("headless");
    expect(manifest.chapters).toHaveLength(1);
    const written = JSON.parse(
      await readFile(path.join(out, "authorbot-build.json"), "utf8"),
    ) as { mode?: string };
    expect(written.mode).toBe("headless");
    // _headers still ships (cache policy applies to the book's site too).
    expect(await exists(path.join(out, "_headers"))).toBe(true);
  }, 120000);

  it("nests the output under the base path", async () => {
    const repo = await makeRepo();
    const out = await makeOut();
    await buildSite({
      repoPath: repo,
      outDir: out,
      commit: null,
      baseUrl: "https://example.org/books/test/",
    });
    expect(await exists(path.join(out, "books", "test", "index.html"))).toBe(true);
    const site = JSON.parse(
      await readFile(path.join(out, "books", "test", SITE_JSON_FILENAME), "utf8"),
    ) as { basePath: string };
    expect(site.basePath).toBe("/books/test/");
    // The manifest stays at the deploy root.
    expect(await exists(path.join(out, "authorbot-build.json"))).toBe(true);
  }, 120000);

  it("keeps the generated site for the default mode", async () => {
    const repo = await makeRepo();
    await writeFile(
      path.join(repo, "book.yml"),
      [
        "schema: authorbot.book/v1",
        `id: ${BOOK_ID}`,
        "title: Headless Book",
        "slug: headless-book",
        "language: en",
        "",
      ].join("\n"),
    );
    const out = await makeOut();
    const manifest = await buildSite({ repoPath: repo, outDir: out, commit: null });
    expect(manifest.mode).toBeUndefined();
    expect(await exists(path.join(out, "chapters", "opening", "index.html"))).toBe(true);
  }, 120000);
});
