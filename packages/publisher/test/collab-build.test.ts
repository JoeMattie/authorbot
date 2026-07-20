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

const API_URL = "http://127.0.0.1:8787";

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
      expect(html, file).not.toContain("Content-Security-Policy");
      expect(html, file).not.toContain("<authorbot-collab");
    }
  });

  it("differs from a collab build only by the island additions (byte-comparable)", async () => {
    const plainFiles = rel(outPlain, await collectFiles(outPlain));
    const collabFiles = rel(outCollab, await collectFiles(outCollab));
    // The collab build adds exactly the two island assets.
    expect(collabFiles.filter((file) => !plainFiles.includes(file))).toEqual([
      path.join("_astro", "authorbot-collab.css"),
      path.join("_astro", "authorbot-collab.js"),
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
      if (file.endsWith(".html") && file.startsWith("chapters" + path.sep)) {
        // Strip the four island insertions; the remainder must be identical
        // (inter-tag whitespace normalized on both sides, since removing the
        // conditional template expressions also removes their surrounding
        // template whitespace).
        collab = collab
          .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
          .replace(/<link rel="stylesheet" href="[^"]*authorbot-collab\.css">/, "")
          .replace(/<authorbot-collab[^>]*>\s*<\/authorbot-collab>/, "")
          .replace(/<script type="module" src="[^"]*authorbot-collab\.js"><\/script>/, "")
          .replace(/>\s+</g, "> <");
        plain = plain.replace(/>\s+</g, "> <");
      }
      expect(collab, file).toBe(plain);
    }
  });
});

describe("collab-enabled build", () => {
  it("emits the CSP meta tag on chapter pages (contract §3)", async () => {
    const page = await readFile(path.join(outCollab, "chapters/baseline/index.html"), "utf8");
    expect(page).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; ` +
        `connect-src 'self' ${API_URL}; img-src 'self' data:">`,
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

  it("keeps non-chapter pages script-free (islands hydrate chapter pages only)", async () => {
    for (const relPath of [
      "index.html",
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
    const collab = resolveCollab(book({ api_url: "https://api.example.com/" }), {});
    expect(collab).toEqual({
      apiBase: "https://api.example.com",
      apiOrigin: "https://api.example.com",
      projectSlug: "t-slug",
      showPublicAnnotations: false,
      devLogin: false,
    });
  });

  it("lets --api-url override book.yml", () => {
    const collab = resolveCollab(book({ api_url: "https://durable.example.com" }), {
      apiUrl: "http://127.0.0.1:8787",
    });
    expect(collab?.apiBase).toBe("http://127.0.0.1:8787");
    expect(collab?.apiOrigin).toBe("http://127.0.0.1:8787");
  });

  it("treats a root-relative path as same-origin (no extra CSP origin)", () => {
    const collab = resolveCollab(book(undefined), { apiUrl: "/api/" });
    expect(collab?.apiBase).toBe("/api");
    expect(collab?.apiOrigin).toBeNull();
  });

  it('accepts "/" as API-at-origin-root: empty base, no extra CSP origin', () => {
    for (const apiUrl of ["/", "//"]) {
      const collab = resolveCollab(book(undefined), { apiUrl });
      expect(collab?.apiBase).toBe("");
      expect(collab?.apiOrigin).toBeNull();
    }
    const durable = resolveCollab(book({ api_url: "/" }), {});
    expect(durable?.apiBase).toBe("");
  });

  it("carries show_public_annotations and the dev-login flag", () => {
    const collab = resolveCollab(
      book({ api_url: "https://api.example.com", show_public_annotations: true }),
      { devLogin: true },
    );
    expect(collab?.showPublicAnnotations).toBe(true);
    expect(collab?.devLogin).toBe(true);
  });

  it("rejects a non-root-relative, non-http value", () => {
    expect(() => resolveCollab(book(undefined), { apiUrl: "ftp://x" })).toThrow(PublisherError);
    expect(() => resolveCollab(book(undefined), { apiUrl: "api.example.com" })).toThrow(
      PublisherError,
    );
  });
});
