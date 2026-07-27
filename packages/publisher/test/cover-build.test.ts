import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSite } from "../src/index.js";

/**
 * Cover images (0.1.49): `public/` is copied verbatim into the output,
 * `publication.cover_images` yields hashed WebP thumbnails under `_astro/`,
 * and the landing page renders the thumbnail group and its script-free
 * `:target` lightboxes - all without introducing a single script tag.
 */

const BOOK_ID = "0190f27c-6e65-7ca5-a596-9f093d577aba";
const CHAPTER_ID = "0190f27d-8ea5-7e43-a6f2-64d6939ff3b4";
const BLOCK = "0190f27e-1a93-7b61-996a-9f94849d27a8";
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let repo: string;
let out: string;
let indexHtml: string;
const tempDirs: string[] = [];

beforeAll(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), "authorbot-cover-repo-"));
  out = await mkdtemp(path.join(os.tmpdir(), "authorbot-cover-out-"));
  tempDirs.push(repo, out);
  await writeFile(
    path.join(repo, "book.yml"),
    [
      "schema: authorbot.book/v1",
      `id: ${BOOK_ID}`,
      "title: Covered Book",
      "slug: covered-book",
      "language: en",
      "publication:",
      "  cover_images:",
      "    - public/covers/one.png",
      "    - public/covers/two.png",
      "  cover_images_label: Cover candidates",
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
      "Prose.",
      "",
    ].join("\n"),
  );
  await mkdir(path.join(repo, "public", "covers"), { recursive: true });
  await writeFile(path.join(repo, "public", "covers", "one.png"), PNG_1X1);
  await writeFile(path.join(repo, "public", "covers", "two.png"), PNG_1X1);
  await buildSite({ repoPath: repo, outDir: out, commit: null });
  indexHtml = await readFile(path.join(out, "index.html"), "utf8");
}, 120000);

afterAll(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("buildSite with cover images", () => {
  it("copies public/ into the output verbatim", async () => {
    const copied = await readFile(path.join(out, "covers", "one.png"));
    expect(copied.equals(PNG_1X1)).toBe(true);
  });

  it("emits hashed WebP thumbnails under _astro/", async () => {
    const thumbs = indexHtml.match(/\/_astro\/authorbot-cover-\d\.[0-9a-f]{10}\.webp/g) ?? [];
    expect(new Set(thumbs).size).toBe(2);
    for (const thumb of new Set(thumbs)) {
      const file = path.join(out, thumb.slice(1));
      expect((await stat(file)).isFile()).toBe(true);
    }
  });

  it("renders the labeled thumbnail group linking each cover's lightbox", () => {
    expect(indexHtml).toContain('aria-label="Cover candidates"');
    expect(indexHtml).toContain("Cover candidates");
    expect(indexHtml).toContain('href="#cover-1"');
    expect(indexHtml).toContain('href="#cover-2"');
    expect(indexHtml).toContain("book-masthead-with-covers");
  });

  it("renders a lightbox per cover with a link to the original", () => {
    expect(indexHtml).toContain('id="cover-1"');
    expect(indexHtml).toContain('id="cover-2"');
    expect(indexHtml).toContain('href="/covers/one.png"');
    expect(indexHtml).toContain('href="/covers/two.png"');
    expect(indexHtml).toContain("cover-modal-close");
  });

  it("stays script-free", () => {
    expect(indexHtml).not.toContain("<script");
  });
});
