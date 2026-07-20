import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  basePathOf,
  chapterRoutePath,
  loadSiteModel,
  PublisherError,
} from "../src/index.js";

const BOOK_ID = "0190f27c-6e65-7ca5-a596-9f093d577aba";
const CH = [
  "0190f27d-8ea5-7e43-a6f2-64d6939ff3b4",
  "0190f300-2f7e-7467-b288-5e3c5a4bd991",
  "0190f301-7045-7b2d-9d91-95b3c8228b54",
  "0190f302-1111-7abc-8def-000000000001",
] as const;
const BLOCK = "0190f27e-1a93-7b61-996a-9f94849d27a8";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface ChapterSpec {
  id: string;
  slug: string;
  order: number;
  status: string;
  title?: string;
  /** File name override (defaults to `<slug>.md`). */
  file?: string;
}

async function makeRepo(chapters: ChapterSpec[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "authorbot-publisher-"));
  tempDirs.push(dir);
  await writeFile(
    path.join(dir, "book.yml"),
    [
      "schema: authorbot.book/v1",
      `id: ${BOOK_ID}`,
      "title: Test Book",
      "slug: test-book",
      "language: en",
      "",
    ].join("\n"),
  );
  await mkdir(path.join(dir, "chapters"), { recursive: true });
  for (const chapter of chapters) {
    await writeFile(
      path.join(dir, "chapters", chapter.file ?? `${chapter.slug}.md`),
      [
        "---",
        "schema: authorbot.chapter/v1",
        `id: ${chapter.id}`,
        `slug: ${chapter.slug}`,
        `title: ${chapter.title ?? chapter.slug}`,
        `order: ${chapter.order}`,
        `status: ${chapter.status}`,
        "revision: 1",
        "authors:",
        "  - actor: github:someone",
        "---",
        "",
        `<!-- authorbot:block id="${BLOCK}" -->`,
        `Prose of ${chapter.slug}.`,
        "",
      ].join("\n"),
    );
  }
  return dir;
}

describe("loadSiteModel — chapter selection and ordering", () => {
  it("includes only published chapters by default, sorted by order", async () => {
    const repo = await makeRepo([
      { id: CH[0], slug: "third", order: 30, status: "published" },
      { id: CH[1], slug: "first", order: 10, status: "published" },
      { id: CH[2], slug: "second", order: 20, status: "published" },
    ]);
    const { model } = await loadSiteModel({ repoPath: repo });
    expect(model.chapters.map((chapter) => chapter.slug)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("excludes draft and proposed chapters by default", async () => {
    const repo = await makeRepo([
      { id: CH[0], slug: "pub", order: 10, status: "published" },
      { id: CH[1], slug: "dra", order: 20, status: "draft" },
      { id: CH[2], slug: "pro", order: 30, status: "proposed" },
    ]);
    const { model } = await loadSiteModel({ repoPath: repo });
    expect(model.chapters.map((chapter) => chapter.slug)).toEqual(["pub"]);
    expect(model.chapters[0]?.isDraft).toBe(false);
  });

  it("adds draft and proposed chapters with includeDrafts, flagged as drafts", async () => {
    const repo = await makeRepo([
      { id: CH[0], slug: "pub", order: 10, status: "published" },
      { id: CH[1], slug: "dra", order: 20, status: "draft" },
      { id: CH[2], slug: "pro", order: 30, status: "proposed" },
    ]);
    const { model } = await loadSiteModel({ repoPath: repo, includeDrafts: true });
    expect(model.chapters.map((chapter) => chapter.slug)).toEqual([
      "pub",
      "dra",
      "pro",
    ]);
    expect(model.chapters.map((chapter) => chapter.isDraft)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("never includes archived chapters, even with includeDrafts", async () => {
    const repo = await makeRepo([
      { id: CH[0], slug: "pub", order: 10, status: "published" },
      { id: CH[1], slug: "old", order: 20, status: "archived" },
    ]);
    const { model } = await loadSiteModel({ repoPath: repo, includeDrafts: true });
    expect(model.chapters.map((chapter) => chapter.slug)).toEqual(["pub"]);
  });

  it("skips schema-invalid chapters with a warning", async () => {
    const repo = await makeRepo([
      { id: CH[0], slug: "pub", order: 10, status: "published" },
    ]);
    await writeFile(
      path.join(repo, "chapters", "broken.md"),
      "---\nschema: authorbot.chapter/v1\n---\n\nNo real frontmatter.\n",
    );
    const { model, warnings } = await loadSiteModel({ repoPath: repo });
    expect(model.chapters.map((chapter) => chapter.slug)).toEqual(["pub"]);
    expect(warnings.some((warning) => warning.includes("broken.md"))).toBe(true);
  });

  it("renders chapter prose with block anchors and strips markers", async () => {
    const repo = await makeRepo([
      { id: CH[0], slug: "pub", order: 10, status: "published" },
    ]);
    const { model } = await loadSiteModel({ repoPath: repo });
    expect(model.chapters[0]?.html).toContain(`<p id="b-${BLOCK}">Prose of pub.</p>`);
    expect(model.chapters[0]?.html).not.toContain("authorbot:block");
  });

  it("derives hrefs from publication.chapter_url and the base path", async () => {
    const repo = await makeRepo([
      { id: CH[0], slug: "pub", order: 10, status: "published" },
    ]);
    const { model } = await loadSiteModel({
      repoPath: repo,
      baseUrl: "https://example.org/books/test/",
    });
    expect(model.basePath).toBe("/books/test/");
    expect(model.chapters[0]?.path).toBe("chapters/pub");
    expect(model.chapters[0]?.href).toBe("/books/test/chapters/pub/");
  });

  it("throws PublisherError when book.yml is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "authorbot-publisher-"));
    tempDirs.push(dir);
    await expect(loadSiteModel({ repoPath: dir })).rejects.toThrow(PublisherError);
  });
});

describe("basePathOf", () => {
  it("defaults to /", () => {
    expect(basePathOf(undefined)).toBe("/");
    expect(basePathOf("")).toBe("/");
  });

  it("takes the path of a full URL", () => {
    expect(basePathOf("https://example.org/books/x")).toBe("/books/x/");
    expect(basePathOf("https://example.org")).toBe("/");
  });

  it("normalizes bare paths", () => {
    expect(basePathOf("books/x")).toBe("/books/x/");
    expect(basePathOf("/books/x/")).toBe("/books/x/");
  });
});

describe("chapterRoutePath", () => {
  it("expands {slug} and trims slashes", () => {
    expect(chapterRoutePath("/chapters/{slug}/", "intro")).toBe("chapters/intro");
    expect(chapterRoutePath("read/{slug}", "intro")).toBe("read/intro");
  });

  it("rejects traversal and unsafe segments", () => {
    expect(() => chapterRoutePath("/../{slug}/", "intro")).toThrow(PublisherError);
    expect(() => chapterRoutePath("/chapters/.hidden/{slug}/", "x")).toThrow(
      PublisherError,
    );
    expect(() => chapterRoutePath("//", "x")).toThrow(PublisherError);
  });

  it("requires the pattern to contain {slug}", () => {
    // Regression: a {slug}-less pattern collapsed every chapter onto one
    // route; Astro deduped them and all but one chapter silently vanished
    // while the manifest still listed them all.
    expect(() => chapterRoutePath("/chapters/all/", "intro")).toThrow(
      /does not contain \{slug\}/,
    );
    expect(() => chapterRoutePath("/read/", "intro")).toThrow(PublisherError);
  });

  it("rejects routes under the publisher's reserved static paths", () => {
    // Regression: /story/{slug}/ with a chapter slugged "timeline" was
    // silently shadowed by the static timeline page.
    expect(() => chapterRoutePath("/story/{slug}/", "timeline")).toThrow(
      /reserved path "story\/"/,
    );
    expect(() => chapterRoutePath("/{slug}/", "story")).toThrow(/reserved path/);
    expect(() => chapterRoutePath("/_astro/{slug}/", "x")).toThrow(PublisherError);
    // Non-reserved neighbours stay allowed.
    expect(chapterRoutePath("/story-notes/{slug}/", "x")).toBe("story-notes/x");
    expect(chapterRoutePath("/{slug}/", "stories")).toBe("stories");
  });
});

describe("loadSiteModel — route collisions (hard errors even under --force)", () => {
  it("throws when two chapters expand to the same route", async () => {
    const repo = await makeRepo([
      { id: CH[0], slug: "same", order: 10, status: "published", file: "a.md" },
      { id: CH[1], slug: "same", order: 20, status: "published", file: "b.md" },
    ]);
    await expect(loadSiteModel({ repoPath: repo })).rejects.toThrow(/same route/);
  });

  it("throws when a chapter's route would shadow a story view", async () => {
    const repo = await makeRepo([
      { id: CH[0], slug: "timeline", order: 10, status: "published" },
    ]);
    await writeFile(
      path.join(repo, "book.yml"),
      [
        "schema: authorbot.book/v1",
        `id: ${BOOK_ID}`,
        "title: Test Book",
        "slug: test-book",
        "language: en",
        "publication:",
        "  chapter_url: /story/{slug}/",
        "",
      ].join("\n"),
    );
    await expect(loadSiteModel({ repoPath: repo })).rejects.toThrow(/reserved path/);
  });
});

describe("loadSiteModel — unpublished chapters stay out of the story views", () => {
  async function makeStoryRepo(): Promise<string> {
    const repo = await makeRepo([
      { id: CH[0], slug: "pub", order: 10, status: "published", title: "Public Chapter" },
      { id: CH[1], slug: "dra", order: 20, status: "draft", title: "Secret Title" },
    ]);
    await mkdir(path.join(repo, "story"), { recursive: true });
    await writeFile(
      path.join(repo, "story", "outline.yml"),
      [
        "schema: authorbot.story-graph/v1",
        "nodes:",
        "  - id: premise:main",
        "    type: premise",
        "    title: Premise",
        "    order: 1",
        "  - id: chapter:pub",
        "    type: chapter",
        `    chapter_id: ${CH[0]}`,
        "    parent: premise:main",
        "    order: 2",
        "  - id: chapter:dra",
        "    type: chapter",
        "    title: Secret Node Title",
        `    chapter_id: ${CH[1]}`,
        "    parent: premise:main",
        "    order: 3",
        "  - id: scene:secret-reveal",
        "    type: scene",
        "    title: Secret scene reveal",
        "    parent: chapter:dra",
        "    order: 4",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(repo, "story", "timeline.yml"),
      [
        "schema: authorbot.timeline/v1",
        "events:",
        "  - id: event:public-event",
        "    sort_key: 1",
        "    display_time: Day 1",
        "    title: A public event",
        "    chapter_refs:",
        `      - ${CH[0]}`,
        "  - id: event:secret-event",
        "    sort_key: 2",
        "    display_time: Day 2",
        "    title: Secret reveal happens",
        "    chapter_refs:",
        `      - ${CH[1]}`,
        "  - id: event:world-event",
        "    sort_key: 3",
        "    display_time: Day 3",
        "    title: A worldbuilding event",
        "",
      ].join("\n"),
    );
    return repo;
  }

  it("omits draft chapter nodes, their scenes, and draft-only events by default", async () => {
    // Regression: the outline rendered excluded chapters' nodes and scenes,
    // and the timeline leaked excluded chapters' frontmatter titles.
    const repo = await makeStoryRepo();
    const { model } = await loadSiteModel({ repoPath: repo });
    const outlineFlat = JSON.stringify(model.outline);
    expect(outlineFlat).toContain("Public Chapter");
    expect(outlineFlat).not.toContain("Secret");
    expect(model.timeline?.events.map((event) => event.id)).toEqual([
      "event:public-event",
      "event:world-event",
    ]);
    expect(JSON.stringify(model.timeline)).not.toContain("Secret");
  });

  it("shows them again with includeDrafts", async () => {
    const repo = await makeStoryRepo();
    const { model } = await loadSiteModel({ repoPath: repo, includeDrafts: true });
    const outlineFlat = JSON.stringify(model.outline);
    expect(outlineFlat).toContain("Secret Node Title");
    expect(outlineFlat).toContain("Secret scene reveal");
    expect(model.timeline?.events.map((event) => event.id)).toEqual([
      "event:public-event",
      "event:secret-event",
      "event:world-event",
    ]);
  });
});

describe("loadSiteModel — outline parent cycles", () => {
  it("renders cycle members as top-level entries and warns", async () => {
    // Regression: a parent cycle made every member unreachable from a root
    // and the outline page silently rendered empty.
    const repo = await makeRepo([
      { id: CH[0], slug: "pub", order: 10, status: "published" },
    ]);
    await mkdir(path.join(repo, "story"), { recursive: true });
    await writeFile(
      path.join(repo, "story", "outline.yml"),
      [
        "schema: authorbot.story-graph/v1",
        "nodes:",
        "  - id: premise:main",
        "    type: premise",
        "    title: Premise",
        "    parent: part:one",
        "    order: 1",
        "  - id: part:one",
        "    type: part",
        "    title: Part One",
        "    parent: premise:main",
        "    order: 2",
        "",
      ].join("\n"),
    );
    const { model, warnings } = await loadSiteModel({ repoPath: repo });
    expect(warnings.some((warning) => warning.includes("parent cycle"))).toBe(true);
    const flat = JSON.stringify(model.outline);
    expect(flat).toContain("premise:main");
    expect(flat).toContain("part:one");
  });
});

describe("loadSiteModel — duplicate character ids", () => {
  it("keeps the first record and warns about the duplicate", async () => {
    // Regression: the second record silently replaced the first's page.
    const repo = await makeRepo([
      { id: CH[0], slug: "pub", order: 10, status: "published" },
    ]);
    await mkdir(path.join(repo, "story", "characters"), { recursive: true });
    const character = (name: string): string =>
      [
        "---",
        "schema: authorbot.character/v1",
        "id: character:mara",
        `name: ${name}`,
        "---",
        "",
        "Body.",
        "",
      ].join("\n");
    await writeFile(path.join(repo, "story", "characters", "aa-real.md"), character("Real Mara"));
    await writeFile(
      path.join(repo, "story", "characters", "zz-impostor.md"),
      character("Impostor Mara"),
    );
    const { model, warnings } = await loadSiteModel({ repoPath: repo });
    expect(model.characters.map((entry) => entry.name)).toEqual(["Real Mara"]);
    expect(
      warnings.some((warning) =>
        warning.includes('character id "character:mara" is already defined by story/characters/aa-real.md'),
      ),
    ).toBe(true);
  });
});
