/**
 * The API-side `ChapterComposer` (Phase 6 contract §3.5; design §15.2): the
 * drain-time renderer injected into the `@authorbot/repo-coordinator`
 * processor for `chapter.write` outbox rows, which owns everything around it
 * (attribution append, the atomic commit, projection sync, crash recovery).
 *
 * This is the module that lets an author write prose and never see a UUID or
 * a block marker. Given `{ title, body }` it produces a complete, valid
 * `authorbot.chapter/v1` file: frontmatter with the server-generated id,
 * slug, order, status and revision, and a body where every top-level block
 * carries a marker.
 *
 * **Why compose at drain time rather than at request time.** Everything a
 * chapter file needs depends on what is committed *right now*: the slug must
 * be free, `order` is the last existing order plus ten, and a revise must
 * reuse the marker ids of blocks whose text did not change so that
 * annotations anchored there keep resolving. A plan rendered when the request
 * arrived would be computed against the projection - which lags the branch by
 * however long the outbox took to drain - and committing it would either
 * clobber a chapter that landed in between or claim a slug someone else took.
 * Composing here, against the head the commit is pinned to, is the same
 * discipline `submission-applier.ts` uses and for the same reason.
 *
 * Documented policy decisions:
 *
 * - **Marker reuse is `applyChapterReplacement`'s**, not a second
 *   implementation: byte-identical top-level blocks keep their ids (stable
 *   first-unconsumed-in-document-order matching), everything else gets a
 *   fresh UUIDv7. Phase 4's patch engine already had to answer this question
 *   and answering it twice is how the two answers drift.
 * - **Publish/unpublish bumps the revision.** The file's bytes change, and
 *   `revision` is the handle every base-revision and base-hash check in
 *   Phases 3-5 uses to mean "these exact bytes". Leaving it alone would let
 *   two different chapter files share a revision, which turns a stale
 *   submission into a silent mismatch instead of a clean 409.
 * - **A stale base revision throws.** Unlike a submission there is no second
 *   party whose prose could be lost by refusing, so the honest outcome is a
 *   failed operation the author retries against the current text - not a
 *   `resolve_conflict` work item nobody asked for. The request path rejects
 *   the common case with 409 long before this; reaching here means the
 *   chapter moved between the request and the drain.
 * - **Slug collisions are resolved against the branch, not the projection.**
 *   The request path checks the projection for fast feedback; here the
 *   candidate path is probed through the writer, which is authoritative, and
 *   a taken slug gains a `-2`, `-3`, … suffix. Two chapters created before
 *   either drained is exactly the race the projection cannot see.
 */
import { createRepositories, type SqlDatabase } from "@authorbot/database";
import {
  applyChapterReplacement,
  parseChapterMarkdown,
  scanSafety,
} from "@authorbot/markdown";
import type {
  BookRepoWriter,
  ChapterComposeContext,
  ChapterComposeOutcome,
  ChapterComposer,
} from "@authorbot/repo-coordinator";
import { chapterFrontmatterSchema, type ChapterFrontmatter } from "@authorbot/schemas";
import { stringify } from "yaml";
import { sha256Hex } from "./crypto.js";
import type { Clock } from "./deps.js";

/** Directory new chapters are written to when a book has none yet. */
export const DEFAULT_CHAPTER_DIR = "chapters";

/** Order gap between consecutive chapters (contract §3.5: "last + 10"). */
export const ORDER_STEP = 10;

/** Bound on slug de-duplication attempts before we admit defeat. */
const MAX_SLUG_ATTEMPTS = 50;

export interface CreateChapterComposerOptions {
  db: SqlDatabase;
  /** Same writer the processor commits through; `readFile` is required. */
  writer: BookRepoWriter;
  clock?: Clock;
}

/** The author intent a `chapter.write` payload carries. */
export interface ChapterWriteIntent {
  title?: string;
  body?: string;
  slug?: string;
  /** `null` removes an existing summary; absent leaves it unchanged. */
  summary?: string | null;
  baseRevision?: number;
}

export function createChapterComposer(options: CreateChapterComposerOptions): ChapterComposer {
  const repos = createRepositories(options.db);

  async function readFile(branch: string, path: string): Promise<string | null> {
    if (options.writer.readFile === undefined) {
      throw new Error("chapter.write requires a writer with readFile");
    }
    return options.writer.readFile(branch, path);
  }

  async function compose(context: ChapterComposeContext): Promise<ChapterComposeOutcome> {
    const { payload, branch, actorRef, actorName } = context;
    const intent = payload.intent as ChapterWriteIntent;

    if (payload.action === "create") {
      return composeCreate(context, intent);
    }

    // revise / publish / unpublish all edit an existing committed chapter.
    const chapter = await repos.chapters.getById(payload.chapterId);
    if (chapter === null) {
      throw new Error(`chapter ${payload.chapterId} is not in the projection`);
    }
    const source = await readFile(branch, chapter.path);
    if (source === null) {
      throw new Error(`chapter source ${chapter.path} not found at branch head`);
    }
    const parsed = parseChapterMarkdown(source);
    const fm = chapterFrontmatterSchema.safeParse(parsed.frontmatter);
    if (!fm.success || fm.data.id !== payload.chapterId) {
      throw new Error(`chapter ${chapter.path}: invalid frontmatter at branch head`);
    }

    if (payload.action === "revise") {
      if (intent.baseRevision !== fm.data.revision) {
        throw new Error(
          `chapter ${payload.chapterId} moved to revision ${fm.data.revision} after the ` +
            `submission's base revision ${String(intent.baseRevision)}`,
        );
      }
      const body = intent.body;
      const summaryBase: ChapterFrontmatter = { ...fm.data };
      if (intent.summary === null) delete summaryBase.summary;
      const nextFrontmatter: ChapterFrontmatter = {
        ...summaryBase,
        revision: fm.data.revision + 1,
        ...(intent.title === undefined ? {} : { title: intent.title }),
        ...(intent.summary === undefined || intent.summary === null
          ? {}
          : { summary: intent.summary }),
        authors: withAuthor(fm.data.authors, actorRef, actorName),
      };
      // Body unchanged (a title/summary-only revise) keeps the committed body
      // byte-for-byte, markers included - re-running the replacement would be
      // a no-op today and a marker churn risk the day the parser changes.
      const content =
        body === undefined
          ? replaceFrontmatter(source, nextFrontmatter)
          : applyChapterReplacement(replaceFrontmatter(source, nextFrontmatter), body).source;
      return finish(context, chapter.path, content, `Revise chapter ${payload.chapterId}`);
    }

    // publish / unpublish
    const publishing = payload.action === "publish";
    if (publishing === (fm.data.status === "published")) {
      throw new Error(
        `chapter ${payload.chapterId} is already ${publishing ? "published" : "unpublished"}`,
      );
    }
    const nextFrontmatter: ChapterFrontmatter = {
      ...fm.data,
      revision: fm.data.revision + 1,
      status: publishing ? "published" : "draft",
      ...(publishing ? { published_at: timestampOf(options.clock) } : {}),
    };
    if (!publishing) {
      delete (nextFrontmatter as { published_at?: string }).published_at;
    }
    return finish(
      context,
      chapter.path,
      replaceFrontmatter(source, nextFrontmatter),
      `${publishing ? "Publish" : "Unpublish"} chapter ${payload.chapterId}`,
    );
  }

  async function composeCreate(
    context: ChapterComposeContext,
    intent: ChapterWriteIntent,
  ): Promise<ChapterComposeOutcome> {
    const { payload, branch, actorRef, actorName } = context;
    if (typeof intent.title !== "string" || typeof intent.body !== "string") {
      throw new Error("chapter create intent requires a title and a body");
    }
    const existing = await repos.chapters.listByProject(context.projectId);
    if (existing.some((row) => row.id === payload.chapterId)) {
      throw new Error(`chapter ${payload.chapterId} already exists`);
    }
    const unknownOrder = existing.find((row) => row.order === null);
    if (unknownOrder !== undefined) {
      throw new Error(
        `chapter ${unknownOrder.id} has no projected order; refresh the repository projection`,
      );
    }
    const order = Math.max(0, ...existing.map((row) => row.order as number)) + ORDER_STEP;
    const directory = chapterDirectory(existing);
    const taken = new Set(existing.map((row) => row.slug));

    // An explicit slug is the author's word; a derived one is the server's
    // guess. The request path already refuses an explicit slug that collides,
    // but it reads the PROJECTION, which under `MIRROR_MODE=queue` is empty
    // until the coordinator alarm drains - so two authors could both be
    // accepted with the same explicit slug and the second would silently ship
    // at `-2`. De-duplicating is only ever right for a slug the server chose:
    // an author who asked for a specific URL and got a different one has to be
    // told, not quietly accommodated, because `slug` is the guarded field
    // whose whole point is that it does not move.
    const explicit = typeof intent.slug === "string";
    const base = intent.slug ?? deriveSlug(intent.title, order);
    let slug = "";
    let path = "";
    let free = false;
    const attempts = explicit ? 1 : MAX_SLUG_ATTEMPTS;
    for (let attempt = 1; attempt <= attempts && !free; attempt += 1) {
      slug = attempt === 1 ? base : `${base}-${attempt}`;
      path = chapterPath(directory, order, slug);
      // Authoritative check: the branch, not the projection (module docs).
      free = !taken.has(slug) && (await readFile(branch, path)) === null;
    }
    if (!free) {
      throw new Error(
        explicit
          ? `slug ${JSON.stringify(base)} is already used by another chapter`
          : `could not find a free slug for chapter title ${JSON.stringify(base)}`,
      );
    }

    const frontmatter: ChapterFrontmatter = chapterFrontmatterSchema.parse({
      schema: "authorbot.chapter/v1",
      id: payload.chapterId,
      slug,
      title: intent.title,
      order,
      status: "draft",
      revision: 1,
      authors: [chapterAuthor(actorRef, actorName)],
      ...(intent.summary === undefined || intent.summary === null
        ? {}
        : { summary: intent.summary }),
    });
    const head = renderFrontmatter(frontmatter);
    const content = applyChapterReplacement(head, intent.body).source;
    return finish(context, path, content, `Create chapter ${payload.chapterId}`);
  }

  /**
   * Last shared gate before bytes reach the outbox's commit: the composed
   * file is re-parsed and re-validated with the Phase 0 rules (frontmatter
   * schema, marker health, no raw HTML, allowed URL schemes) exactly as any
   * other write. The request path already ran these over the author's body;
   * this catches anything the rendering itself could have introduced.
   */
  async function finish(
    context: ChapterComposeContext,
    path: string,
    content: string,
    message: string,
  ): Promise<ChapterComposeOutcome> {
    const findings = chapterValidationFindings(content, context.payload.chapterId);
    if (findings.length > 0) {
      throw new Error(`composed chapter failed validation: ${findings.join("; ")}`);
    }
    const parsed = parseChapterMarkdown(content);
    const fm = chapterFrontmatterSchema.parse(parsed.frontmatter);
    return {
      chapterPath: path,
      content,
      slug: fm.slug,
      title: fm.title,
      summary: fm.summary ?? null,
      order: fm.order,
      status: fm.status,
      revision: fm.revision,
      contentHash: `sha256:${await sha256Hex(content)}`,
      blockIds: parsed.blocks.markers.filter((m) => m.valid).map((m) => m.id),
      message,
    };
  }

  return { compose };
}

/** Phase 0 chapter validation findings for a rendered chapter file. */
export function chapterValidationFindings(content: string, expectedId?: string): string[] {
  const findings: string[] = [];
  const parsed = parseChapterMarkdown(content);
  const fm = chapterFrontmatterSchema.safeParse(parsed.frontmatter);
  if (!fm.success) {
    for (const issue of fm.error.issues) {
      findings.push(`frontmatter ${issue.path.map(String).join(".")}: ${issue.message}`);
    }
  } else if (expectedId !== undefined && fm.data.id !== expectedId) {
    findings.push(`frontmatter id ${fm.data.id} does not match chapter ${expectedId}`);
  }
  for (const marker of parsed.blocks.malformed) {
    findings.push(`malformed block marker: ${marker.reason}`);
  }
  if (parsed.blocks.unmarked.length > 0) {
    findings.push(`${parsed.blocks.unmarked.length} block(s) have no marker`);
  }
  const safety = scanSafety(parsed.ast);
  if (safety.rawHtml.length > 0) {
    findings.push("raw HTML is forbidden in chapter prose");
  }
  for (const url of safety.forbiddenUrls) {
    findings.push(`URL scheme "${url.scheme}" is forbidden`);
  }
  return findings;
}

/**
 * Romanization for the scripts NFKD cannot fold. NFKD only decomposes
 * precomposed *Latin*; it has nothing to say about Cyrillic or Greek, whose
 * characters were therefore erased outright, leaving every title in those
 * scripts with an empty slug. These tables are small and unambiguous and cover
 * a large share of non-Latin European titles. Scripts with no settled
 * one-to-one romanization (CJK, Arabic, Hebrew, Devanagari, Thai) are left to
 * {@link deriveSlug}'s ordinal fallback rather than to a table that would have
 * to make contested choices on an author's behalf.
 */
const ROMANIZATION: Readonly<Record<string, string>> = Object.freeze({
  // Cyrillic
  "\u0430": "a", "\u0431": "b", "\u0432": "v", "\u0433": "g", "\u0434": "d",
  "\u0435": "e", "\u0451": "e", "\u0436": "zh", "\u0437": "z", "\u0438": "i",
  "\u0439": "y", "\u043a": "k", "\u043b": "l", "\u043c": "m", "\u043d": "n",
  "\u043e": "o", "\u043f": "p", "\u0440": "r", "\u0441": "s", "\u0442": "t",
  "\u0443": "u", "\u0444": "f", "\u0445": "kh", "\u0446": "ts", "\u0447": "ch",
  "\u0448": "sh", "\u0449": "shch", "\u044a": "", "\u044b": "y", "\u044c": "",
  "\u044d": "e", "\u044e": "yu", "\u044f": "ya", "\u0456": "i", "\u0457": "yi",
  "\u0454": "ye", "\u0491": "g", "\u045e": "u",
  // Greek
  "\u03b1": "a", "\u03b2": "b", "\u03b3": "g", "\u03b4": "d", "\u03b5": "e",
  "\u03b6": "z", "\u03b7": "i", "\u03b8": "th", "\u03b9": "i", "\u03ba": "k",
  "\u03bb": "l", "\u03bc": "m", "\u03bd": "n", "\u03be": "x", "\u03bf": "o",
  "\u03c0": "p", "\u03c1": "r", "\u03c3": "s", "\u03c2": "s", "\u03c4": "t",
  "\u03c5": "y", "\u03c6": "f", "\u03c7": "ch", "\u03c8": "ps", "\u03c9": "o",
});

/**
 * Kebab-case, path-safe slug from a title (contract §3.5).
 *
 * Latin titles fold to ASCII through NFKD; Cyrillic and Greek are romanized
 * through {@link ROMANIZATION}. A script covered by neither yields nothing to
 * slug, and the honest answer there is a name derived from the chapter's
 * position rather than a pretence that the title survived: `ordinal` gives
 * `chapter-30`, which is at least distinct per chapter.
 *
 * The previous fallback was the bare literal `chapter` for every such title.
 * Because the caller's uniqueness pass appends `-2`, `-3`, … and gives up
 * after {@link MAX_SLUG_ATTEMPTS}, an entire book in an unromanized script got
 * URLs carrying no information about the chapter and then failed outright at
 * the 51st. The slug is editable afterwards, but it is a guarded field
 * precisely because changing it breaks published links, so the first guess has
 * to be usable rather than merely non-empty.
 */
export function deriveSlug(title: string, ordinal?: number): string {
  const slug = title
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    // The map is applied on BOTH sides of the NFKD pass, because the two
    // scripts need opposite orders. Cyrillic \u0439 and \u0451 are precomposed and carry
    // meaning NFKD would throw away (\u0439 romanizes to "y", but decomposing it
    // leaves bare \u0438, i.e. "i"), so they must be mapped first. Greek accented
    // vowels (\u03ac, \u03ce) are not in the map at all and only become mappable
    // once NFKD has stripped the accent, so they must be mapped last. Running
    // the map twice costs nothing: its output is ASCII, which it never matches.
    .split("")
    .map((char) => ROMANIZATION[char] ?? char)
    .join("")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split("")
    .map((char) => ROMANIZATION[char] ?? char)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  if (slug !== "") return slug;
  return ordinal === undefined ? "chapter" : `chapter-${String(ordinal)}`;
}

/** `chapters/0030-the-ridge.md` - order-prefixed so `git ls` reads in order. */
export function chapterPath(directory: string, order: number, slug: string): string {
  return `${directory}/${String(Math.max(order, 0)).padStart(4, "0")}-${slug}.md`;
}

/** Directory existing chapters live in; `chapters/` for an empty book. */
function chapterDirectory(existing: readonly { path: string }[]): string {
  for (const row of existing) {
    const cut = row.path.lastIndexOf("/");
    if (cut > 0) {
      return row.path.slice(0, cut);
    }
  }
  return DEFAULT_CHAPTER_DIR;
}

/** Append the actor to `authors` when new, preserving existing order. */
function withAuthor(
  authors: ReadonlyArray<ChapterFrontmatter["authors"][number]>,
  actorRef: string,
  actorName?: string,
): ChapterFrontmatter["authors"] {
  const known = authors.some((author) => author.actor === actorRef);
  return known
    ? authors.map((author) =>
        author.actor === actorRef && actorName !== undefined
          ? { ...author, name: actorName }
          : { ...author },
      )
    : [...authors, chapterAuthor(actorRef, actorName)];
}

function chapterAuthor(
  actorRef: string,
  actorName?: string,
): ChapterFrontmatter["authors"][number] {
  return { actor: actorRef, ...(actorName === undefined ? {} : { name: actorName }) };
}

/**
 * Replace a chapter file's frontmatter, keeping the body byte-for-byte.
 *
 * Field order is pinned to the canonical order rather than inherited, because
 * a create renders from nothing and a revise must produce the same bytes for
 * the same content - a chapter whose frontmatter order depends on how it was
 * first written is a diff nobody can read.
 */
export function replaceFrontmatter(source: string, frontmatter: ChapterFrontmatter): string {
  const normalized = source.replace(/\r\n/g, "\n");
  let body = normalized;
  if (normalized.startsWith("---\n")) {
    const close = normalized.indexOf("\n---\n", 3);
    if (close === -1) {
      throw new Error("chapter file: unterminated frontmatter");
    }
    body = normalized.slice(close + 5);
  }
  const head = renderFrontmatter(frontmatter);
  // `body` still carries the blank line that separated the old frontmatter
  // from the first block, and `renderFrontmatter` already ends with `---\n`.
  // Joining with another `\n` therefore added one blank line per edit, so
  // every publish, unpublish, and title-only revise grew the file and changed
  // its `contentHash` for a no-op round trip - a publish→unpublish pair never
  // returned the author's committed prose to its original bytes. Normalizing
  // to exactly one separator makes the operation byte-idempotent, which is
  // what the docstring above promises.
  return body === "" ? head : `${head}\n${body.replace(/^\n+/, "")}`;
}

const FIELD_ORDER = [
  "schema",
  "id",
  "slug",
  "title",
  "order",
  "status",
  "revision",
  "published_at",
  "authors",
  "summary",
  "timeline_refs",
  "character_refs",
] as const;

/** Canonical `---\n…\n---\n` frontmatter block for a chapter. */
export function renderFrontmatter(frontmatter: ChapterFrontmatter): string {
  // Insertion order is emission order in `yaml`, so an explicitly ordered
  // plain object is all the canonicalisation this needs.
  const ordered: Record<string, unknown> = {};
  const record = frontmatter as unknown as Record<string, unknown>;
  for (const field of FIELD_ORDER) {
    const value = record[field];
    if (value !== undefined) {
      ordered[field] = value;
    }
  }
  return `---\n${stringify(ordered, { indent: 2, lineWidth: 0 })}---\n`;
}

function timestampOf(clock: Clock | undefined): string {
  const date = clock?.now() ?? new Date();
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
