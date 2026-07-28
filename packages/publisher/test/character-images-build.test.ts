import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSite } from "../src/index.js";

/**
 * Character images (0.1.50): a character `image` under `public/` yields a
 * hashed WebP thumbnail under `_astro/`, the index card attaches the
 * portrait to its right edge, the detail page renders it in the right
 * gutter with the same script-free `:target` lightbox as cover art, and
 * characters without an image render plainly (no avatar of any kind, the
 * monograms are gone) - all without a single script tag.
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
let charactersHtml: string;
let detailHtml: string;
const tempDirs: string[] = [];

beforeAll(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), "authorbot-charimg-repo-"));
  out = await mkdtemp(path.join(os.tmpdir(), "authorbot-charimg-out-"));
  tempDirs.push(repo, out);
  await writeFile(
    path.join(repo, "book.yml"),
    [
      "schema: authorbot.book/v1",
      `id: ${BOOK_ID}`,
      "title: Portrait Book",
      "slug: portrait-book",
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
      "Prose.",
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
  await writeFile(
    path.join(repo, "story", "characters", "plain.md"),
    [
      "---",
      "schema: authorbot.character/v1",
      "id: character:plain",
      "name: Plain Person",
      "---",
      "",
      "Body.",
      "",
    ].join("\n"),
  );
  await mkdir(path.join(repo, "public", "characters"), { recursive: true });
  await writeFile(path.join(repo, "public", "characters", "mara.png"), PNG_1X1);
  await buildSite({ repoPath: repo, outDir: out, commit: null });
  charactersHtml = await readFile(
    path.join(out, "story", "characters", "index.html"),
    "utf8",
  );
  detailHtml = await readFile(
    path.join(out, "story", "characters", "mara", "index.html"),
    "utf8",
  );
}, 120000);

afterAll(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("buildSite with character images", () => {
  it("copies the original into the output verbatim", async () => {
    const copied = await readFile(path.join(out, "characters", "mara.png"));
    expect(copied.equals(PNG_1X1)).toBe(true);
  });

  it("emits a hashed WebP thumbnail under _astro/ and renders it on both pages", async () => {
    const pattern = /\/_astro\/authorbot-character-mara\.[0-9a-f]{10}\.webp/;
    const thumb = charactersHtml.match(pattern)?.[0];
    expect(thumb).toBeDefined();
    expect(detailHtml).toMatch(pattern);
    expect((await stat(path.join(out, String(thumb).slice(1)))).isFile()).toBe(true);
    // The full-size original appears only inside the lightbox, lazily
    // loaded, so ordinary page display never fetches it.
    for (const html of [charactersHtml, detailHtml]) {
      const fullImgs = html.match(/<img src="\/characters\/mara\.png"[^>]*>/g) ?? [];
      expect(fullImgs).toHaveLength(1);
      expect(fullImgs[0]).toContain('loading="lazy"');
    }
  });

  it("attaches the portrait to the card's right edge", () => {
    expect(charactersHtml).toContain("character-card-with-image");
    expect(charactersHtml).toContain("character-card-portrait");
    expect(charactersHtml).toContain('href="#character-image-mara"');
  });

  it("renders no avatar of any kind for characters without an image", async () => {
    expect(charactersHtml).not.toContain("character-avatar");
    const plainDetail = await readFile(
      path.join(out, "story", "characters", "plain", "index.html"),
      "utf8",
    );
    expect(plainDetail).not.toContain("character-avatar");
    expect(plainDetail).not.toContain("character-detail-portrait");
    expect(plainDetail).not.toContain("character-detail-with-portrait");
  });

  it("renders the lightbox with Close and Open original links on both pages", () => {
    for (const html of [charactersHtml, detailHtml]) {
      expect(html).toContain("cover-modal");
      expect(html).toContain('href="/characters/mara.png"');
      expect(html).toContain("Open original");
      expect(html).toContain("cover-modal-close");
    }
    expect(charactersHtml).toContain('id="character-image-mara"');
    expect(detailHtml).toContain('id="character-image"');
    expect(detailHtml).toContain('href="#character-image"');
  });

  it("renders the portrait in the detail page's right gutter", () => {
    expect(detailHtml).toContain("character-detail-with-portrait");
    expect(detailHtml).toContain("character-detail-portrait");
  });

  it("stays script-free", () => {
    expect(charactersHtml).not.toContain("<script");
    expect(detailHtml).not.toContain("<script");
  });
});
