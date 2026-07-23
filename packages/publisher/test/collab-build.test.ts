import { gzipSync } from "node:zlib";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSite, resolveCollab, PublisherError } from "../src/index.js";
import type { BookConfig } from "@authorbot/schemas";

/**
 * Phase 2b contract §1, §3, §5: a build WITHOUT an API base stays exactly as
 * today - zero JavaScript, no collaboration artifacts, byte-comparable pages -
 * while a build WITH one emits, on chapter pages only, the CSP meta tag, the
 * island stylesheet link, the configured mount element, and the bundle
 * (≤ 35 KB gzipped).
 */

const exampleRepo = fileURLToPath(new URL("../../../examples/book-repo/", import.meta.url));

let outPlain: string;
let outCollab: string;
const tempDirs: string[] = [];

/**
 * ADR-0019: `api_url` is root-relative only. This build deliberately uses a
 * BASE PATH rather than "/", so the emitted mount data and every island
 * request URL are exercised under the `example.com/my-book/` shape.
 */
const API_URL = "/my-book";

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

const rel = (dir: string, files: string[]): string[] =>
  files.map((file) => path.relative(dir, file)).sort();

beforeAll(async () => {
  outPlain = await mkdtemp(path.join(os.tmpdir(), "authorbot-2b-plain-"));
  outCollab = await mkdtemp(path.join(os.tmpdir(), "authorbot-2b-collab-"));
  tempDirs.push(outPlain, outCollab);
  await buildSite({ repoPath: exampleRepo, outDir: outPlain, logLevel: "error" });
  await buildSite({
    repoPath: exampleRepo,
    outDir: outCollab,
    apiUrl: API_URL,
    devLogin: true,
    logLevel: "error",
  });
}, 240_000);

afterAll(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("api-url-less build (script-free regression)", () => {
  it("emits zero <script> and no collaboration artifacts anywhere", async () => {
    const files = await collectFiles(outPlain);
    expect(files.some((file) => file.endsWith(".js"))).toBe(false);
    for (const file of files.filter((f) => f.endsWith(".html"))) {
      const html = await readFile(file, "utf8");
      expect(html, file).not.toContain("<script");
      expect(html, file).not.toContain("authorbot-collab");
      expect(html, file).not.toContain("<authorbot-collab");
      // Phase 7's access-control island is bundled separately; it must be just
      // as absent from an api-url-less build as the collaboration one.
      expect(html, file).not.toContain("authorbot-access");
      expect(html, file).not.toContain("<authorbot-access");
    }
  });

  /**
   * The CSP is NOT a collaboration artifact (design §19.4).
   *
   * It used to be emitted only by pages that loaded an island, which meant the
   * two page types that inject author-supplied markup with `set:html` - the
   * chapter page of an api-url-less build, and every character page - shipped
   * with no policy at all. Nothing exploitable reaches that HTML today, but the
   * book that legitimately enables `content.raw_html` is exactly the book where
   * these pages render markup the author did not hand-audit, and a static page
   * pays nothing for the header. A CSP is a defence-in-depth layer, so it is
   * attached to what the page RENDERS, not to what it loads.
   */
  it("still carries a CSP on every page that renders prose through set:html", async () => {
    const proseFiles = (await collectFiles(outPlain)).filter(
      (file) =>
        file.endsWith(".html") &&
        (file.includes(`${path.sep}chapters${path.sep}`) ||
          file.includes(`${path.sep}characters${path.sep}`)),
    );
    // Guard against the filter silently matching nothing and the test passing
    // vacuously.
    expect(proseFiles.length).toBeGreaterThan(1);
    for (const file of proseFiles) {
      const html = await readFile(file, "utf8");
      if (!html.includes('class="prose"')) continue;
      expect(html, file).toContain(
        `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; ` +
          `connect-src 'self'; img-src 'self' data:">`,
      );
      // …and it is still a build with no JavaScript in it at all.
      expect(html, file).not.toContain("<script");
    }
  });

  it("differs from a collab build only by the island additions (byte-comparable)", async () => {
    const plainFiles = rel(outPlain, await collectFiles(outPlain));
    const collabFiles = rel(outCollab, await collectFiles(outCollab));
    // The collab build adds exactly the island assets plus the pages that
    // exist only when an API base is configured: /work/ (Phase 3 contract §6),
    // /settings/ (§3.6), /write/ (§3.5), and /revisions/ (Phase 11 §5). Each is gated
    // by `getStaticPaths` returning nothing without collab, which is what
    // keeps the api-url-less build byte-identical rather than merely similar.
    //
    // `authorbot-access.*` is Phase 7's maintainer surface, bundled apart from
    // the collaboration islands so no reader's chapter page carries it.
    const additions = collabFiles.filter((file) => !plainFiles.includes(file));
    const lazyAssets = additions.filter((file) => file.startsWith(path.join("_astro", "assets")));
    expect(lazyAssets.some((file) => file.includes("project-store-"))).toBe(true);
    expect(lazyAssets.some((file) => file.includes("work-queue-"))).toBe(true);
    expect(lazyAssets.some((file) => file.includes("revision-review-"))).toBe(true);
    expect(lazyAssets.some((file) => file.includes("manuscript-editor-element-"))).toBe(true);
    expect(lazyAssets.some((file) => file.includes("milkdown-manuscript-surface-"))).toBe(true);
    expect(lazyAssets.some((file) => file.includes("chapter-history-entry-"))).toBe(true);
    expect(lazyAssets.some((file) => file.includes("chapter-history-panel-"))).toBe(true);
    expect(additions.filter((file) => !lazyAssets.includes(file))).toEqual([
      path.join("_astro", "authorbot-access.css"),
      path.join("_astro", "authorbot-access.js"),
      path.join("_astro", "authorbot-account.js"),
      path.join("_astro", "authorbot-collab.css"),
      path.join("_astro", "authorbot-collab.js"),
      path.join("_astro", "authorbot-history.css"),
      path.join("_astro", "authorbot-planning.css"),
      path.join("_astro", "authorbot-planning.js"),
      path.join("_astro", "authorbot-revisions.css"),
      path.join("_astro", "authorbot-settings.css"),
      path.join("_astro", "authorbot-settings.js"),
      path.join("_astro", "authorbot-work.css"),
      path.join("revisions", "index.html"),
      path.join("settings", "index.html"),
      path.join("work", "index.html"),
      path.join("write", "index.html"),
    ]);
    expect(plainFiles.filter((file) => !collabFiles.includes(file))).toEqual([]);

    for (const file of plainFiles) {
      let plain = await readFile(path.join(outPlain, file), "utf8");
      let collab = await readFile(path.join(outCollab, file), "utf8");
      if (file === "authorbot-build.json") {
        // Manifests differ only by the build timestamp.
        const strip = (source: string): unknown => {
          const parsed = JSON.parse(source) as Record<string, unknown>;
          delete parsed["built_at"];
          return parsed;
        };
        expect(strip(collab)).toEqual(strip(plain));
        continue;
      }
      if (file.endsWith(".html")) {
        // Strip every island insertion; the remainder must be identical
        // (inter-tag whitespace normalized on both sides, since removing the
        // conditional template expressions also removes their surrounding
        // template whitespace).
        //
        // This now covers the home page as well as chapter pages. Phase 6
        // §3.5 puts the "New chapter" entry point there deliberately: the case
        // the section exists for is "an author facing an empty book", and a
        // book with no chapters has no chapter pages to host the button. The
        // invariant that still matters - and that the sibling test asserts -
        // is that the api-url-less build stays byte-identically script-free;
        // a collab build was always allowed to differ by exactly the islands.
        // The CSP meta is stripped from BOTH sides now: prose pages emit it in
        // either build (design §19.4), so it is no longer an island insertion,
        // while the island-only pages still add one the plain build lacks.
        collab = collab
          .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
          .replace(/<link rel="stylesheet" href="[^"]*authorbot-collab\.css">/, "")
          .replace(/<link rel="stylesheet" href="[^"]*authorbot-planning\.css">/, "")
          .replace(/<link rel="stylesheet" href="[^"]*authorbot-history\.css">/, "")
          .replace(/<authorbot-collab[^>]*>\s*<\/authorbot-collab>/, "")
          .replace(
            /<authorbot-planning-document-editor[^>]*>\s*<\/authorbot-planning-document-editor>/,
            "",
          )
          .replace(/<authorbot-new-chapter[^>]*>\s*<\/authorbot-new-chapter>/, "")
          .replace(/<authorbot-draft-chapters[^>]*>\s*<\/authorbot-draft-chapters>/, "")
          .replace(/<authorbot-chapter-activity[^>]*>\s*<\/authorbot-chapter-activity>/, "")
          .replace(/<authorbot-chapter-history[^>]*>\s*<\/authorbot-chapter-history>/, "")
          .replace(/ data-chapter-activity-id="[^"]*"/g, "")
          .replace(/<span data-chapter-activity-slot hidden><\/span>/g, "")
          .replace(/<div[^>]*data-collab-only="chapter-tools"[^>]*>\s*<\/div>/, "")
          // Capability-conditioned nav chrome joins the account island on
          // collab pages: Work is absent when there is no API, and the divider
          // exists only when there is an account strip to separate.
          .replace(/<authorbot-account[^>]*>\s*<\/authorbot-account>/, "")
          .replace(/<li data-collab-nav="work">[\s\S]*?<\/li>/, "")
          .replace(/<span[^>]*data-collab-nav="divider"[^>]*><\/span>/, "")
          .replace(/<authorbot-manuscript-editor[^>]*>\s*<\/authorbot-manuscript-editor>/, "")
          .replace(/<authorbot-chapter-composer[^>]*>[\s\S]*?<\/authorbot-chapter-composer>/, "")
          .replace(/<div class="chapter-authoring">\s*<\/div>/, "")
          .replace(/<script type="module" src="[^"]*authorbot-collab\.js"><\/script>/, "")
          .replace(/<script type="module" src="[^"]*authorbot-account\.js"><\/script>/, "")
          .replace(/<script type="module" src="[^"]*authorbot-planning\.js"><\/script>/, "")
          .replace(/>\s+</g, "> <");
        plain = plain
          .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
          .replace(/>\s+</g, "> <");
      }
      expect(collab, file).toBe(plain);
    }
  });
});

describe("collab-enabled build", () => {
  it("emits a same-origin CSP meta tag on chapter pages (ADR-0019 §1)", async () => {
    const page = await readFile(path.join(outCollab, "chapters/baseline/index.html"), "utf8");
    expect(page).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; ` +
        `connect-src 'self'; img-src 'self' data:">`,
    );
  });

  it("puts the account strip on the index, where an empty book's author lands", async () => {
    // The hole this closes: a book with no chapters had no sign-in anywhere.
    // The only "Sign in with GitHub" lived in the collab island, which renders
    // only on chapter pages - while the wizard signs off telling the author to
    // sign in and press "New chapter".
    const page = await readFile(path.join(outCollab, "index.html"), "utf8");
    const mount = /<authorbot-account[^>]*>/.exec(page)?.[0] ?? "";
    expect(mount).toContain(`data-api-base="${API_URL}"`);
    expect(mount).toContain("data-project=");
  });

  it("puts the account strip on chapter pages too, so signing out is always reachable", async () => {
    const page = await readFile(path.join(outCollab, "chapters/baseline/index.html"), "utf8");
    expect(page).toContain("<authorbot-account");
  });

  it("puts the account strip and planning entry on the Outline page", async () => {
    const page = await readFile(path.join(outCollab, "story/index.html"), "utf8");
    expect(page).toContain("<authorbot-account");
    expect(page).toContain('<script type="module" src="/_astro/authorbot-account.js">');
    expect(page).toContain('<script type="module" src="/_astro/authorbot-planning.js">');
    expect(page).toContain('<link rel="stylesheet" href="/_astro/authorbot-planning.css">');
    expect(page).not.toContain("authorbot-collab.js");
  });

  it("stamps the mount element with the data the islands need", async () => {
    const page = await readFile(path.join(outCollab, "chapters/baseline/index.html"), "utf8");
    const mount = /<authorbot-collab[^>]*>/.exec(page)?.[0] ?? "";
    expect(mount).toContain(`data-api-base="${API_URL}"`);
    expect(mount).toContain('data-project="hollow-creek-anomaly"');
    expect(mount).toContain('data-chapter-id="019cadfd-8900-7140-98fb-ceff64cada33"');
    expect(mount).toContain('data-chapter-revision="3"');
    expect(mount).toContain('data-show-public="true"');
    expect(mount).toContain('data-dev-login="true"');
    expect(page).toContain('<script type="module" src="/_astro/authorbot-collab.js">');
    expect(page).toContain('<link rel="stylesheet" href="/_astro/authorbot-collab.css">');
  });

  it("stamps each editable story document with its canonical repository identity", async () => {
    for (const [relPath, expected] of [
      [
        "story/index.html",
        ['data-kind="outline"', 'data-target-id="outline"', 'data-path="story/outline.yml"'],
      ],
      [
        "story/timeline/index.html",
        ['data-kind="timeline"', 'data-target-id="timeline"', 'data-path="story/timeline.yml"'],
      ],
      [
        "story/characters/mara-voss/index.html",
        [
          'data-kind="character"',
          'data-target-id="character:mara-voss"',
          'data-path="story/characters/mara-voss.md"',
        ],
      ],
    ] as const) {
      const html = await readFile(path.join(outCollab, relPath), "utf8");
      expect(html, relPath).toContain("<authorbot-planning-document-editor");
      for (const value of expected) expect(html, relPath).toContain(value);
      expect(html, relPath).toContain("authorbot-planning.js");
      expect(html, relPath).toContain("authorbot-planning.css");
    }

    const index = await readFile(
      path.join(outCollab, "story/characters/index.html"),
      "utf8",
    );
    expect(index).not.toContain("authorbot-planning-document-editor");
    expect(index).not.toContain("authorbot-planning.js");
  });

  it("hydrates story identity without loading chapter collaboration UI", async () => {
    for (const relPath of [
      "story/index.html",
      "story/timeline/index.html",
      "story/characters/index.html",
      "story/characters/mara-voss/index.html",
    ]) {
      const html = await readFile(path.join(outCollab, relPath), "utf8");
      expect(html, relPath).toContain("authorbot-account.js");
      expect(html, relPath).not.toContain("authorbot-collab");
      expect(html, relPath).toContain(
        `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; ` +
          `connect-src 'self'; img-src 'self' data:">`,
      );
    }
  });

  it("keeps the story-page account entry within a tight gzip budget", async () => {
    const js = await readFile(path.join(outCollab, "_astro/authorbot-account.js"));
    expect(gzipSync(js).length).toBeLessThanOrEqual(4 * 1024);
    expect(js.length).toBeGreaterThan(0);
  });

  it("resolves each retryable lazy chunk beside the stable entries", async () => {
    const assets = await readdir(path.join(outCollab, "_astro", "assets"));
    const projectStore = assets.find((file) => file.startsWith("project-store-"));
    const revisionReview = assets.find((file) => file.startsWith("revision-review-"));
    const workQueue = assets.find((file) => file.startsWith("work-queue-"));
    const manuscript = assets.find((file) => file.startsWith("milkdown-manuscript-surface-"));
    const manuscriptEntry = assets.find((file) => file.startsWith("manuscript-editor-element-"));
    const historyEntry = assets.find((file) => file.startsWith("chapter-history-entry-"));
    expect(projectStore).toBeDefined();
    expect(revisionReview).toBeDefined();
    expect(workQueue).toBeDefined();
    expect(manuscript).toBeDefined();
    expect(manuscriptEntry).toBeDefined();
    expect(historyEntry).toBeDefined();

    const account = await readFile(
      path.join(outCollab, "_astro", "authorbot-account.js"),
      "utf8",
    );
    const collab = await readFile(
      path.join(outCollab, "_astro", "authorbot-collab.js"),
      "utf8",
    );
    const planning = await readFile(
      path.join(outCollab, "_astro/authorbot-planning.js"),
      "utf8",
    );
    for (const [entry, js] of [
      ["authorbot-account.js", account],
      ["authorbot-collab.js", collab],
      ["authorbot-planning.js", planning],
    ] as const) {
      expect(js, entry).toContain("./assets/");
      expect(js, entry).not.toContain('"/assets/');
      expect(js, entry).not.toContain("'/assets/");
    }
    // Vite may emit entry-specific copies with different content hashes; the
    // important deployment contract is that each reference stays relative to
    // its stable entry and points at the intended split chunk.
    expect(account).toMatch(/\.\/assets\/project-store-[\w-]+\.js/);
    expect(account).not.toMatch(/\.\/assets\/work-queue-[\w-]+\.js/);
    expect(account).not.toMatch(/\.\/assets\/milkdown-manuscript-surface-[\w-]+\.js/);
    expect(collab).toMatch(/\.\/assets\/project-store-[\w-]+\.js/);
    expect(collab).toMatch(/\.\/assets\/revision-review-[\w-]+\.js/);
    expect(collab).toMatch(/\.\/assets\/chapter-history-entry-[\w-]+\.js/);
    expect(collab).toMatch(/\.\/assets\/work-queue-[\w-]+\.js/);
    expect(collab).toMatch(/\.\/assets\/manuscript-editor-element-[\w-]+\.js/);
    expect(planning).toMatch(/\.\/assets\/project-store-[\w-]+\.js/);
    expect(planning).toMatch(/\.\/assets\/milkdown-manuscript-surface-[\w-]+\.js/);
    expect(planning).not.toContain("ProseMirror");

    const historyEntryJs = await readFile(
      path.join(outCollab, "_astro", "assets", historyEntry!),
      "utf8",
    );
    expect(historyEntryJs).toMatch(/\.\/chapter-history-panel-[\w-]+\.js/);

    const manuscriptEntryJs = await readFile(
      path.join(outCollab, "_astro", "assets", manuscriptEntry!),
      "utf8",
    );
    expect(manuscriptEntryJs).toMatch(/\.\/milkdown-manuscript-surface-[\w-]+\.js/);

    const manuscriptJs = await readFile(
      path.join(outCollab, "_astro", "assets", manuscript!),
      "utf8",
    );
    expect(manuscriptJs).toContain("ProseMirror");
    expect(collab).not.toContain("The chapter cannot enter rich-text mode");
  });

  it("hydrates the home page with private authoring entry points (Phase 6 §3.5)", async () => {
    // §3.5 exists for "an author facing an empty book". Such a book has no
    // chapter pages, so the authoring entry point cannot live only there - the
    // home page has to carry it or the blank slate is a dead end. What the
    // home page must NOT gain is the annotation island: there is no prose on
    // it to annotate.
    const html = await readFile(path.join(outCollab, "index.html"), "utf8");
    expect(html).toContain("<authorbot-new-chapter");
    expect(html).toContain("<authorbot-draft-chapters");
    expect(html).toContain("<authorbot-chapter-activity");
    expect(html).toContain(
      'data-chapter-activity-id="019cadfd-8900-7140-98fb-ceff64cada33"',
    );
    expect(html).toContain("data-chapter-activity-slot");
    expect(html).toContain('data-href="/write/"');
    expect(html).not.toContain("<authorbot-collab");
    expect(html).toContain('<script type="module" src="/_astro/authorbot-collab.js">');

    // And the api-url-less build's home page stays exactly as it was.
    const plain = await readFile(path.join(outPlain, "index.html"), "utf8");
    expect(plain).not.toContain("<script");
    expect(plain).not.toContain("authorbot-new-chapter");
    expect(plain).not.toContain("authorbot-draft-chapters");
    expect(plain).not.toContain("authorbot-chapter-activity");
    expect(plain).not.toContain("data-chapter-activity-id");
    expect(plain).not.toContain("data-chapter-activity-slot");
  });

  it("marks the current chapter and every prev/next row for activity", async () => {
    const baseline = await readFile(
      path.join(outCollab, "chapters/baseline/index.html"),
      "utf8",
    );
    expect(baseline).toContain("<authorbot-chapter-activity");
    // Current chapter header.
    expect(baseline).toMatch(
      /<header class="chapter-header" data-chapter-activity-id="019cadfd-8900-7140-98fb-ceff64cada33">/,
    );
    // Next-chapter navigation row.
    expect(baseline).toMatch(
      /class="chapter-nav-next" data-chapter-activity-id="019d0bc2-a980-734d-b0c1-aa819448d107"/,
    );
    expect(baseline.match(/data-chapter-activity-slot/g)?.length).toBeGreaterThanOrEqual(2);

    const nullResults = await readFile(
      path.join(outCollab, "chapters/null-results/index.html"),
      "utf8",
    );
    // Previous-chapter navigation row on the following chapter.
    expect(nullResults).toMatch(
      /class="chapter-nav-prev" data-chapter-activity-id="019cadfd-8900-7140-98fb-ceff64cada33"/,
    );
  });

  it("mounts click-lazy chapter history with a chapter-only stylesheet", async () => {
    const chapter = await readFile(
      path.join(outCollab, "chapters/baseline/index.html"),
      "utf8",
    );
    expect(chapter).toContain("<authorbot-chapter-history");
    expect(chapter).toContain('data-chapter-id="019cadfd-8900-7140-98fb-ceff64cada33"');
    expect(chapter).toContain(
      '<link rel="stylesheet" href="/_astro/authorbot-history.css">',
    );

    const plain = await readFile(
      path.join(outPlain, "chapters/baseline/index.html"),
      "utf8",
    );
    expect(plain).not.toContain("authorbot-chapter-history");
    expect(plain).not.toContain("authorbot-history.css");

    const css = await readFile(path.join(outCollab, "_astro/authorbot-history.css"), "utf8");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("authorbot-chapter-history-panel[hidden]");
  });

  it("emits the /write/ and /settings/ pages only for a collab build", async () => {
    for (const [relPath, mount] of [
      ["write/index.html", "<authorbot-chapter-composer"],
      ["settings/index.html", "<authorbot-settings"],
    ] as const) {
      const page = await readFile(path.join(outCollab, relPath), "utf8");
      expect(page, relPath).toContain(mount);
      expect(page, relPath).toContain('<link rel="stylesheet" href="/_astro/authorbot-collab.css">');
      expect(page, relPath).toContain('<script type="module" src="/_astro/authorbot-collab.js">');
      expect(page, relPath).toContain(
        `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; ` +
          `connect-src 'self'; img-src 'self' data:">`,
      );
      await expect(stat(path.join(outPlain, relPath))).rejects.toThrow();
    }
  });

  it("emits the /work/ page with the work-queue island (Phase 3 contract §6)", async () => {
    const page = await readFile(path.join(outCollab, "work/index.html"), "utf8");
    // CSP + island stylesheet + bundle, like chapter pages.
    expect(page).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; ` +
        `connect-src 'self'; img-src 'self' data:">`,
    );
    expect(page).toContain('<link rel="stylesheet" href="/_astro/authorbot-collab.css">');
    expect(page).toContain('<link rel="stylesheet" href="/_astro/authorbot-work.css">');
    expect(page).toContain('<script type="module" src="/_astro/authorbot-collab.js">');
    // The mount carries the API config and a trusted chapter map.
    const mount = /<authorbot-work-queue[^>]*>/.exec(page)?.[0] ?? "";
    expect(mount).toContain(`data-api-base="${API_URL}"`);
    expect(mount).toContain('data-project="hollow-creek-anomaly"');
    expect(mount).toContain("data-chapters=");
    expect(mount).toContain("019cadfd-8900-7140-98fb-ceff64cada33"); // a chapter id in the map
    // Progressive-enhancement fallback text lives inside the mount.
    expect(page).toContain("The work queue loads here once JavaScript is enabled.");
    expect(page).toContain("What needs doing");
    expect(page).toContain("A valid submission commits immediately");
    expect(page).not.toContain("until it passes review");
    expect(page).toContain("ab-work-icon-pencil");
    expect(page).not.toMatch(/<[^>]+style=/);
  });

  it("keeps the work stylesheet off every non-work page", async () => {
    for (const file of await collectFiles(outCollab)) {
      if (!file.endsWith(".html") || file.endsWith(path.join("work", "index.html"))) continue;
      const html = await readFile(file, "utf8");
      expect(html, file).not.toContain("authorbot-work.css");
    }
  });

  it("keeps the page-only work stylesheet inside an 8 KB gzip budget", async () => {
    const css = await readFile(path.join(outCollab, "_astro/authorbot-work.css"));
    expect(css.toString("utf8")).toContain(".work-page");
    expect(gzipSync(css).length).toBeLessThanOrEqual(8 * 1024);
  });

  it("plain build emits no /work/ page (script-free regression)", async () => {
    await expect(stat(path.join(outPlain, "work/index.html"))).rejects.toThrow();
  });

  it("emits a page-only /revisions/ review surface for collaboration builds", async () => {
    const page = await readFile(path.join(outCollab, "revisions/index.html"), "utf8");
    expect(page).toContain("<authorbot-revision-review");
    expect(page).toContain(`data-api-base="${API_URL}"`);
    expect(page).toContain('data-project="hollow-creek-anomaly"');
    expect(page).toContain('data-base="/"');
    expect(page).toContain('<link rel="stylesheet" href="/_astro/authorbot-collab.css">');
    expect(page).toContain('<link rel="stylesheet" href="/_astro/authorbot-revisions.css">');
    expect(page).toContain('<script type="module" src="/_astro/authorbot-collab.js">');
    expect(page).toContain("Compare the complete before and after text");
    expect(page).not.toMatch(/<[^>]+style=/);
    await expect(stat(path.join(outPlain, "revisions/index.html"))).rejects.toThrow();

    for (const file of await collectFiles(outCollab)) {
      if (!file.endsWith(".html") || file.endsWith(path.join("revisions", "index.html"))) {
        continue;
      }
      expect(await readFile(file, "utf8"), file).not.toContain("authorbot-revisions.css");
    }
  });

  it("ships the bundle within the 35 KB gzipped budget (contract §1)", async () => {
    const js = await readFile(path.join(outCollab, "_astro/authorbot-collab.js"));
    const css = await readFile(path.join(outCollab, "_astro/authorbot-collab.css"));
    const total = gzipSync(js).length + gzipSync(css).length;
    expect(total).toBeLessThanOrEqual(35 * 1024);
    expect((await stat(path.join(outCollab, "_astro/authorbot-collab.js"))).size).toBeGreaterThan(0);
  });

  it("bundle defines the custom element and never uses innerHTML for content", async () => {
    const js = await readFile(path.join(outCollab, "_astro/authorbot-collab.js"), "utf8");
    expect(js).toContain("authorbot-collab");
    // §3: bodies render as plain text; the bundle must not assign innerHTML.
    expect(js).not.toContain("innerHTML");
  });

  /**
   * Phase 7's access-control surface (collaborator table, agent tokens, audit
   * view, moderation queue) is maintainer-only, so it ships as its OWN bundle
   * loaded only by /settings/. These assertions are what keep it that way: the
   * chapter-page budget above stays a real constraint only if this code cannot
   * quietly migrate into it.
   */
  describe("Phase 7 access-control bundle", () => {
    it("is a separate bundle, loaded by /settings/ and by nothing else", async () => {
      const settings = await readFile(path.join(outCollab, "settings/index.html"), "utf8");
      expect(settings).toContain("<authorbot-access");
      // Asset hrefs follow the SITE's base path (unset here), not the API
      // base - the two are independent halves of a deployment (ADR-0019 §6).
      expect(settings).toContain('<script type="module" src="/_astro/authorbot-access.js">');
      expect(settings).toContain('<script type="module" src="/_astro/authorbot-settings.js">');
      expect(settings).toContain('<link rel="stylesheet" href="/_astro/authorbot-access.css">');
      expect(settings).toContain('<link rel="stylesheet" href="/_astro/authorbot-settings.css">');
      // The mount still carries the API base the islands must call.
      expect(settings).toContain(`<authorbot-access data-api-base="${API_URL}"`);

      // Every other emitted page, chapter pages included, must not carry it.
      for (const file of await collectFiles(outCollab)) {
        if (!file.endsWith(".html") || file.endsWith(path.join("settings", "index.html"))) continue;
        const html = await readFile(file, "utf8");
        expect(html, file).not.toContain("authorbot-access");
        expect(html, file).not.toContain("authorbot-settings.css");
        expect(html, file).not.toContain("authorbot-settings.js");
      }
    });

    it("keeps the maintainer surface out of the chapter-page budget", async () => {
      const chapter = await readFile(
        path.join(outCollab, "chapters/baseline/index.html"),
        "utf8",
      );
      expect(chapter).not.toContain("authorbot-access");
      // And the collaboration bundle itself contains none of the Phase 7 view:
      // a stray import would put the moderation queue in every reader's page.
      const collabJs = await readFile(path.join(outCollab, "_astro/authorbot-collab.js"), "utf8");
      expect(collabJs).not.toContain("authorbot-access");
      expect(collabJs).not.toContain("Removing someone is not erasing them");
    });

    it("has its own gzipped budget and never uses innerHTML", async () => {
      const js = await readFile(path.join(outCollab, "_astro/authorbot-access.js"), "utf8");
      const css = await readFile(path.join(outCollab, "_astro/authorbot-access.css"), "utf8");
      expect(js).toContain("authorbot-access");
      // Untrusted annotation bodies reach this surface; plain text only.
      expect(js).not.toContain("innerHTML");
      const total = gzipSync(Buffer.from(js)).length + gzipSync(Buffer.from(css)).length;
      // Generous next to the reading bundle's 35 KB because this is one page
      // loaded by one maintainer - but bounded, so it cannot grow unwatched.
      expect(total).toBeLessThanOrEqual(20 * 1024);
    });

    it("carries the contract's non-negotiable revocation sentence", async () => {
      // The interface "must not imply" that removing someone erases them, so
      // the sentence that says otherwise has to survive minification into the
      // shipped artifact rather than living only in a source comment.
      const js = await readFile(path.join(outCollab, "_astro/authorbot-access.js"), "utf8");
      expect(js).toContain("Removing someone is not erasing them");
      // And `locked` must never be described as switching collaboration off.
      expect(js).toContain("Author only");
    });
  });

  describe("Settings console bundle", () => {
    it("keeps settings behavior and styling on /settings/ only", async () => {
      const js = await readFile(path.join(outCollab, "_astro/authorbot-settings.js"), "utf8");
      const css = await readFile(path.join(outCollab, "_astro/authorbot-settings.css"), "utf8");
      const collabJs = await readFile(path.join(outCollab, "_astro/authorbot-collab.js"), "utf8");
      expect(js).toContain("authorbot-settings");
      expect(js).not.toContain("innerHTML");
      expect(css).toContain("settings-console");
      expect(collabJs).not.toContain("authorbot-settings");
      expect(gzipSync(Buffer.from(js)).length + gzipSync(Buffer.from(css)).length).toBeLessThanOrEqual(
        24 * 1024,
      );
    });
  });
});

describe("resolveCollab", () => {
  const book = (publication: Record<string, unknown> | undefined): BookConfig =>
    ({
      schema: "authorbot.book/v1",
      id: "019c46c7-6a80-7bb3-a312-466834c8f96d",
      title: "T",
      slug: "t-slug",
      language: "en",
      ...(publication !== undefined ? { publication } : {}),
    }) as BookConfig;

  it("is null without any API url (script-free default)", () => {
    expect(resolveCollab(book(undefined), {})).toBeNull();
    expect(resolveCollab(book({}), {})).toBeNull();
  });

  it("reads publication.api_url as the durable form", () => {
    const collab = resolveCollab(book({ api_url: "/my-book/" }), {});
    expect(collab).toEqual({
      apiBase: "/my-book",
      projectSlug: "t-slug",
      showPublicAnnotations: false,
      devLogin: false,
    });
  });

  it("lets --api-url override book.yml", () => {
    const collab = resolveCollab(book({ api_url: "/durable" }), { apiUrl: "/override" });
    expect(collab?.apiBase).toBe("/override");
  });

  it("accepts a multi-segment base path (ADR-0019 §6)", () => {
    expect(resolveCollab(book(undefined), { apiUrl: "/books/hollow-creek/" })?.apiBase).toBe(
      "/books/hollow-creek",
    );
  });

  it('accepts "/" as API-at-origin-root: empty base', () => {
    for (const apiUrl of ["/", "//"]) {
      expect(resolveCollab(book(undefined), { apiUrl })?.apiBase).toBe("");
    }
    expect(resolveCollab(book({ api_url: "/" }), {})?.apiBase).toBe("");
  });

  it("carries show_public_annotations and the dev-login flag", () => {
    const collab = resolveCollab(
      book({ api_url: "/my-book", show_public_annotations: true }),
      { devLogin: true },
    );
    expect(collab?.showPublicAnnotations).toBe(true);
    expect(collab?.devLogin).toBe(true);
  });

  it("rejects an absolute http(s) URL at build time, naming ADR-0019", () => {
    for (const apiUrl of [
      "https://api.example.com",
      "http://127.0.0.1:8787",
      "https://api.example.com/my-book",
    ]) {
      expect(() => resolveCollab(book(undefined), { apiUrl })).toThrow(PublisherError);
      expect(() => resolveCollab(book(undefined), { apiUrl })).toThrow(/ADR-0019/);
    }
    // The durable form is checked identically - a book.yml that predates
    // ADR-0019 fails the build rather than publishing a site whose every
    // collaboration call is blocked by the browser.
    expect(() => resolveCollab(book({ api_url: "https://api.example.com" }), {})).toThrow(
      /ADR-0019/,
    );
  });

  it("rejects other non-root-relative values", () => {
    for (const apiUrl of [
      "ftp://x",
      "api.example.com",
      "//evil.example",
      "/my-book?x=1",
      "/my-book#frag",
      "/../etc",
      "/my//book",
      "/my book",
    ]) {
      expect(() => resolveCollab(book(undefined), { apiUrl }), apiUrl).toThrow(PublisherError);
    }
  });
});

/**
 * Regression (ADR-0019 §6, phase 6 exit criterion 9: "a book deployed under a
 * base path works end to end").
 *
 * Astro's `base` rewrites the URLs it WRITES; it does not move the files those
 * URLs point at. So a base-path build emitted `index.html` and `_astro/` at the
 * root of `_site` while every link pointed at `/my-book/…`. Cloudflare Workers
 * static assets resolve a request path directly against that tree
 * (`"assets": { "directory": "./_site" }`), so every one of those links 404'd
 * and only an unlinked root copy was reachable - the site published broken.
 *
 * The property that matters is not "the output is nested" but "every emitted
 * link resolves to a file that exists", so that is what this asserts.
 */
describe("base-path builds are deployable (ADR-0019 §6)", () => {
  let outBase: string;

  beforeAll(async () => {
    outBase = await mkdtemp(path.join(os.tmpdir(), "authorbot-basepath-"));
    tempDirs.push(outBase);
    await buildSite({
      repoPath: exampleRepo,
      outDir: outBase,
      baseUrl: "/my-book",
      logLevel: "error",
    });
  });

  it("emits the site under the base path, where the links point", async () => {
    await expect(stat(path.join(outBase, "my-book", "index.html"))).resolves.toBeTruthy();
    await expect(
      stat(path.join(outBase, "my-book", "chapters", "baseline", "index.html")),
    ).resolves.toBeTruthy();
  });

  it("resolves every root-relative link and asset to a file that exists", async () => {
    const files = new Set(rel(outBase, await collectFiles(outBase)).map((f) => f.split(path.sep).join("/")));
    const pages = [...files].filter((f) => f.endsWith(".html"));
    expect(pages.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const page of pages) {
      const html = await readFile(path.join(outBase, page), "utf8");
      const refs = [...html.matchAll(/(?:href|src)="(\/[^"#?]*)"/g)].map((m) => m[1] ?? "");
      for (const ref of refs) {
        // A directory-format URL (`/my-book/chapters/x/`) is served by its
        // `index.html`; anything else is a file request.
        const target = `${ref.replace(/^\//, "")}${ref.endsWith("/") ? "index.html" : ""}`;
        if (target !== "" && !files.has(target)) missing.push(`${page} -> ${ref}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("leaves the build manifest at the output root for CI to read", async () => {
    await expect(stat(path.join(outBase, "authorbot-build.json"))).resolves.toBeTruthy();
  });

  it("still emits at the root when no base path is configured", async () => {
    await expect(stat(path.join(outPlain, "index.html"))).resolves.toBeTruthy();
  });
});
