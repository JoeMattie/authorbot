import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifestSchema } from "@authorbot/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSite } from "../src/index.js";

/**
 * End-to-end assertions from Phase 1 contract section 6: expected output
 * tree, draft exclusion (absent AND unreachable), every internal href/src
 * resolves to an emitted file or anchor, block anchors for marked blocks,
 * zero <script> elements, schema-valid manifest matching the repo,
 * prev/next ordering, --include-drafts banner, and sanitization of a
 * hostile repository.
 */

const exampleRepo = fileURLToPath(
  new URL("../../../examples/book-repo/", import.meta.url),
);
const minimalFixture = fileURLToPath(
  new URL("../../test-fixtures/fixtures/valid/minimal/", import.meta.url),
);

let outDefault: string;
let outDrafts: string;
const tempDirs: string[] = [];

async function collectFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(abs)));
    } else {
      files.push(abs);
    }
  }
  return files;
}

async function collectHtmlFiles(dir: string): Promise<string[]> {
  return (await collectFiles(dir)).filter((file) => file.endsWith(".html"));
}

/** True for URLs that leave the site (scheme-qualified or protocol-relative). */
function isExternal(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
}

/**
 * Every internal href/src in every emitted HTML file must resolve to an
 * emitted file; fragments must resolve to an id in the target document.
 * Returns the number of internal references checked.
 */
async function assertInternalRefsResolve(outDir: string): Promise<number> {
  let checked = 0;
  for (const file of await collectHtmlFiles(outDir)) {
    const html = await readFile(file, "utf8");
    for (const match of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
      const url = match[1] ?? "";
      if (url === "" || isExternal(url)) {
        continue;
      }
      checked += 1;
      const hashIndex = url.indexOf("#");
      const pathPart = hashIndex === -1 ? url : url.slice(0, hashIndex);
      const fragment = hashIndex === -1 ? "" : url.slice(hashIndex + 1);
      let target: string;
      if (pathPart === "") {
        target = file; // same-document fragment
      } else if (pathPart.startsWith("/")) {
        target = path.join(outDir, pathPart);
      } else {
        target = path.resolve(path.dirname(file), pathPart);
      }
      if (pathPart.endsWith("/")) {
        target = path.join(target, "index.html");
      }
      const context = `${url} referenced from ${file}`;
      const content = await readFile(target, "utf8").catch(() => {
        throw new Error(`unresolved internal reference: ${context}`);
      });
      if (fragment !== "") {
        expect(content, `missing anchor for ${context}`).toContain(
          `id="${fragment}"`,
        );
      }
    }
  }
  return checked;
}

beforeAll(async () => {
  outDefault = await mkdtemp(path.join(os.tmpdir(), "authorbot-e2e-default-"));
  outDrafts = await mkdtemp(path.join(os.tmpdir(), "authorbot-e2e-drafts-"));
  tempDirs.push(outDefault, outDrafts);
  await buildSite({ repoPath: exampleRepo, outDir: outDefault, logLevel: "error" });
  await buildSite({
    repoPath: exampleRepo,
    outDir: outDrafts,
    includeDrafts: true,
    logLevel: "error",
  });
}, 240_000);

afterAll(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("buildSite on examples/book-repo", () => {
  it("emits the contract section 2 output tree", async () => {
    for (const rel of [
      "index.html",
      "authorbot-build.json",
      "chapters/baseline/index.html",
      "chapters/null-results/index.html",
      "story/index.html",
      "story/timeline/index.html",
      "story/characters/index.html",
      "story/characters/mara-voss/index.html",
      "story/characters/theo-abara/index.html",
    ]) {
      await expect(
        readFile(path.join(outDefault, rel), "utf8"),
        rel,
      ).resolves.toBeTruthy();
    }
  });

  it("excludes the draft chapter from chapters/ and from the index", async () => {
    await expect(
      readFile(path.join(outDefault, "chapters/the-window/index.html"), "utf8"),
    ).rejects.toThrow();
    const index = await readFile(path.join(outDefault, "index.html"), "utf8");
    expect(index).not.toContain("the-window");
  });

  it("leaves the draft chapter unreachable by any link in any page", async () => {
    const files = await collectHtmlFiles(outDefault);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const html = await readFile(file, "utf8");
      for (const match of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
        expect(match[1], `link in ${file}`).not.toContain("the-window");
      }
    }
  });

  it("emits zero <script> tags anywhere", async () => {
    const files = await collectHtmlFiles(outDefault);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(await readFile(file, "utf8"), file).not.toContain("<script");
    }
  });

  it("ships no client bundle: only html, css, and the manifest", async () => {
    const extensions = new Set(
      (await collectFiles(outDefault)).map((file) => path.extname(file)),
    );
    expect([...extensions].sort()).toEqual([".css", ".html", ".json"]);
  });

  it("anchors every marked block in every published chapter", async () => {
    const chapters: Array<[source: string, slug: string]> = [
      ["001-baseline.md", "baseline"],
      ["002-null-results.md", "null-results"],
    ];
    for (const [source, slug] of chapters) {
      const markdown = await readFile(
        path.join(exampleRepo, "chapters", source),
        "utf8",
      );
      const ids = [
        ...markdown.matchAll(/<!-- authorbot:block id="([0-9a-f-]{36})" -->/g),
      ].map((match) => match[1]);
      expect(ids.length, source).toBeGreaterThan(0);
      const page = await readFile(
        path.join(outDefault, "chapters", slug, "index.html"),
        "utf8",
      );
      for (const id of ids) {
        expect(page, `${slug}: block ${id}`).toContain(`id="b-${id}"`);
      }
      // Marker comments themselves are stripped from the output.
      expect(page).not.toContain("authorbot:block");
    }
  });

  it("resolves every internal href/src to an emitted file or anchor", async () => {
    const checked = await assertInternalRefsResolve(outDefault);
    expect(checked).toBeGreaterThan(10);
  });

  it("writes a schema-valid manifest whose chapters match the repo", async () => {
    const manifest: unknown = JSON.parse(
      await readFile(path.join(outDefault, "authorbot-build.json"), "utf8"),
    );
    const parsed = buildManifestSchema.parse(manifest);
    expect(parsed.chapters).toEqual([
      {
        id: "019cadfd-8900-7140-98fb-ceff64cada33",
        slug: "baseline",
        revision: 3,
        title: "Baseline",
        status: "published",
      },
      {
        id: "019d0bc2-a980-734d-b0c1-aa819448d107",
        slug: "null-results",
        revision: 2,
        title: "Null Results",
        status: "published",
      },
    ]);
  });

  it("links prev/next navigation in order", async () => {
    const baseline = await readFile(
      path.join(outDefault, "chapters/baseline/index.html"),
      "utf8",
    );
    expect(baseline).toContain('rel="next"');
    expect(baseline).toContain('href="/chapters/null-results/"');
    expect(baseline).not.toContain('rel="prev"');
    const nullResults = await readFile(
      path.join(outDefault, "chapters/null-results/index.html"),
      "utf8",
    );
    expect(nullResults).toContain('rel="prev"');
    expect(nullResults).toContain('href="/chapters/baseline/"');
    expect(nullResults).not.toContain('rel="next"');
  });

  it("renders the story views with links into the book", async () => {
    const outline = await readFile(path.join(outDefault, "story/index.html"), "utf8");
    expect(outline).toContain('href="/chapters/baseline/"');
    const timeline = await readFile(
      path.join(outDefault, "story/timeline/index.html"),
      "utf8",
    );
    expect(timeline).toContain('href="/story/characters/mara-voss/"');
    const character = await readFile(
      path.join(outDefault, "story/characters/mara-voss/index.html"),
      "utf8",
    );
    expect(character).toContain('href="/chapters/baseline/"');
  });

  it("renders the redesigned story views from repository planning data", async () => {
    const outline = await readFile(path.join(outDefault, "story/index.html"), "utf8");
    expect(outline).toContain("How the book is built");
    expect(outline).toContain("Story outline · snowflake");
    expect(outline).toContain("story-outline-node-scene");
    expect(outline).toContain("Establish the drift as real, small, and periodic.");
    expect(outline).toContain("Every plausible explanation implicates the instrument");
    expect(outline).toContain("Mara logs the drift and keeps it to herself.");
    expect(outline).toContain("Chapter summaries");
    expect(outline).toContain("Generated from current chapter metadata");
    expect(outline).toContain(
      "During a routine calibration, Mara Voss finds a small periodic drift",
    );
    expect(outline).toContain(
      "Mara and Theo replace every component that could plausibly lie to them.",
    );
    expect(outline).not.toContain(
      "At higher sampling rates the drift resolves into structure",
    );
    // Both relationships point into the excluded draft subtree, so neither
    // its title nor its relationship copy may leak into a public build.
    expect(outline).not.toContain("foreshadows");
    expect(outline).not.toContain("leads to");

    const draftOutline = await readFile(path.join(outDrafts, "story/index.html"), "utf8");
    expect(draftOutline).toContain("foreshadows");
    expect(draftOutline).toContain("Eleven notches");
    expect(draftOutline).toContain("leads to");
    expect(draftOutline).toContain("The Window");
    // Draft summaries never enter static generated navigation, even in a local
    // include-drafts build. An authenticated island may add them from the API.
    expect(draftOutline).not.toContain(
      "At higher sampling rates the drift resolves into structure",
    );

    const timeline = await readFile(
      path.join(outDefault, "story/timeline/index.html"),
      "utf8",
    );
    expect(timeline).toContain("When things happen");
    expect(timeline).toContain("story-timeline-card");
    expect(timeline).toContain("The residual arc repeats every seventy-one minutes.");
    expect(timeline).toContain("Instrument bay");

    const characters = await readFile(
      path.join(outDefault, "story/characters/index.html"),
      "utf8",
    );
    expect(characters).toContain("Who is in the room");
    expect(characters).toContain("character-card");
    expect(characters).toContain(">MV<");
    expect(characters).toContain("2 chapters");

    const mara = await readFile(
      path.join(outDefault, "story/characters/mara-voss/index.html"),
      "utf8",
    );
    expect(mara).toContain("All characters");
    expect(mara).toContain("character-avatar-large");
    expect(mara).toContain("also known as M.V.");
    expect(mara).toContain("character-appearances");
  });

  it("renders the GFM table and strikethrough on the character page", async () => {
    const page = await readFile(
      path.join(outDefault, "story/characters/mara-voss/index.html"),
      "utf8",
    );
    // The drift ledger renders as a real table with a header row.
    expect(page).toContain('<div class="table-wrap"><table>');
    expect(page).toContain('<th scope="col"');
    expect(page).toContain("within tolerance");
    // Column alignment from the delimiter row survives.
    expect(page).toContain('style="text-align:right"');
    // Strikethrough renders as <del>, tildes gone.
    expect(page).toContain("<del>instrument error</del>");
    expect(page).not.toContain("~~");
    // No raw pipe characters leak into the visible prose.
    const visibleText = page.replace(/<[^>]*>/g, "");
    expect(visibleText).not.toContain("|");
  });

  it("keeps the draft chapter's title and reveals out of the public story views", async () => {
    // Regression: the outline used to show the draft chapter's node and its
    // scene, and the timeline used to fall back to the excluded chapter's
    // frontmatter title (and render the event describing its reveal).
    const outline = await readFile(path.join(outDefault, "story/index.html"), "utf8");
    expect(outline).not.toContain("The Window");
    expect(outline).not.toContain("Eleven notches");
    const timeline = await readFile(
      path.join(outDefault, "story/timeline/index.html"),
      "utf8",
    );
    expect(timeline).not.toContain("The Window");
    // The event whose only chapter_ref is the draft chapter is omitted.
    expect(timeline).not.toContain("Eleven notches resolve inside the arc");
    // Events referencing published chapters still render.
    expect(timeline).toContain("The drift is first logged");
  });
});

describe("buildSite with includeDrafts", () => {
  it("adds draft chapters with a visible draft banner", async () => {
    const page = await readFile(
      path.join(outDrafts, "chapters/the-window/index.html"),
      "utf8",
    );
    expect(page).toContain("draft-banner");
    expect(page).toContain('name="robots" content="noindex"');
    const manifest = buildManifestSchema.parse(
      JSON.parse(await readFile(path.join(outDrafts, "authorbot-build.json"), "utf8")),
    );
    expect(manifest.chapters.map((chapter) => chapter.status)).toEqual([
      "published",
      "published",
      "draft",
    ]);
  });

  it("makes the draft reachable and keeps all internal refs resolvable", async () => {
    const index = await readFile(path.join(outDrafts, "index.html"), "utf8");
    expect(index).toContain('href="/chapters/the-window/"');
    await assertInternalRefsResolve(outDrafts);
  });

  it("shows the draft chapter in the story views once it is included", async () => {
    const outline = await readFile(path.join(outDrafts, "story/index.html"), "utf8");
    expect(outline).toContain("The Window");
    expect(outline).toContain("Eleven notches");
    expect(outline).toContain('href="/chapters/the-window/"');
    const timeline = await readFile(
      path.join(outDrafts, "story/timeline/index.html"),
      "utf8",
    );
    expect(timeline).toContain("Eleven notches resolve inside the arc");
    expect(timeline).toContain('href="/chapters/the-window/"');
  });
});

describe("buildSite sanitization (hostile repo)", () => {
  it("never lets hostile content reach the output unescaped", { timeout: 240_000 }, async () => {
    // Throwaway hostile repo: copy the minimal valid fixture, then inject
    // hostile content into the chapter. book.yml keeps content.raw_html: false.
    const repo = await mkdtemp(path.join(os.tmpdir(), "authorbot-hostile-"));
    const out = await mkdtemp(path.join(os.tmpdir(), "authorbot-hostile-out-"));
    tempDirs.push(repo, out);
    await cp(minimalFixture, repo, { recursive: true });

    const bookYml = await readFile(path.join(repo, "book.yml"), "utf8");
    expect(bookYml).toContain("raw_html: false");
    await writeFile(
      path.join(repo, "book.yml"),
      bookYml.replace("title: Minimal Fixture Book", 'title: Hostile "Book" <script>'),
    );

    const chapterPath = path.join(repo, "chapters", "001-solitary.md");
    let chapter = await readFile(chapterPath, "utf8");
    expect(chapter).toContain("status: draft");
    chapter = chapter.replace("status: draft", "status: published");
    chapter = chapter.replace(
      "revision: 1\n",
      "revision: 1\nsummary: '\"><script>alert(9)</script>'\n",
    );
    chapter += [
      "",
      "<script>alert(1)</script>",
      "",
      "Click [x](javascript:alert(1)) now.",
      "",
      "Or ![img](vbscript:x) with inline <b onmouseover=alert(2)>markup</b>.",
      "",
    ].join("\n");
    await writeFile(chapterPath, chapter);

    await buildSite({ repoPath: repo, outDir: out, logLevel: "error" });

    const files = await collectHtmlFiles(out);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const html = await readFile(file, "utf8");
      // Hostile markup may survive only as escaped text, never as an
      // executable element or a runnable URL.
      expect(html, file).not.toContain("<script");
      expect(html, file).not.toContain("javascript:");
      expect(html, file).not.toContain("vbscript:");
      expect(html, file).not.toContain("<img");
      expect(html, file).not.toContain("<b ");
    }
    const page = await readFile(path.join(out, "chapters/solitary/index.html"), "utf8");
    // The script paragraph survives only as escaped text.
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // The javascript: link is not rendered as a link; its text remains.
    expect(page).toContain("Click x now.");
    // Inline raw HTML survives only as escaped text, wrapped as non-atom
    // text (data-ab-skip) so the islands' normalizer stays in parity with
    // the mdast stream (Phase 2b §2.2).
    expect(page).toContain(
      "with inline <span data-ab-skip>&lt;b onmouseover=alert(2)&gt;</span>" +
        "markup<span data-ab-skip>&lt;/b&gt;</span>.",
    );
  });
});
