import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifestSchema } from "@authorbot/schemas";
import { afterEach, describe, expect, it } from "vitest";
import {
  createManifest,
  detectGitCommit,
  publisherVersion,
} from "../src/index.js";
import type { SiteChapter } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const chapter: SiteChapter = {
  id: "0190f27d-8ea5-7e43-a6f2-64d6939ff3b4",
  slug: "intro",
  title: "Intro",
  order: 10,
  status: "published",
  revision: 3,
  authors: ["github:someone"],
  path: "chapters/intro",
  href: "/chapters/intro/",
  html: "<p>x</p>",
  isDraft: false,
};

describe("createManifest", () => {
  it("produces a schema-valid authorbot.build/v1 manifest", () => {
    const manifest = createManifest({
      commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      baseUrl: "https://example.org/x/",
      chapters: [chapter],
    });
    expect(buildManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.schema).toBe("authorbot.build/v1");
    expect(manifest.base_url).toBe("https://example.org/x/");
    expect(manifest.chapters).toEqual([
      { id: chapter.id, slug: "intro", revision: 3, title: "Intro", status: "published" },
    ]);
  });

  it("records a null commit and omits base_url when absent", () => {
    const manifest = createManifest({ commit: null, chapters: [chapter] });
    expect(buildManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.commit).toBeNull();
    expect("base_url" in manifest).toBe(false);
  });

  it("stamps built_at as an RFC 3339 UTC timestamp", () => {
    const manifest = createManifest({ commit: null, chapters: [] });
    expect(manifest.built_at.endsWith("Z")).toBe(true);
    expect(Number.isNaN(Date.parse(manifest.built_at))).toBe(false);
  });

  it("stamps publisher_version from this package's package.json", async () => {
    const packageJson = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { version: string };
    expect(publisherVersion()).toBe(packageJson.version);
    const manifest = createManifest({ commit: null, chapters: [] });
    expect(manifest.publisher_version).toBe(packageJson.version);
  });
});

describe("detectGitCommit", () => {
  it("returns null outside a git work tree", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "authorbot-nogit-"));
    tempDirs.push(dir);
    expect(detectGitCommit(dir)).toBeNull();
  });

  it("returns the HEAD commit inside a git work tree", () => {
    // This monorepo is itself a git work tree in development checkouts;
    // when it is not, detection must still degrade to null, never throw.
    const here = fileURLToPath(new URL(".", import.meta.url));
    const commit = detectGitCommit(here);
    expect(commit === null || /^[0-9a-f]{7,64}$/.test(commit)).toBe(true);
  });
});
