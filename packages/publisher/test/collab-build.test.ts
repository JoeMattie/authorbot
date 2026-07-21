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
 * today — zero JavaScript, no collaboration artifacts, byte-comparable pages —
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
   * two page types that inject author-supplied markup with `set:html` — the
   * chapter page of an api-url-less build, and every character page — shipped
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
    // exist only when an API base is configured: /work/ (Phase 3 contract §6)
    // and, from Phase 6, /settings/ (§3.6) and /write/ (§3.5). Each is gated
    // by `getStaticPaths` returning nothing without collab, which is what
    // keeps the api-url-less build byte-identical rather than merely similar.
    //
    // `authorbot-access.*` is Phase 7's maintainer surface, bundled apart from
    // the collaboration islands so no reader's chapter page carries it.
    expect(collabFiles.filter((file) => !plainFiles.includes(file))).toEqual([
      path.join("_astro", "authorbot-access.css"),
      path.join("_astro", "authorbot-access.js"),
      path.join("_astro", "authorbot-collab.css"),
      path.join("_astro", "authorbot-collab.js"),
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
        // invariant that still matters — and that the sibling test asserts —
        // is that the api-url-less build stays byte-identically script-free;
        // a collab build was always allowed to differ by exactly the islands.
        // The CSP meta is stripped from BOTH sides now: prose pages emit it in
        // either build (design §19.4), so it is no longer an island insertion,
        // while the island-only pages still add one the plain build lacks.
        collab = collab
          .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
          .replace(/<link rel="stylesheet" href="[^"]*authorbot-collab\.css">/, "")
          .replace(/<authorbot-collab[^>]*>\s*<\/authorbot-collab>/, "")
          .replace(/<authorbot-new-chapter[^>]*>\s*<\/authorbot-new-chapter>/, "")
          .replace(/<authorbot-chapter-composer[^>]*>[\s\S]*?<\/authorbot-chapter-composer>/, "")
          .replace(/<script type="module" src="[^"]*authorbot-collab\.js"><\/script>/, "")
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

  it("keeps the story pages script-free (islands hydrate only where they do something)", async () => {
    // The story views are pure reading surfaces with no collaboration
    // affordance, so they carry no bundle even in a collab build.
    for (const relPath of [
      "story/index.html",
      "story/timeline/index.html",
      "story/characters/index.html",
      "story/characters/mara-voss/index.html",
    ]) {
      const html = await readFile(path.join(outCollab, relPath), "utf8");
      expect(html, relPath).not.toContain("<script");
      expect(html, relPath).not.toContain("authorbot-collab");
    }
  });

  it("hydrates the home page with the New chapter entry point only (Phase 6 §3.5)", async () => {
    // §3.5 exists for "an author facing an empty book". Such a book has no
    // chapter pages, so the authoring entry point cannot live only there — the
    // home page has to carry it or the blank slate is a dead end. What the
    // home page must NOT gain is the annotation island: there is no prose on
    // it to annotate.
    const html = await readFile(path.join(outCollab, "index.html"), "utf8");
    expect(html).toContain("<authorbot-new-chapter");
    expect(html).toContain('data-href="/write/"');
    expect(html).not.toContain("<authorbot-collab");
    expect(html).toContain('<script type="module" src="/_astro/authorbot-collab.js">');

    // And the api-url-less build's home page stays exactly as it was.
    const plain = await readFile(path.join(outPlain, "index.html"), "utf8");
    expect(plain).not.toContain("<script");
    expect(plain).not.toContain("authorbot-new-chapter");
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
    expect(page).toContain('<script type="module" src="/_astro/authorbot-collab.js">');
    // The mount carries the API config and a trusted chapter map.
    const mount = /<authorbot-work-queue[^>]*>/.exec(page)?.[0] ?? "";
    expect(mount).toContain(`data-api-base="${API_URL}"`);
    expect(mount).toContain('data-project="hollow-creek-anomaly"');
    expect(mount).toContain("data-chapters=");
    expect(mount).toContain("019cadfd-8900-7140-98fb-ceff64cada33"); // a chapter id in the map
    // Progressive-enhancement fallback text lives inside the mount.
    expect(page).toContain("The work queue loads here once JavaScript is enabled.");
  });

  it("plain build emits no /work/ page (script-free regression)", async () => {
    await expect(stat(path.join(outPlain, "work/index.html"))).rejects.toThrow();
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
      // base — the two are independent halves of a deployment (ADR-0019 §6).
      expect(settings).toContain('<script type="module" src="/_astro/authorbot-access.js">');
      expect(settings).toContain('<link rel="stylesheet" href="/_astro/authorbot-access.css">');
      // The mount still carries the API base the islands must call.
      expect(settings).toContain(`<authorbot-access data-api-base="${API_URL}"`);

      // Every other emitted page, chapter pages included, must not carry it.
      for (const file of await collectFiles(outCollab)) {
        if (!file.endsWith(".html") || file.endsWith(path.join("settings", "index.html"))) continue;
        const html = await readFile(file, "utf8");
        expect(html, file).not.toContain("authorbot-access");
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
      // loaded by one maintainer — but bounded, so it cannot grow unwatched.
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
    // The durable form is checked identically — a book.yml that predates
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
 * and only an unlinked root copy was reachable — the site published broken.
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
