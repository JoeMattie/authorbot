import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validFixturesRoot } from "@authorbot/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { validateBookRepo, type ValidationReport } from "../src/index.js";

/**
 * Regression tests for confirmed review findings: each builds a small book
 * repository (a mutated copy of the minimal valid fixture) in a temp
 * directory and asserts the validator's exact behavior.
 */

/** Chapter id / revision of `fixtures/valid/minimal`. */
const CHAPTER_ID = "019de28e-2660-75b7-ab7a-93a33ed1ee9c";

const tempDirs: string[] = [];

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "authorbot-regress-"));
  tempDirs.push(dir);
  await cp(path.join(validFixturesRoot, "minimal"), dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function errorCodes(report: ValidationReport): string[] {
  return report.errors.map((finding) => finding.code);
}

async function writeAnnotation(
  root: string,
  dirName: string,
  frontmatter: string,
): Promise<void> {
  const dir = path.join(root, ".authorbot", "annotations", dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "annotation.md"),
    `---\n${frontmatter}\n---\n\nAnnotation body.\n`,
    "utf8",
  );
}

function annotationFm(id: string, extra: string): string {
  return [
    "schema: authorbot.annotation/v1",
    `id: ${id}`,
    "kind: comment",
    `chapter_id: ${CHAPTER_ID}`,
    "chapter_revision: 1",
    "author: github:reader",
    "status: open",
    "created_at: 2026-05-01T09:00:00Z",
    extra,
  ].join("\n");
}

const workItemFm = (id: string): string =>
  [
    "---",
    "schema: authorbot.work-item/v1",
    `id: ${id}`,
    "type: revise_chapter",
    "status: ready",
    `chapter_id: ${CHAPTER_ID}`,
    "base_revision: 1",
    "priority: normal",
    "created_by: system:rule-engine",
    "created_at: 2026-05-02T08:00:00Z",
    "---",
    "",
    "Body.",
    "",
  ].join("\n");

describe("contract-optional nested markers (blockquote paragraphs, list items)", () => {
  it("accepts them and registers their ids for annotation resolution", async () => {
    const root = await makeRepo();
    const blockId = "019de290-0000-7000-8000-000000000002";
    const chapterPath = path.join(root, "chapters", "001-solitary.md");
    const appended = [
      "",
      '<!-- authorbot:block id="019de290-0000-7000-8000-000000000001" -->',
      `> <!-- authorbot:block id="${blockId}" -->`,
      "> A quoted paragraph, marked per contract section 3.",
      "",
      '<!-- authorbot:block id="019de290-0000-7000-8000-000000000003" -->',
      `- <!-- authorbot:block id="019de290-0000-7000-8000-000000000004" -->`,
      "  A marked list item.",
      "- An unmarked list item.",
      "",
    ].join("\n");
    await writeFile(chapterPath, `${await readFile(chapterPath, "utf8")}${appended}`, "utf8");
    await writeAnnotation(
      root,
      "019de291-0000-7000-8000-000000000001",
      annotationFm(
        "019de291-0000-7000-8000-000000000001",
        `scope: block\ntarget:\n  blockId: ${blockId}`,
      ),
    );
    const report = await validateBookRepo(root);
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
  });
});

describe("dangling block markers", () => {
  it("do not resolve annotation targets (ANNOTATION_REF_UNRESOLVED still fires)", async () => {
    const root = await makeRepo();
    const deadId = "019de290-0000-7000-8000-00000000dead";
    const chapterPath = path.join(root, "chapters", "001-solitary.md");
    await writeFile(
      chapterPath,
      `${await readFile(chapterPath, "utf8")}\n<!-- authorbot:block id="${deadId}" -->\n`,
      "utf8",
    );
    await writeAnnotation(
      root,
      "019de291-0000-7000-8000-000000000002",
      annotationFm(
        "019de291-0000-7000-8000-000000000002",
        `scope: block\ntarget:\n  blockId: ${deadId}`,
      ),
    );
    const report = await validateBookRepo(root);
    expect(errorCodes(report)).toContain("BLOCK_ID_INVALID");
    expect(errorCodes(report)).toContain("ANNOTATION_REF_UNRESOLVED");
  });

  it("a marker separated from its block by blank lines does not claim it", async () => {
    const root = await makeRepo();
    const chapterPath = path.join(root, "chapters", "001-solitary.md");
    await writeFile(
      chapterPath,
      `${await readFile(chapterPath, "utf8")}\n<!-- authorbot:block id="019de290-0000-7000-8000-000000000005" -->\n\n\nA paragraph three lines below the stale marker.\n`,
      "utf8",
    );
    const report = await validateBookRepo(root);
    expect(errorCodes(report)).toContain("BLOCK_ID_INVALID"); // stale marker
    expect(errorCodes(report)).toContain("BLOCK_ID_MISSING"); // unclaimed paragraph
  });
});

describe("annotation selector coherence", () => {
  it("rejects textPosition with end before start", async () => {
    const root = await makeRepo();
    await writeAnnotation(
      root,
      "019de291-0000-7000-8000-000000000003",
      annotationFm(
        "019de291-0000-7000-8000-000000000003",
        [
          "scope: range",
          "target:",
          "  blockId: 019de28f-10c0-718b-85da-c5fb4d148421",
          "  textPosition:",
          "    start: 500",
          "    end: 3",
          "  textQuote:",
          '    exact: "the annex"',
        ].join("\n"),
      ),
    );
    const report = await validateBookRepo(root);
    expect(errorCodes(report)).toContain("ANNOTATION_INVALID");
    expect(
      report.errors.some((f) => f.pointer === "/target/textPosition"),
    ).toBe(true);
  });
});

describe("record paths must match record ids (contract section 4)", () => {
  it("reports an annotation directory named after a different id", async () => {
    const root = await makeRepo();
    await writeAnnotation(
      root,
      "019de291-0000-7000-8000-00000000aaaa",
      annotationFm("019de291-0000-7000-8000-00000000bbbb", "scope: chapter"),
    );
    const report = await validateBookRepo(root);
    expect(errorCodes(report)).toContain("ANNOTATION_INVALID");
    expect(report.errors.some((f) => f.message.includes("does not match"))).toBe(true);
  });

  it("reports work-item/decision/release/attribution files named after a different id", async () => {
    const root = await makeRepo();
    const wid = "019de292-0000-7000-8000-000000000001";
    await mkdir(path.join(root, ".authorbot", "work-items"), { recursive: true });
    await writeFile(
      path.join(root, ".authorbot", "work-items", "019de292-0000-7000-8000-00000000ffff.md"),
      workItemFm(wid),
      "utf8",
    );
    await mkdir(path.join(root, ".authorbot", "decisions"), { recursive: true });
    await writeFile(
      path.join(root, ".authorbot", "decisions", "019de293-0000-7000-8000-00000000ffff.yml"),
      [
        "schema: authorbot.decision/v1",
        "id: 019de293-0000-7000-8000-000000000001",
        "source_annotation_id: 019de291-0000-7000-8000-00000000cccc",
        "rule: suggestion_to_work_item",
        "rule_version: 1",
        "metrics:",
        "  approvals: 1",
        "result: rejected",
        "effective_at: 2026-05-03T10:00:00Z",
        "",
      ].join("\n"),
      "utf8",
    );
    await mkdir(path.join(root, ".authorbot", "releases"), { recursive: true });
    await writeFile(
      path.join(root, ".authorbot", "releases", "019de294-0000-7000-8000-00000000ffff.yml"),
      [
        "schema: authorbot.release/v1",
        "id: 019de294-0000-7000-8000-000000000001",
        "created_at: 2026-05-04T12:00:00Z",
        "chapters:",
        `  - chapter_id: ${CHAPTER_ID}`,
        "    revision: 1",
        "",
      ].join("\n"),
      "utf8",
    );
    await mkdir(path.join(root, ".authorbot", "attribution"), { recursive: true });
    await writeFile(
      path.join(root, ".authorbot", "attribution", "019de295-0000-7000-8000-00000000ffff.yml"),
      [
        "schema: authorbot.attribution/v1",
        `chapter_id: ${CHAPTER_ID}`,
        "entries:",
        "  - revision: 1",
        "    actor: github:fixture-author",
        "",
      ].join("\n"),
      "utf8",
    );
    const report = await validateBookRepo(root);
    for (const code of [
      "WORK_ITEM_INVALID",
      "DECISION_INVALID",
      "RELEASE_INVALID",
      "ATTRIBUTION_INVALID",
    ]) {
      expect(
        report.errors.some(
          (f) => f.code === code && f.message.includes("does not match the record's"),
        ),
        `${code} path/id mismatch finding`,
      ).toBe(true);
    }
  });

  it("reports an attribution chapter_id that matches no chapter", async () => {
    const root = await makeRepo();
    const ghost = "019de296-0000-7000-8000-000000000001";
    await mkdir(path.join(root, ".authorbot", "attribution"), { recursive: true });
    await writeFile(
      path.join(root, ".authorbot", "attribution", `${ghost}.yml`),
      [
        "schema: authorbot.attribution/v1",
        `chapter_id: ${ghost}`,
        "entries:",
        "  - revision: 1",
        "    actor: github:fixture-author",
        "",
      ].join("\n"),
      "utf8",
    );
    const report = await validateBookRepo(root);
    expect(
      report.errors.some(
        (f) =>
          f.code === "ATTRIBUTION_INVALID" &&
          f.message.includes("does not match any chapter"),
      ),
    ).toBe(true);
  });
});

describe("duplicate record ids across files", () => {
  it("reports two work items declaring the same id", async () => {
    const root = await makeRepo();
    const wid = "019de297-0000-7000-8000-000000000001";
    const other = "019de297-0000-7000-8000-000000000002";
    await mkdir(path.join(root, ".authorbot", "work-items"), { recursive: true });
    await writeFile(path.join(root, ".authorbot", "work-items", `${wid}.md`), workItemFm(wid), "utf8");
    await writeFile(path.join(root, ".authorbot", "work-items", `${other}.md`), workItemFm(wid), "utf8");
    const report = await validateBookRepo(root);
    expect(
      report.errors.some(
        (f) => f.code === "WORK_ITEM_INVALID" && f.message.includes("already declared"),
      ),
    ).toBe(true);
  });

  it("reports two annotations declaring the same id", async () => {
    const root = await makeRepo();
    const aid = "019de298-0000-7000-8000-000000000001";
    const otherDir = "019de298-0000-7000-8000-000000000002";
    await writeAnnotation(root, aid, annotationFm(aid, "scope: chapter"));
    await writeAnnotation(root, otherDir, annotationFm(aid, "scope: chapter"));
    const report = await validateBookRepo(root);
    expect(
      report.errors.some(
        (f) => f.code === "ANNOTATION_INVALID" && f.message.includes("already declared"),
      ),
    ).toBe(true);
  });
});

describe("maintainer force-create decision (rule_version 0, contract §4)", () => {
  it("validates cleanly - `authorbot validate` accepts rule_version 0", async () => {
    const root = await makeRepo();
    const annId = "019de29b-0000-7000-8000-000000000001";
    const wid = "019de29b-0000-7000-8000-000000000002";
    const decId = "019de29b-0000-7000-8000-000000000003";
    await writeAnnotation(root, annId, annotationFm(annId, "scope: chapter"));
    await mkdir(path.join(root, ".authorbot", "work-items"), { recursive: true });
    await writeFile(path.join(root, ".authorbot", "work-items", `${wid}.md`), workItemFm(wid), "utf8");
    await mkdir(path.join(root, ".authorbot", "decisions"), { recursive: true });
    await writeFile(
      path.join(root, ".authorbot", "decisions", `${decId}.yml`),
      [
        "schema: authorbot.decision/v1",
        `id: ${decId}`,
        `source_annotation_id: ${annId}`,
        "rule: maintainer_override",
        "rule_version: 0",
        "metrics:",
        "  approvals: 1",
        "result: create_work_item",
        `work_item_id: ${wid}`,
        "effective_at: 2026-05-03T10:00:00Z",
        "override_reason: editorial call",
        "",
      ].join("\n"),
      "utf8",
    );
    const report = await validateBookRepo(root);
    expect(errorCodes(report)).not.toContain("DECISION_INVALID");
    expect(errorCodes(report)).not.toContain("DECISION_REF_UNRESOLVED");
    expect(report.valid).toBe(true);
  });
});

describe("reply thread consistency", () => {
  it("rejects a reply whose annotation_id names a different annotation", async () => {
    const root = await makeRepo();
    const annA = "019de299-0000-7000-8000-00000000aaaa";
    const annB = "019de299-0000-7000-8000-00000000bbbb";
    await writeAnnotation(root, annA, annotationFm(annA, "scope: chapter"));
    await writeAnnotation(root, annB, annotationFm(annB, "scope: chapter"));
    const replyId = "019de29a-0000-7000-8000-000000000001";
    const repliesDir = path.join(root, ".authorbot", "annotations", annA, "replies");
    await mkdir(repliesDir, { recursive: true });
    await writeFile(
      path.join(repliesDir, `${replyId}.md`),
      [
        "---",
        "schema: authorbot.reply/v1",
        `id: ${replyId}`,
        `annotation_id: ${annB}`,
        "author: github:reader",
        "created_at: 2026-05-05T09:00:00Z",
        "---",
        "",
        "Reply filed under annotation A but claiming membership in B.",
        "",
      ].join("\n"),
      "utf8",
    );
    const report = await validateBookRepo(root);
    expect(
      report.errors.some(
        (f) =>
          f.code === "ANNOTATION_REF_UNRESOLVED" &&
          f.message.includes("enclosing annotation"),
      ),
    ).toBe(true);
  });
});

describe("symlinked chapters", () => {
  it("are matched by the chapters glob and fully validated", async () => {
    const root = await makeRepo();
    await mkdir(path.join(root, "shared"), { recursive: true });
    await writeFile(
      path.join(root, "shared", "002-bad.md"),
      "no frontmatter here\n\n<script>alert(1)</script>\n",
      "utf8",
    );
    await symlink(
      path.join("..", "shared", "002-bad.md"),
      path.join(root, "chapters", "002-bad.md"),
    );
    const report = await validateBookRepo(root);
    const symlinkFindings = report.errors.filter((f) => f.path === "chapters/002-bad.md");
    expect(symlinkFindings.map((f) => f.code)).toContain("CHAPTER_FRONTMATTER_INVALID");
    expect(symlinkFindings.map((f) => f.code)).toContain("RAW_HTML_FORBIDDEN");
  });
});

describe("location:*/concept:* unresolved-reference severity (contract section 5)", () => {
  const outlineWithConceptLink = [
    "schema: authorbot.story-graph/v1",
    "nodes:",
    "  - id: premise:the-hook",
    "    type: premise",
    "    order: 1",
    "links:",
    "  - from: premise:the-hook",
    "    to: concept:nowhere",
    "    type: explores",
    "",
  ].join("\n");

  it("warns on concept:* references while no story/concepts collection exists", async () => {
    const root = await makeRepo();
    await mkdir(path.join(root, "story"), { recursive: true });
    await writeFile(path.join(root, "story", "outline.yml"), outlineWithConceptLink, "utf8");
    const report = await validateBookRepo(root);
    expect(report.errors).toEqual([]);
    expect(
      report.warnings.some(
        (f) => f.code === "STORY_GRAPH_REF_UNRESOLVED" && f.message.includes("concept:nowhere"),
      ),
    ).toBe(true);
  });

  it("escalates to an error once the story/concepts collection exists", async () => {
    const root = await makeRepo();
    await mkdir(path.join(root, "story", "concepts"), { recursive: true });
    await writeFile(
      path.join(root, "story", "concepts", "the-drift.md"),
      "---\nid: concept:the-drift\n---\n\nThe drift.\n",
      "utf8",
    );
    await writeFile(path.join(root, "story", "outline.yml"), outlineWithConceptLink, "utf8");
    const report = await validateBookRepo(root);
    expect(
      report.errors.some(
        (f) => f.code === "STORY_GRAPH_REF_UNRESOLVED" && f.message.includes("concept:nowhere"),
      ),
    ).toBe(true);
  });
});

describe("publication.chapter_url is validated like the build routes it (validate/build agreement)", () => {
  async function setChapterUrl(root: string, pattern: string): Promise<void> {
    const bookPath = path.join(root, "book.yml");
    await writeFile(
      bookPath,
      `${await readFile(bookPath, "utf8")}publication:\n  chapter_url: "${pattern}"\n`,
      "utf8",
    );
  }

  it("rejects a pattern without {slug} (all chapters would share one route)", async () => {
    const root = await makeRepo();
    await setChapterUrl(root, "/chapters/all/");
    const report = await validateBookRepo(root);
    expect(
      report.errors.some(
        (f) =>
          f.code === "BOOK_CONFIG_INVALID" &&
          f.pointer === "/publication/chapter_url" &&
          f.message.includes("{slug}"),
      ),
    ).toBe(true);
  });

  it("rejects a pattern producing unsafe path segments", async () => {
    const root = await makeRepo();
    await setChapterUrl(root, "/a b/{slug}/");
    const report = await validateBookRepo(root);
    expect(
      report.errors.some(
        (f) => f.code === "PATH_UNSAFE" && f.message.includes('unsafe path segment "a b"'),
      ),
    ).toBe(true);
  });

  it("rejects a pattern routing chapters under the reserved story/ path", async () => {
    const root = await makeRepo();
    await setChapterUrl(root, "/story/{slug}/");
    const report = await validateBookRepo(root);
    expect(
      report.errors.some(
        (f) => f.code === "PATH_UNSAFE" && f.message.includes('reserved path "story/"'),
      ),
    ).toBe(true);
  });

  it("rejects a chapter whose slug expands the pattern into a reserved route", async () => {
    const root = await makeRepo();
    await setChapterUrl(root, "/{slug}/");
    const chapterPath = path.join(root, "chapters", "001-solitary.md");
    await writeFile(
      chapterPath,
      (await readFile(chapterPath, "utf8")).replace("slug: solitary", "slug: story"),
      "utf8",
    );
    const report = await validateBookRepo(root);
    expect(
      report.errors.some(
        (f) =>
          f.code === "PATH_UNSAFE" &&
          f.path === "chapters/001-solitary.md" &&
          f.message.includes('reserved path "story/"'),
      ),
    ).toBe(true);
  });

  it("accepts the default-shaped pattern", async () => {
    const root = await makeRepo();
    await setChapterUrl(root, "/read/{slug}/");
    const report = await validateBookRepo(root);
    expect(report.errors).toEqual([]);
  });
});

describe("duplicate character ids", () => {
  it("reports two character records declaring the same id", async () => {
    const root = await makeRepo();
    await mkdir(path.join(root, "story", "characters"), { recursive: true });
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
    await writeFile(path.join(root, "story", "characters", "aa-real.md"), character("Real Mara"), "utf8");
    await writeFile(
      path.join(root, "story", "characters", "zz-impostor.md"),
      character("Impostor Mara"),
      "utf8",
    );
    const report = await validateBookRepo(root);
    expect(
      report.errors.some(
        (f) =>
          f.code === "CHARACTER_FILE_INVALID" &&
          f.path === "story/characters/zz-impostor.md" &&
          f.message.includes("already declared by story/characters/aa-real.md"),
      ),
    ).toBe(true);
  });
});

describe("story-graph parent cycles", () => {
  it("reports a cycle even though every parent reference resolves", async () => {
    const root = await makeRepo();
    await mkdir(path.join(root, "story"), { recursive: true });
    await writeFile(
      path.join(root, "story", "outline.yml"),
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
      "utf8",
    );
    const report = await validateBookRepo(root);
    expect(
      report.errors.some(
        (f) => f.code === "STORY_GRAPH_INVALID" && f.message.includes("parent cycle"),
      ),
    ).toBe(true);
  });

  it("does not report acyclic parent chains", async () => {
    const root = await makeRepo();
    await mkdir(path.join(root, "story"), { recursive: true });
    await writeFile(
      path.join(root, "story", "outline.yml"),
      [
        "schema: authorbot.story-graph/v1",
        "nodes:",
        "  - id: premise:main",
        "    type: premise",
        "    title: Premise",
        "    order: 1",
        "  - id: part:one",
        "    type: part",
        "    title: Part One",
        "    parent: premise:main",
        "    order: 2",
        "",
      ].join("\n"),
      "utf8",
    );
    const report = await validateBookRepo(root);
    expect(report.errors).toEqual([]);
  });
});

describe("per-type work-item field requirements", () => {
  it("accepts write_chapter and planning items without revision references", async () => {
    const root = await makeRepo();
    const wid = "019de29b-0000-7000-8000-000000000001";
    await mkdir(path.join(root, ".authorbot", "work-items"), { recursive: true });
    await writeFile(
      path.join(root, ".authorbot", "work-items", `${wid}.md`),
      [
        "---",
        "schema: authorbot.work-item/v1",
        `id: ${wid}`,
        "type: planning",
        "status: ready",
        "priority: low",
        "created_by: system:rule-engine",
        "created_at: 2026-05-02T08:00:00Z",
        "---",
        "",
        "Plan the next arc.",
        "",
      ].join("\n"),
      "utf8",
    );
    const report = await validateBookRepo(root);
    expect(report.errors).toEqual([]);
  });

  it("rejects a revise_range item lacking chapter, base revision, and source annotation", async () => {
    const root = await makeRepo();
    const wid = "019de29c-0000-7000-8000-000000000001";
    await mkdir(path.join(root, ".authorbot", "work-items"), { recursive: true });
    await writeFile(
      path.join(root, ".authorbot", "work-items", `${wid}.md`),
      [
        "---",
        "schema: authorbot.work-item/v1",
        `id: ${wid}`,
        "type: revise_range",
        "status: ready",
        "priority: normal",
        "created_by: system:rule-engine",
        "created_at: 2026-05-02T08:00:00Z",
        "---",
        "",
        "Unactionable: nothing identifies the text to revise.",
        "",
      ].join("\n"),
      "utf8",
    );
    const report = await validateBookRepo(root);
    const pointers = report.errors
      .filter((f) => f.code === "WORK_ITEM_REF_UNRESOLVED")
      .map((f) => f.pointer);
    expect(pointers).toContain("/chapter_id");
    expect(pointers).toContain("/base_revision");
    expect(pointers).toContain("/source_annotation_id");
  });
});
