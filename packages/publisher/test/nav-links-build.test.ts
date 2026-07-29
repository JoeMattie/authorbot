import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSite } from "../src/index.js";

/**
 * Book-defined nav links (0.1.51): `publication.nav_links` renders plain
 * anchors after the built-in nav items on every generated page, so a custom
 * page the book ships under `public/` gets first-class navigation - without
 * a script tag and without `aria-current` (the layout cannot recognize a
 * page it did not generate).
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

async function makeRepo(navLinksYaml: string[]): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "authorbot-navlinks-repo-"));
  tempDirs.push(repo);
  await writeFile(
    path.join(repo, "book.yml"),
    [
      "schema: authorbot.book/v1",
      `id: ${BOOK_ID}`,
      "title: Linked Book",
      "slug: linked-book",
      "language: en",
      "publication:",
      "  nav_links:",
      ...navLinksYaml,
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
  return repo;
}

async function makeOut(): Promise<string> {
  const out = await mkdtemp(path.join(os.tmpdir(), "authorbot-navlinks-out-"));
  tempDirs.push(out);
  return out;
}

describe("buildSite with nav links", () => {
  it("renders the anchors after the built-in items on every page, script-free", async () => {
    const repo = await makeRepo([
      '    - label: "Story map"',
      '      href: /story-map/',
      '    - label: "<script>alert(1)</script>"',
      '      href: /extras/',
    ]);
    const out = await makeOut();
    await buildSite({ repoPath: repo, outDir: out, commit: null });

    for (const page of ["index.html", "chapters/opening/index.html"]) {
      const html = await readFile(path.join(out, page), "utf8");
      expect(html).toContain('<a href="/story-map/">Story map</a>');
      // The label is escaped, not executed, and the anchor carries no
      // aria-current.
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(html).not.toContain("<script");
      expect(html.indexOf("Characters</a>")).toBeLessThan(html.indexOf("Story map"));
      expect(html).not.toMatch(/aria-current[^>]*>Story map/);
    }
  }, 120000);

  it("prefixes hrefs with the base path", async () => {
    const repo = await makeRepo(['    - label: "Story map"', "      href: /story-map/"]);
    const out = await makeOut();
    await buildSite({
      repoPath: repo,
      outDir: out,
      commit: null,
      baseUrl: "https://example.org/books/test/",
    });
    const html = await readFile(
      path.join(out, "books", "test", "index.html"),
      "utf8",
    );
    expect(html).toContain('<a href="/books/test/story-map/">Story map</a>');
  }, 120000);
});
