/**
 * Phase 6 contract §3.5 - the direct authoring path.
 *
 * These tests exist to prove exit criterion 2: "the author signs in with
 * GitHub, clicks New chapter, writes prose in a plain composer, saves, and the
 * chapter exists as a draft - committed, attributed, and validated - having
 * never seen a UUID or a block marker." Every request body below is what a
 * plain title-and-prose form would send: no frontmatter, no markers, no ids.
 *
 * The harness is Phase 4's: the real app over an in-memory book repository
 * whose writer applies committed files back into the same map, so what the
 * tests read after a drain is exactly what a git work tree would hold.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  listMarkedBlocks,
  parseChapterMarkdown,
  resolveTarget,
} from "@authorbot/markdown";
import { chapterFrontmatterSchema } from "@authorbot/schemas";
import { chapterValidationFindings, deriveSlug } from "../src/chapter-composer.js";
import {
  CHAPTER_ID,
  FakeReader,
  devLogin,
  fixtureSnapshot,
  makeHarness,
  mintToken,
} from "./helpers.js";
import {
  CHAPTER_PATH,
  CHAPTER_SOURCE,
  makePhase4Harness,
  type Phase4Harness,
} from "./phase4-helpers.js";
import { uuidv7 } from "../src/ids.js";
import { PROSE_OUTBOX_KINDS } from "../src/coordinator.js";
import { createDrainRunner } from "../src/drain.js";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PROSE = `The ridge was empty when Avery reached it.

She had expected the drift to be waiting, and it was not.

"Then we walk," she said, to nobody.`;

let harness: Phase4Harness;
let maintainer: string;
let editor: string;
let contributor: string;

beforeEach(async () => {
  harness = await makePhase4Harness();
  maintainer = await devLogin(harness, "chapter-maintainer", "maintainer");
  editor = await devLogin(harness, "chapter-editor", "editor");
  contributor = await devLogin(harness, "chapter-contributor", "contributor");
});

function headers(cookie?: string, token?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Idempotency-Key": uuidv7(),
    Origin: "http://localhost",
    ...(cookie === undefined ? {} : { Cookie: cookie }),
    ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
  };
}

async function submit(
  body: unknown,
  credential: { cookie?: string; token?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await harness.app.request(
    `/v1/projects/${harness.projectId}/chapter-submissions`,
    {
      method: "POST",
      headers: headers(credential.cookie ?? maintainer, credential.token),
      body: JSON.stringify(body),
    },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function act(
  chapterId: string,
  action: "publish" | "unpublish",
  cookie = maintainer,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await harness.app.request(
    `/v1/projects/${harness.projectId}/chapters/${chapterId}/${action}`,
    { method: "POST", headers: headers(cookie) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Create a chapter from prose and drain, returning its committed source. */
async function createChapter(
  body: Record<string, unknown> = { title: "The Ridge", body: PROSE },
): Promise<{ chapterId: string; path: string; source: string }> {
  const created = await submit(body);
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  await harness.mirror.drain(harness.projectId);
  const chapterId = String(created.body["chapterId"]);
  const chapter = await harness.repos.chapters.getById(chapterId);
  expect(chapter, "chapter projection row after drain").not.toBeNull();
  const source = harness.repoFiles.get(chapter?.path ?? "");
  expect(source, "committed chapter file").toBeDefined();
  return { chapterId, path: chapter?.path ?? "", source: source ?? "" };
}

describe("create (contract §3.5)", () => {
  it("commits a chapter that passes the Phase 0 rules `authorbot validate` applies", async () => {
    const { chapterId, source } = await createChapter();

    // The exact checks `authorbot validate` runs over a chapter file:
    // frontmatter against `authorbot.chapter/v1`, marker health, prose safety.
    expect(chapterValidationFindings(source, chapterId)).toEqual([]);
    const fm = chapterFrontmatterSchema.parse(parseChapterMarkdown(source).frontmatter);
    expect(fm.id).toBe(chapterId);
    expect(fm.schema).toBe("authorbot.chapter/v1");
    expect(fm.title).toBe("The Ridge");
    expect(fm.slug).toBe("the-ridge");
    expect(fm.revision).toBe(1);
    // Contract §3.5: saving creates a DRAFT; publishing is a separate action.
    expect(fm.status).toBe("draft");
    expect(fm.authors).toEqual([{ actor: "github:chapter-maintainer" }]);
  });

  it("generates a marker for every top-level block, and the author wrote none", async () => {
    const { source } = await createChapter();
    const parsed = parseChapterMarkdown(source);

    // Three paragraphs of prose in, three marked blocks out.
    expect(parsed.blocks.markers).toHaveLength(3);
    expect(parsed.blocks.markers.every((marker) => marker.valid)).toBe(true);
    expect(parsed.blocks.unmarked).toEqual([]);
    expect(parsed.blocks.malformed).toEqual([]);
    // The request body contained no marker syntax whatsoever.
    expect(PROSE).not.toContain("authorbot:block");
  });

  it("assigns order as the last existing order plus ten", async () => {
    // The fixture chapter sits at order 10.
    const first = await createChapter({ title: "Second", body: "Second chapter prose." });
    const firstFm = chapterFrontmatterSchema.parse(parseChapterMarkdown(first.source).frontmatter);
    expect(firstFm.order).toBe(20);

    const second = await createChapter({ title: "Third", body: "Third chapter prose." });
    const secondFm = chapterFrontmatterSchema.parse(
      parseChapterMarkdown(second.source).frontmatter,
    );
    expect(secondFm.order).toBe(30);
  });

  /**
   * Regression: finding the last order used to read every existing chapter
   * from GitHub. Each read walks the ref, commit and tree, so a modest book
   * exhausted a Worker's external-subrequest allowance before it could write
   * the new draft. Order now comes from the D1 projection; the only source
   * probe here should be for the proposed new path.
   */
  it("does not reread existing chapter files to assign the next order", async () => {
    const reads: string[] = [];
    const originalRead = harness.writer.readFile.bind(harness.writer);
    harness.writer.readFile = async (branch, path) => {
      reads.push(path);
      return originalRead(branch, path);
    };

    const created = await createChapter({ title: "Projected Order", body: PROSE });
    const fm = chapterFrontmatterSchema.parse(parseChapterMarkdown(created.source).frontmatter);

    expect(fm.order).toBe(20);
    expect(reads).not.toContain(CHAPTER_PATH);
    expect(reads).toContain(created.path);
  });

  it("derives a kebab-case, path-safe slug from the title", () => {
    expect(deriveSlug("The Ridge")).toBe("the-ridge");
    expect(deriveSlug("Chapter 1: What Avery Saw!")).toBe("chapter-1-what-avery-saw");
    expect(deriveSlug("  Café - Déjà Vu  ")).toBe("cafe-deja-vu");
    expect(deriveSlug("Avery’s Notebook")).toBe("averys-notebook");
    expect(deriveSlug("///")).toBe("chapter");
    expect(deriveSlug("../../etc/passwd")).toBe("etc-passwd");
  });

  /**
   * Regression: NFKD only decomposes precomposed Latin, so every Cyrillic and
   * Greek character was dropped and the whole book slugged to `chapter`,
   * `chapter-2`, … - URLs carrying no information about the chapter, and a
   * hard failure at the 51st once MAX_SLUG_ATTEMPTS ran out.
   */
  it("romanizes Cyrillic and Greek titles rather than erasing them", () => {
    expect(deriveSlug("Глава первая")).toBe("glava-pervaya");
    expect(deriveSlug("Ночной дозор")).toBe("nochnoy-dozor");
    expect(deriveSlug("Κεφάλαιο πρώτο")).toBe("kefalaio-proto");
  });

  /**
   * Regression: scripts with no settled romanization still slug to nothing, so
   * the fallback must at least be DISTINCT per chapter instead of colliding on
   * the literal `chapter` for every one of them - which also ran the
   * de-duplication loop out of attempts at the 51st chapter.
   */
  it("falls back to a distinct ordinal slug for an unromanizable title", () => {
    expect(deriveSlug("第一章", 10)).toBe("chapter-10");
    expect(deriveSlug("第二章", 20)).toBe("chapter-20");
    expect(deriveSlug("บทที่หนึ่ง", 30)).toBe("chapter-30");
    expect(deriveSlug("第一章", 10)).not.toBe(deriveSlug("第二章", 20));
  });

  it("rejects an explicit slug that another chapter already uses", async () => {
    // The fixture chapter's slug.
    const clash = await submit({ title: "Baseline Again", body: PROSE, slug: "baseline" });
    expect(clash.status).toBe(409);
    expect(clash.body["type"]).toContain("state-conflict");
  });

  /**
   * Regression: the request path refuses a colliding explicit slug, but it
   * reads the PROJECTION. Under `MIRROR_MODE=queue` - the deployed Worker's
   * mode - the projection is empty until the coordinator alarm drains, so two
   * authors could both be accepted with the same explicit slug and the second
   * silently shipped at `-2`. De-duplication is only ever right for a slug the
   * SERVER guessed: `slug` is a guarded field precisely because it must not
   * move, so an author who asked for a URL and got a different one has to be
   * told rather than quietly accommodated.
   */
  it("refuses, rather than renames, an explicit slug that collides at drain time", async () => {
    const queued = await makePhase4Harness({ config: { mirrorMode: "queue" } });
    try {
      const cookie = await devLogin(queued, "queued-maintainer", "maintainer");
      const post = async (title: string): Promise<number> => {
        const response = await queued.app.request(
          `/v1/projects/${queued.projectId}/chapter-submissions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": uuidv7(),
              Origin: "http://localhost",
              Cookie: cookie,
            },
            body: JSON.stringify({ title, body: PROSE, slug: "my-chosen-slug" }),
          },
        );
        return response.status;
      };

      // Both accepted: the projection is empty, so neither request can see the
      // other. This is the race the request-path check cannot close.
      expect(await post("First")).toBe(202);
      expect(await post("Second")).toBe(202);

      await queued.mirror.drain(queued.projectId);

      const slugs = [...queued.repoFiles.keys()].filter((path) => path.includes("my-chosen-slug"));
      // Exactly one chapter holds the slug the authors asked for, and nothing
      // was silently renamed to `my-chosen-slug-2`.
      expect(slugs.length).toBe(1);
      expect(slugs[0]).not.toContain("my-chosen-slug-2");

      // The loser is a failed operation the author can retry, not a success
      // that shipped at an address they never chose.
      const failed = await queued.db
        .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE kind = 'chapter.write' AND status = 'failed'`)
        .first();
      expect(Number(failed?.["n"])).toBe(1);
    } finally {
      queued.close();
    }
  });

  it("de-duplicates a derived slug that collides, rather than refusing the write", async () => {
    const first = await createChapter({ title: "The Ridge", body: PROSE });
    const second = await createChapter({ title: "The Ridge", body: "A different ridge." });

    const firstFm = chapterFrontmatterSchema.parse(parseChapterMarkdown(first.source).frontmatter);
    const secondFm = chapterFrontmatterSchema.parse(
      parseChapterMarkdown(second.source).frontmatter,
    );
    expect(firstFm.slug).toBe("the-ridge");
    expect(secondFm.slug).toBe("the-ridge-2");
    expect(first.path).not.toBe(second.path);
  });

  it("commits chapter and attribution together, with §14.3 trailers", async () => {
    const { chapterId, path } = await createChapter();
    const commit = harness.writer.commits.at(-1);

    expect(commit?.files.map((f) => f.path).sort()).toEqual(
      [path, `.authorbot/attribution/${chapterId}.yml`].sort(),
    );
    expect(commit?.trailers["Authorbot-Actor"]).toBe("github:chapter-maintainer");
    expect(commit?.trailers["Authorbot-Chapter"]).toBe(chapterId);
    expect(commit?.trailers["Authorbot-Operation"]).toBeDefined();
    const attribution = commit?.files.find((f) => f.path.includes("attribution"))?.content ?? "";
    expect(attribution).toContain("github:chapter-maintainer");
    expect(attribution).toContain("revision: 1");
  });
});

describe("revise (contract §3.5)", () => {
  it("rejects a stale base revision with 409, exactly like a Phase 4 submission", async () => {
    const { chapterId } = await createChapter();
    // The chapter is at revision 1; claim revision 1 is stale after one revise.
    const first = await submit({ chapterId, baseRevision: 1, body: "Rewritten once." });
    expect(first.status).toBe(202);
    await harness.mirror.drain(harness.projectId);

    const stale = await submit({ chapterId, baseRevision: 1, body: "Rewritten again." });
    expect(stale.status).toBe(409);
    expect(stale.body["type"]).toContain("revision-conflict");
    expect(stale.body["currentRevision"]).toBe(2);
  });

  it("reuses marker ids for byte-identical blocks and mints fresh ones elsewhere", async () => {
    const { chapterId, source } = await createChapter();
    const before = listMarkedBlocks(source);
    expect(before).toHaveLength(3);

    // Change the MIDDLE paragraph only; the first and third are untouched.
    const revised = PROSE.split("\n\n");
    revised[1] = "She had expected the drift to be waiting. It was not.";
    const response = await submit({ chapterId, baseRevision: 1, body: revised.join("\n\n") });
    expect(response.status).toBe(202);
    await harness.mirror.drain(harness.projectId);

    const chapter = await harness.repos.chapters.getById(chapterId);
    const after = listMarkedBlocks(harness.repoFiles.get(chapter?.path ?? "") ?? "");
    expect(after).toHaveLength(3);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[2]?.id).toBe(before[2]?.id);
    expect(after[1]?.id).not.toBe(before[1]?.id);
  });

  it("keeps an annotation anchored to an unchanged block resolvable after a revise", async () => {
    const { chapterId, source } = await createChapter();
    const before = listMarkedBlocks(source);
    // An annotation anchored to the FIRST paragraph, the way Phase 2b stores
    // one: block id plus the exact quote with its context.
    const target = {
      blockId: before[0]?.id ?? "",
      textQuote: { exact: "The ridge was empty", prefix: "", suffix: " when Avery" },
    };
    const anchored = resolveTarget(source, target);
    expect(anchored.kind).not.toBe("not_found");

    const revised = PROSE.split("\n\n");
    revised[1] = "She had expected the drift to be waiting. It was not.";
    expect((await submit({ chapterId, baseRevision: 1, body: revised.join("\n\n") })).status).toBe(
      202,
    );
    await harness.mirror.drain(harness.projectId);

    const chapter = await harness.repos.chapters.getById(chapterId);
    const next = harness.repoFiles.get(chapter?.path ?? "") ?? "";
    // The block id survived, so the annotation still resolves by step 1 -
    // which is the whole point of reusing ids for unchanged text.
    const reanchored = resolveTarget(next, target);
    expect(reanchored.kind).not.toBe("not_found");
    expect(reanchored.span?.blockId).toBe(target.blockId);
    expect(listMarkedBlocks(next).some((block) => block.id === target.blockId)).toBe(true);
  });

  it("bumps the revision and credits the reviser in authors and attribution", async () => {
    const { chapterId } = await createChapter();
    const response = await submit(
      { chapterId, baseRevision: 1, title: "The Ridge, Revisited", body: "Rewritten." },
      { cookie: editor },
    );
    expect(response.status).toBe(202);
    await harness.mirror.drain(harness.projectId);

    const chapter = await harness.repos.chapters.getById(chapterId);
    const fm = chapterFrontmatterSchema.parse(
      parseChapterMarkdown(harness.repoFiles.get(chapter?.path ?? "") ?? "").frontmatter,
    );
    expect(fm.revision).toBe(2);
    expect(fm.title).toBe("The Ridge, Revisited");
    expect(fm.authors.map((a) => a.actor)).toEqual([
      "github:chapter-maintainer",
      "github:chapter-editor",
    ]);
    expect(chapter?.revision).toBe(2);
    expect(chapter?.title).toBe("The Ridge, Revisited");
  });

  it("404s an unknown chapter and 400s a revision that changes nothing", async () => {
    expect((await submit({ chapterId: uuidv7(), baseRevision: 1, body: "x" })).status).toBe(404);
    expect((await submit({ chapterId: CHAPTER_ID, baseRevision: 3 })).status).toBe(400);
  });
});

describe("publish / unpublish (contract §3.5: deliberately distinct from writing)", () => {
  it("moves a draft to published as a separate maintainer action", async () => {
    const { chapterId } = await createChapter();
    const chapterBefore = await harness.repos.chapters.getById(chapterId);
    expect(chapterBefore?.status).toBe("draft");

    const published = await act(chapterId, "publish");
    expect(published.status).toBe(202);
    await harness.mirror.drain(harness.projectId);

    const chapter = await harness.repos.chapters.getById(chapterId);
    expect(chapter?.status).toBe("published");
    const fm = chapterFrontmatterSchema.parse(
      parseChapterMarkdown(harness.repoFiles.get(chapter?.path ?? "") ?? "").frontmatter,
    );
    expect(fm.status).toBe("published");
    expect(fm.published_at).toBeDefined();
    expect(fm.revision).toBe(2);
    expect(harness.writer.commits.at(-1)?.message).toContain("Publish chapter");
  });

  it("returns a published chapter to draft and clears published_at", async () => {
    const { chapterId } = await createChapter();
    expect((await act(chapterId, "publish")).status).toBe(202);
    await harness.mirror.drain(harness.projectId);
    expect((await act(chapterId, "unpublish")).status).toBe(202);
    await harness.mirror.drain(harness.projectId);

    const chapter = await harness.repos.chapters.getById(chapterId);
    expect(chapter?.status).toBe("draft");
    const fm = chapterFrontmatterSchema.parse(
      parseChapterMarkdown(harness.repoFiles.get(chapter?.path ?? "") ?? "").frontmatter,
    );
    expect(fm.status).toBe("draft");
    expect(fm.published_at).toBeUndefined();
  });

  it("refuses a no-op transition rather than committing an empty change", async () => {
    const { chapterId } = await createChapter();
    const already = await act(chapterId, "unpublish");
    expect(already.status).toBe(409);
    expect(already.body["type"]).toContain("state-conflict");
  });

  it("is maintainer-only: an editor who may write may not publish", async () => {
    const { chapterId } = await createChapter();
    const denied = await act(chapterId, "publish", editor);
    expect(denied.status).toBe(403);
  });

  /**
   * Regression: `replaceFrontmatter` joined `head` and `body` with a newline
   * the body already carried, so every frontmatter-only edit inserted one more
   * blank line. Publish, unpublish, and title-only revise all take that path,
   * so an author's committed prose grew by a line per operation and a
   * publish→unpublish pair never returned the file to its original bytes -
   * contradicting the function's own "keeping the body byte-for-byte".
   */
  it("is byte-idempotent across publish → unpublish, apart from the frontmatter", async () => {
    const { chapterId, source: original } = await createChapter();

    expect((await act(chapterId, "publish")).status).toBe(202);
    await harness.mirror.drain(harness.projectId);
    expect((await act(chapterId, "unpublish")).status).toBe(202);
    await harness.mirror.drain(harness.projectId);

    const chapter = await harness.repos.chapters.getById(chapterId);
    const after = harness.repoFiles.get(chapter?.path ?? "") ?? "";

    // The prose below the frontmatter must be unchanged, byte for byte.
    const bodyOf = (file: string): string => file.slice(file.indexOf("\n---\n", 3) + 5);
    expect(bodyOf(after)).toBe(bodyOf(original));
    // And specifically: no blank line has accumulated under the fence.
    expect(after).not.toMatch(/---\n\n\n/);
  });

  /**
   * The same defect reached the file through a title-only revise, which is the
   * other `body === undefined` entry point.
   */
  it("does not grow the file on a title-only revise", async () => {
    const { chapterId, source: original } = await createChapter();
    const bodyOf = (file: string): string => file.slice(file.indexOf("\n---\n", 3) + 5);

    for (const title of ["Retitled Once", "Retitled Twice", "Retitled Thrice"]) {
      const revised = await submit({ chapterId, title, baseRevision: undefined });
      // A revise needs the current base revision; read it back each round.
      if (revised.status !== 202) {
        const chapter = await harness.repos.chapters.getById(chapterId);
        const retry = await submit({ chapterId, title, baseRevision: chapter?.revision });
        expect(retry.status, JSON.stringify(retry.body)).toBe(202);
      }
      await harness.mirror.drain(harness.projectId);
    }

    const chapter = await harness.repos.chapters.getById(chapterId);
    const after = harness.repoFiles.get(chapter?.path ?? "") ?? "";
    expect(bodyOf(after)).toBe(bodyOf(original));
    expect(after).not.toMatch(/---\n\n\n/);
  });
});

describe("authorization matrix (contract §3.5)", () => {
  it("requires authentication", async () => {
    const response = await harness.app.request(
      `/v1/projects/${harness.projectId}/chapter-submissions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": uuidv7(),
          Origin: "http://localhost",
        },
        body: JSON.stringify({ title: "Nope", body: PROSE }),
      },
    );
    expect(response.status).toBe(401);
  });

  it("admits maintainers and editors, refuses contributors and readers", async () => {
    const reader = await devLogin(harness, "chapter-reader", "reader");
    expect((await submit({ title: "By maintainer", body: PROSE }, { cookie: maintainer })).status)
      .toBe(202);
    expect((await submit({ title: "By editor", body: PROSE }, { cookie: editor })).status).toBe(202);
    expect((await submit({ title: "By contributor", body: PROSE }, { cookie: contributor })).status)
      .toBe(403);
    expect((await submit({ title: "By reader", body: PROSE }, { cookie: reader })).status).toBe(403);
  });

  it("refuses an agent token that lacks submissions:write", async () => {
    const weak = (await mintToken(harness, maintainer, ["annotations:write"], "annotator")).token;
    const response = await harness.app.request(
      `/v1/projects/${harness.projectId}/chapter-submissions`,
      {
        method: "POST",
        headers: headers(undefined, weak),
        body: JSON.stringify({ title: "By agent", body: PROSE }),
      },
    );
    expect(response.status).toBe(403);
  });

  it("admits an agent token that holds submissions:write", async () => {
    const strong = (await mintToken(harness, maintainer, ["submissions:write"], "author-agent"))
      .token;
    const response = await harness.app.request(
      `/v1/projects/${harness.projectId}/chapter-submissions`,
      {
        method: "POST",
        headers: headers(undefined, strong),
        body: JSON.stringify({ title: "By agent", body: PROSE }),
      },
    );
    expect(response.status).toBe(202);
    const accepted = (await response.json()) as { chapterId: string };
    await harness.mirror.drain(harness.projectId);
    const chapter = await harness.repos.chapters.getById(accepted.chapterId);
    const source = harness.repoFiles.get(chapter?.path ?? "") ?? "";
    const fm = chapterFrontmatterSchema.parse(parseChapterMarkdown(source).frontmatter);
    expect(fm.authors).toEqual([
      expect.objectContaining({ name: "author-agent" }),
    ]);
  });
});

describe("validation before the outbox (contract §3.5)", () => {
  it("refuses raw HTML in prose with 422 and enqueues nothing", async () => {
    const before = harness.writer.commits.length;
    const response = await submit({
      title: "Scripted",
      body: "A paragraph.\n\n<script>alert(1)</script>",
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toContain("raw HTML");
    await harness.mirror.drain(harness.projectId);
    expect(harness.writer.commits.length).toBe(before);
  });

  it("refuses a forbidden URL scheme", async () => {
    const response = await submit({
      title: "Linked",
      body: "See [the notes](javascript:alert(1)) for context.",
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toContain("javascript");
  });

  it("refuses author-supplied block markers - the author must never write one", async () => {
    const response = await submit({
      title: "Marked up",
      body: `<!-- authorbot:block id="${CHAPTER_ID}" -->\nA paragraph.`,
    });
    expect(response.status).toBe(422);
  });

  it("refuses an empty title or body before anything is reserved", async () => {
    expect((await submit({ title: "", body: PROSE })).status).toBe(400);
    expect((await submit({ title: "Fine", body: "" })).status).toBe(400);
  });

  it("refuses prose with no markable block at all", async () => {
    const response = await submit({ title: "Blank", body: "   \n\n   " });
    expect(response.status).toBe(422);
  });
});

/**
 * The claim "committed, attributed, and validated" is only worth as much as
 * the validator that checks it. The suite above uses the same Phase 0
 * primitives the composer does, which would pass even if both were wrong
 * together - so this one takes the bytes the API actually committed, drops
 * them into a copy of the blank book template, and runs the real
 * `authorbot validate` binary over the result.
 */
describe("the committed chapter satisfies the real `authorbot validate`", () => {
  it("validates inside a copy of the blank book template", async () => {
    const cliPath = fileURLToPath(new URL("../../cli/dist/bin.js", import.meta.url));
    const templateDir = fileURLToPath(new URL("../../../templates/book-repo", import.meta.url));
    if (!existsSync(cliPath)) {
      // The CLI is built by `pnpm build`; skipping beats failing a source-only
      // run, and the assertion still guards every CI run that builds first.
      return;
    }
    const { path, source } = await createChapter();

    const bookDir = mkdtempSync(join(tmpdir(), "authorbot-chapter-"));
    try {
      cpSync(templateDir, bookDir, { recursive: true });
      const target = join(bookDir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source, "utf8");

      const result = spawnSync(process.execPath, [cliPath, "validate", bookDir], {
        encoding: "utf8",
      });
      expect(`${result.stdout}${result.stderr}`).toContain("valid (0 errors");
      expect(result.status).toBe(0);
    } finally {
      rmSync(bookDir, { recursive: true, force: true });
    }
  });
});

describe("project divergence blocks the authoring path (design §14.5)", () => {
  it("refuses a new chapter with 409 while the repository is diverged", async () => {
    await harness.repos.projects
      .markDivergedStatement({
        projectId: harness.projectId,
        reason: { findings: [] },
        at: "2026-07-20T00:00:00Z",
      })
      .run();

    const response = await submit({ title: "During divergence", body: PROSE });
    expect(response.status).toBe(409);
    expect(response.body["type"]).toContain("project-diverged");
  });

  it("holds a chapter.write queued before divergence rather than committing it", async () => {
    // MIRROR_MODE=queue: the row is recorded and drained out of band, which is
    // the deployed Worker's mode and the only one in which a divergence can
    // land BETWEEN the accepted request and the commit.
    const queued = await makePhase4Harness({ config: { mirrorMode: "queue" } });
    try {
      const cookie = await devLogin(queued, "queued-maintainer", "maintainer");
      const response = await queued.app.request(
        `/v1/projects/${queued.projectId}/chapter-submissions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": uuidv7(),
            Origin: "http://localhost",
            Cookie: cookie,
          },
          body: JSON.stringify({ title: "Queued first", body: PROSE }),
        },
      );
      expect(response.status).toBe(202);
      await queued.repos.projects
        .markDivergedStatement({
          projectId: queued.projectId,
          reason: { findings: [] },
          at: "2026-07-20T00:00:00Z",
        })
        .run();

      // A drain wired the way the coordinator wires it: prose kinds paused
      // while the project is diverged. The row must stay `pending` - neither
      // committed nor failed - so the backlog resumes by itself once a
      // maintainer clears the divergence.
      const runner = createDrainRunner({
        db: queued.db,
        writer: queued.writer,
        clock: queued.clock,
        pausedKinds: async (projectId) => {
          const project = await queued.repos.projects.getById(projectId);
          return project?.status === "diverged" ? PROSE_OUTBOX_KINDS : [];
        },
      });
      const before = queued.writer.commits.length;
      await runner.drain(queued.projectId);

      expect(PROSE_OUTBOX_KINDS).toContain("chapter.write");
      expect(queued.writer.commits.length).toBe(before);
      const row = await queued.db
        .prepare(`SELECT status FROM outbox WHERE kind = 'chapter.write'`)
        .first();
      expect(row?.["status"]).toBe("pending");
    } finally {
      queued.close();
    }
  });
});

/**
 * Regression (contract §3.5: "Editing an existing chapter uses the same
 * composer"). The revise half of POST chapter-submissions requires a COMPLETE
 * replacement body plus the correct `baseRevision`, but no route returned a
 * chapter's prose - `chapterJson` carries only projection metadata. A revise
 * therefore had to be written blind or sourced out-of-band from Git, which is
 * the exact problem Phase 6 exists to remove.
 */
describe("GET chapter source (contract §3.5, the composer's read half)", () => {
  const getSource = async (
    chapterId: string,
    cookie = maintainer,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await harness.app.request(
      `/v1/projects/${harness.projectId}/chapters/${chapterId}/source`,
      { headers: headers(cookie) },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  it("returns prose with no frontmatter and no block markers", async () => {
    const { chapterId } = await createChapter({ title: "The Ridge", body: PROSE });
    const { status, body } = await getSource(chapterId);

    expect(status).toBe(200);
    expect(body["body"]).toBe(PROSE);
    expect(String(body["body"])).not.toContain("<!--");
    expect(String(body["body"])).not.toContain("---");
    expect(body["title"]).toBe("The Ridge");
    expect(body["status"]).toBe("draft");
  });

  it("uses the coordinator source reader when the Worker has no local Git reader", async () => {
    const projectionReader = new FakeReader(fixtureSnapshot());
    // The projected chapter is already in D1, while the request isolate has
    // no direct GitHub `readTextFile` capability, matching production.
    Object.defineProperty(projectionReader, "readTextFile", { value: undefined });
    const calls: Array<{ projectId: string; path: string }> = [];
    const remote = await makeHarness({
      reader: projectionReader,
      repositorySourceReader: {
        readTextFile: async (projectId, path) => {
          calls.push({ projectId, path });
          return { outcome: "found", source: CHAPTER_SOURCE };
        },
      },
    });
    try {
      const cookie = await devLogin(remote, "remote-editor", "editor");
      const response = await remote.app.request(
        `/v1/projects/${remote.projectId}/chapters/${CHAPTER_ID}/source`,
        { headers: headers(cookie) },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        chapterId: CHAPTER_ID,
        title: "Baseline",
        revision: 3,
      });
      expect(calls).toEqual([
        { projectId: remote.projectId, path: "chapters/001-baseline.md" },
      ]);
    } finally {
      remote.close();
    }
  });

  it("returns the revision a revise must send back as baseRevision", async () => {
    const { chapterId } = await createChapter();
    const source = await getSource(chapterId);

    // Round-trip: the body and revision it returned drive a valid revise.
    const revised = await submit({
      chapterId,
      body: `${String(source.body["body"])}\n\nA new closing paragraph.`,
      baseRevision: source.body["revision"],
    });
    expect(revised.status, JSON.stringify(revised.body)).toBe(202);
    await harness.mirror.drain(harness.projectId);

    const after = await getSource(chapterId);
    expect(after.body["revision"]).toBe(Number(source.body["revision"]) + 1);
    expect(String(after.body["body"])).toContain("A new closing paragraph.");
  });

  it("is editor/maintainer only, matching the write it feeds", async () => {
    const { chapterId } = await createChapter();
    expect((await getSource(chapterId, editor)).status).toBe(200);
    expect((await getSource(chapterId, contributor)).status).toBe(403);
  });

  it("404s an unknown chapter", async () => {
    expect((await getSource(uuidv7())).status).toBe(404);
  });
});
