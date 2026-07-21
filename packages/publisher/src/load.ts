import path from "node:path";
import { parseChapterMarkdown } from "@authorbot/markdown";
import {
  bookConfigSchema,
  chapterFrontmatterSchema,
  characterSchema,
  storyGraphSchema,
  timelineSchema,
  type BookConfig,
  type ChapterFrontmatter,
  type StoryGraphNode,
} from "@authorbot/schemas";
import { parse as parseYaml } from "yaml";
import { expandGlob, readTextIfExists } from "./fs-utils.js";
import type {
  OutlineNode,
  SiteChapter,
  SiteCharacter,
  SiteModel,
  TimelineRow,
} from "./model.js";
import { renderAstToHtml } from "./render.js";

/** Unusable repository or I/O problem (CLI exit code 2). */
export class PublisherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublisherError";
  }
}

export interface LoadSiteModelOptions {
  repoPath: string;
  baseUrl?: string | undefined;
  includeDrafts?: boolean | undefined;
  /** Collaboration API base URL; overrides `publication.api_url` (2b §1). */
  apiUrl?: string | undefined;
  /** Surface the dev-login form in the islands (local testing only). */
  devLogin?: boolean | undefined;
}

export interface LoadedSite {
  model: SiteModel;
  /** Non-fatal problems (skipped records); relevant under `--force`. */
  warnings: string[];
}

const DEFAULT_CHAPTERS_GLOB = "chapters/*.md";
const DEFAULT_CHARACTERS_GLOB = "story/characters/*.md";
const DEFAULT_OUTLINE_PATH = "story/outline.yml";
const DEFAULT_TIMELINE_PATH = "story/timeline.yml";
const DEFAULT_CHAPTER_URL = "/chapters/{slug}/";

/** Normalize `--base-url` (full URL or path) to a `/`-wrapped base path. */
export function basePathOf(baseUrl: string | undefined): string {
  if (baseUrl === undefined || baseUrl === "") {
    return "/";
  }
  let base = baseUrl;
  try {
    base = new URL(baseUrl).pathname;
  } catch {
    // not an absolute URL: treat it as a path
  }
  if (!base.startsWith("/")) {
    base = `/${base}`;
  }
  if (!base.endsWith("/")) {
    base = `${base}/`;
  }
  return base;
}

/** One base-path segment: no slashes, no encoding tricks, no dot-segments. */
const API_BASE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

/**
 * Resolve the collaboration config (Phase 2b contract §1, as amended by
 * ADR-0019): the `--api-url` flag overrides `publication.api_url`; absent
 * both, collaboration is off and the build stays byte-comparable with a pre-2b
 * site.
 *
 * **Only a root-relative path is accepted** - `/` for an API at the origin
 * root, or a base path such as `/my-book` for a book served under a subpath
 * (ADR-0019 §5-§6). An absolute http(s) URL is rejected at build time: the API
 * is same-origin with the site by design, so an absolute URL is either
 * redundant or describes a deployment shape that no longer exists, and
 * discovering that at build time beats discovering it as a browser CORS error
 * after publishing.
 */
export function resolveCollab(
  book: BookConfig,
  options: Pick<LoadSiteModelOptions, "apiUrl" | "devLogin">,
): SiteModel["collab"] {
  const configured = options.apiUrl ?? book.publication?.api_url;
  if (configured === undefined || configured === "") {
    return null;
  }
  return {
    apiBase: normalizeApiBase(configured),
    projectSlug: book.slug,
    showPublicAnnotations: book.publication?.show_public_annotations === true,
    devLogin: options.devLogin === true,
  };
}

/**
 * `publication.api_url` → the prefix the islands build every request URL from
 * (`${apiBase}/v1/...`). `"/"` yields `""`; `"/my-book/"` yields `"/my-book"`.
 * Must agree with the Worker's `API_BASE_PATH`.
 */
export function normalizeApiBase(configured: string): string {
  const value = configured.trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    throw new PublisherError(
      `api url "${configured}" must be a root-relative path such as "/" or "/my-book", ` +
        `not an absolute URL. Authorbot serves the collaboration API from the same origin ` +
        `as the published site; cross-origin deployment is not supported (ADR-0019).`,
    );
  }
  if (!value.startsWith("/")) {
    throw new PublisherError(
      `api url "${configured}" must be a root-relative path starting with "/" (ADR-0019)`,
    );
  }
  if (value.includes("?") || value.includes("#")) {
    throw new PublisherError(
      `api url "${configured}" must not contain a query string or fragment`,
    );
  }
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed === "") {
    // `/`: the API is mounted at the site origin's root. The empty base
    // yields correct root-relative URLs (`/v1/...`).
    return "";
  }
  const segments = trimmed.slice(1).split("/");
  for (const segment of segments) {
    if (!API_BASE_SEGMENT.test(segment) || segment === "." || segment === "..") {
      throw new PublisherError(
        `api url "${configured}" has an invalid path segment "${segment}" ` +
          `(expected segments of [A-Za-z0-9._~-], no empty or dot segments)`,
      );
    }
  }
  return `/${segments.join("/")}`;
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Top-level route segments reserved by the publisher's own output (Phase 1
 * contract section 2 tree): the story views, Astro's asset directory, the
 * build manifest, and the site index file. A chapter routed under any of
 * these would silently shadow or be shadowed by a static page. Compared
 * lowercased so case-insensitive filesystems cannot smuggle a collision.
 */
const RESERVED_TOP_SEGMENTS: ReadonlySet<string> = new Set([
  "story",
  "_astro",
  "authorbot-build.json",
  "index.html",
]);

/**
 * Expand `publication.chapter_url` (e.g. `/chapters/{slug}/`) for one slug
 * into a root-relative route path like `chapters/baseline`. The pattern must
 * contain `{slug}` (otherwise every chapter collapses onto one route and all
 * but one silently vanish), every segment must be path-safe, and the route
 * must stay out of the reserved static routes; anything else is a hard error
 * even under `--force`.
 */
export function chapterRoutePath(pattern: string, slug: string): string {
  if (!pattern.includes("{slug}")) {
    throw new PublisherError(
      `publication.chapter_url "${pattern}" does not contain {slug}: every chapter would share one route`,
    );
  }
  const expanded = pattern.replaceAll("{slug}", slug);
  const segments = expanded.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new PublisherError(
      `publication.chapter_url "${pattern}" expands to an empty path`,
    );
  }
  for (const segment of segments) {
    if (!SAFE_SEGMENT.test(segment) || segment === "..") {
      throw new PublisherError(
        `publication.chapter_url "${pattern}" produces unsafe path segment "${segment}"`,
      );
    }
  }
  const first = segments[0];
  if (first !== undefined && RESERVED_TOP_SEGMENTS.has(first.toLowerCase())) {
    throw new PublisherError(
      `publication.chapter_url "${pattern}" routes chapter "${slug}" under the reserved path "${first}/"`,
    );
  }
  return segments.join("/");
}

/** Parse optional YAML; on failure warn and return undefined (page omitted). */
function parseYamlSafe(
  source: string | undefined,
  label: string,
  warnings: string[],
): unknown {
  if (source === undefined) {
    return undefined;
  }
  try {
    return parseYaml(source);
  } catch {
    warnings.push(`${label} is not valid YAML; page omitted`);
    return undefined;
  }
}

async function loadBook(repoPath: string): Promise<BookConfig> {
  const source = await readTextIfExists(path.join(repoPath, "book.yml"));
  if (source === undefined) {
    throw new PublisherError("book.yml is absent or unreadable");
  }
  let data: unknown;
  try {
    data = parseYaml(source);
  } catch (error) {
    throw new PublisherError(
      `book.yml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = bookConfigSchema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new PublisherError(
      `book.yml fails the authorbot.book/v1 schema` +
        (first === undefined ? "" : `: ${first.path.join(".")}: ${first.message}`),
    );
  }
  return result.data;
}

interface RepoChapter {
  frontmatter: ChapterFrontmatter;
  html: string;
}

async function loadRepoChapters(
  repoPath: string,
  chaptersGlob: string,
  rawHtmlAllowed: boolean,
  warnings: string[],
): Promise<RepoChapter[]> {
  const chapters: RepoChapter[] = [];
  for (const abs of await expandGlob(repoPath, chaptersGlob)) {
    const rel = path.relative(repoPath, abs).split(path.sep).join("/");
    const source = await readTextIfExists(abs);
    if (source === undefined) {
      warnings.push(`skipped unreadable chapter file ${rel}`);
      continue;
    }
    const parsed = parseChapterMarkdown(source);
    const result = chapterFrontmatterSchema.safeParse(parsed.frontmatter);
    if (!result.success) {
      warnings.push(`skipped ${rel}: frontmatter fails authorbot.chapter/v1`);
      continue;
    }
    chapters.push({
      frontmatter: result.data,
      html: renderAstToHtml(parsed.ast, { rawHtmlAllowed }),
    });
  }
  return chapters;
}

interface LoadedCharacter {
  character: SiteCharacter;
  refsId: string;
}

async function loadCharacters(
  repoPath: string,
  charactersGlob: string,
  rawHtmlAllowed: boolean,
  basePath: string,
  warnings: string[],
): Promise<LoadedCharacter[]> {
  const characters: LoadedCharacter[] = [];
  /** Character id -> repo-relative path of the record that owns it. */
  const ownerById = new Map<string, string>();
  for (const abs of await expandGlob(repoPath, charactersGlob)) {
    const rel = path.relative(repoPath, abs).split(path.sep).join("/");
    const source = await readTextIfExists(abs);
    if (source === undefined) {
      warnings.push(`skipped unreadable character file ${rel}`);
      continue;
    }
    const parsed = parseChapterMarkdown(source);
    const result = characterSchema.safeParse(parsed.frontmatter);
    if (!result.success) {
      warnings.push(`skipped ${rel}: frontmatter fails authorbot.character/v1`);
      continue;
    }
    const record = result.data;
    // Duplicate ids would collapse onto one detail page (last record silently
    // replacing the first): keep the first record, skip the rest with a
    // warning. The validate gate reports this as an error before any build.
    const owner = ownerById.get(record.id);
    if (owner !== undefined) {
      warnings.push(
        `skipped ${rel}: character id "${record.id}" is already defined by ${owner}`,
      );
      continue;
    }
    ownerById.set(record.id, rel);
    const slug = record.id.slice("character:".length);
    const character: SiteCharacter = {
      id: record.id,
      slug,
      name: record.name,
      aliases: record.aliases ?? [],
      href: `${basePath}story/characters/${slug}/`,
      html: renderAstToHtml(parsed.ast, { rawHtmlAllowed }),
      chapters: [],
    };
    if (record.summary !== undefined) {
      character.summary = record.summary;
    }
    if (record.status !== undefined) {
      character.status = record.status;
    }
    characters.push({ character, refsId: record.id });
  }
  characters.sort((a, b) => a.character.name.localeCompare(b.character.name));
  return characters;
}

function buildOutline(
  data: unknown,
  includedById: ReadonlyMap<string, SiteChapter>,
  warnings: string[],
): OutlineNode[] | null {
  if (data === undefined) {
    return null;
  }
  const result = storyGraphSchema.safeParse(data);
  if (!result.success) {
    warnings.push("story outline fails authorbot.story-graph/v1; outline page omitted");
    return null;
  }
  const nodes = result.data.nodes;
  const knownIds = new Set(nodes.map((node) => node.id));
  const childrenOf = new Map<string, StoryGraphNode[]>();
  const roots: StoryGraphNode[] = [];
  for (const node of nodes) {
    if (node.parent !== undefined && knownIds.has(node.parent) && node.parent !== node.id) {
      const siblings = childrenOf.get(node.parent);
      if (siblings === undefined) {
        childrenOf.set(node.parent, [node]);
      } else {
        siblings.push(node);
      }
    } else {
      roots.push(node);
    }
  }

  const seen = new Set<string>();
  /** Mark a subtree handled without rendering it (privacy suppression). */
  const suppress = (node: StoryGraphNode): void => {
    if (seen.has(node.id)) {
      return;
    }
    seen.add(node.id);
    for (const child of childrenOf.get(node.id) ?? []) {
      suppress(child);
    }
  };
  const toOutlineNode = (node: StoryGraphNode): OutlineNode | null => {
    seen.add(node.id);
    if (node.type === "chapter" && includedById.get(node.chapter_id) === undefined) {
      // The chapter is not part of this build (draft/proposed/archived, or
      // unresolved under --force): omit its node AND its descendant
      // scenes/beats so unpublished titles and reveals never reach the
      // public site (a build with --include-drafts shows them).
      for (const child of childrenOf.get(node.id) ?? []) {
        suppress(child);
      }
      return null;
    }
    const out: OutlineNode = {
      id: node.id,
      type: node.type,
      order: node.order,
      children: (childrenOf.get(node.id) ?? [])
        .filter((child) => !seen.has(child.id))
        .sort((a, b) => a.order - b.order)
        .map(toOutlineNode)
        .filter((child): child is OutlineNode => child !== null),
    };
    if (node.summary !== undefined) {
      out.summary = node.summary;
    }
    if (node.type === "chapter") {
      const chapter = includedById.get(node.chapter_id);
      const title = node.title ?? chapter?.title;
      if (title !== undefined) {
        out.title = title;
      }
      if (chapter !== undefined) {
        out.chapterHref = chapter.href;
        out.status = chapter.status;
      }
    } else if (node.title !== undefined) {
      out.title = node.title;
    }
    return out;
  };
  const outline = roots
    .sort((a, b) => a.order - b.order)
    .map(toOutlineNode)
    .filter((node): node is OutlineNode => node !== null);

  // Nodes in a parent cycle are reachable from no root and would otherwise
  // vanish silently (their parents all resolve, so schema and reference
  // checks pass): render them as additional top-level entries and warn.
  // Suppressed subtrees are already in `seen` and stay omitted.
  const unreached = nodes.filter((node) => !seen.has(node.id));
  if (unreached.length > 0) {
    warnings.push(
      `story outline has a parent cycle; ${unreached.length} unreachable node(s) rendered as top-level entries`,
    );
    for (const node of [...unreached].sort((a, b) => a.order - b.order)) {
      if (!seen.has(node.id)) {
        const rendered = toOutlineNode(node);
        if (rendered !== null) {
          outline.push(rendered);
        }
      }
    }
  }
  return outline;
}

function buildTimeline(
  data: unknown,
  characters: LoadedCharacter[],
  includedById: ReadonlyMap<string, SiteChapter>,
  warnings: string[],
): SiteModel["timeline"] {
  if (data === undefined) {
    return null;
  }
  const result = timelineSchema.safeParse(data);
  if (!result.success) {
    warnings.push("timeline fails authorbot.timeline/v1; timeline page omitted");
    return null;
  }
  const charactersById = new Map(
    characters.map((entry) => [entry.refsId, entry.character]),
  );
  const events: TimelineRow[] = [...result.data.events]
    .sort((a, b) => a.sort_key - b.sort_key)
    .flatMap((event) => {
      // Chapter references resolve against INCLUDED chapters only: an
      // excluded (draft/proposed/archived) chapter's frontmatter title must
      // never leak into the public timeline. An event whose every chapter
      // reference points at an excluded chapter belongs to that chapter's
      // reveal, so the whole row stays private until the chapter publishes
      // (or the build runs with --include-drafts).
      const refs = event.chapter_refs ?? [];
      const chapters = refs.flatMap((id) => {
        const included = includedById.get(id);
        return included === undefined
          ? []
          : [{ title: included.title, href: included.href }];
      });
      if (refs.length > 0 && chapters.length === 0) {
        return [];
      }
      return [
        {
          id: event.id,
          sortKey: event.sort_key,
          displayTime: event.display_time,
          title: event.title,
          participants: (event.participants ?? []).map((ref) => {
            const character = charactersById.get(ref);
            if (character === undefined) {
              return { id: ref, name: ref.slice("character:".length) };
            }
            return { id: ref, name: character.name, href: character.href };
          }),
          locations: (event.locations ?? []).map((ref) => ref.slice("location:".length)),
          chapters,
        },
      ];
    });
  const timeline: NonNullable<SiteModel["timeline"]> = { events };
  const calendar = result.data.calendar;
  if (calendar !== undefined) {
    timeline.calendar = calendar.epoch_label ?? calendar.type;
  }
  return timeline;
}

/**
 * Load a book repository into the JSON-serializable {@link SiteModel}.
 * Chapters with `status: published` are included by default; `includeDrafts`
 * adds `draft`/`proposed`; `archived` is never included (Phase 1 contract
 * section 2). Records that fail their schema are skipped with a warning -
 * the CLI's validate-gate makes that unreachable except under `--force`.
 */
export async function loadSiteModel(options: LoadSiteModelOptions): Promise<LoadedSite> {
  const repoPath = path.resolve(options.repoPath);
  const includeDrafts = options.includeDrafts === true;
  const warnings: string[] = [];

  const book = await loadBook(repoPath);
  const rawHtmlAllowed = book.content?.raw_html === true;
  const chaptersGlob = book.content?.chapters_glob ?? DEFAULT_CHAPTERS_GLOB;
  const charactersGlob = book.planning?.characters_glob ?? DEFAULT_CHARACTERS_GLOB;
  const outlinePath = book.planning?.outline ?? DEFAULT_OUTLINE_PATH;
  const timelinePath = book.planning?.timeline ?? DEFAULT_TIMELINE_PATH;
  const chapterUrl = book.publication?.chapter_url ?? DEFAULT_CHAPTER_URL;
  const basePath = basePathOf(options.baseUrl);

  const repoChapters = await loadRepoChapters(
    repoPath,
    chaptersGlob,
    rawHtmlAllowed,
    warnings,
  );

  const included: SiteChapter[] = repoChapters
    .filter((chapter) => {
      const status = chapter.frontmatter.status;
      if (status === "published") {
        return true;
      }
      return includeDrafts && (status === "draft" || status === "proposed");
    })
    .map((chapter) => {
      const fm = chapter.frontmatter;
      const routePath = chapterRoutePath(chapterUrl, fm.slug);
      const site: SiteChapter = {
        id: fm.id,
        slug: fm.slug,
        title: fm.title,
        order: fm.order,
        status: fm.status as SiteChapter["status"],
        revision: fm.revision,
        authors: fm.authors.map((author) => author.actor),
        path: routePath,
        href: `${basePath}${routePath}/`,
        html: chapter.html,
        isDraft: fm.status !== "published",
      };
      if (fm.summary !== undefined) {
        site.summary = fm.summary;
      }
      if (fm.published_at !== undefined) {
        site.publishedAt = fm.published_at;
      }
      return site;
    })
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));

  // Route uniqueness is a hard error even under --force: a collision makes
  // Astro silently emit only one of the colliding pages while the manifest
  // still lists every chapter (Phase 1 contract section 6 exit criterion 1).
  const routeOwner = new Map<string, string>();
  for (const chapter of included) {
    const owner = routeOwner.get(chapter.path);
    if (owner !== undefined) {
      throw new PublisherError(
        `chapters "${owner}" and "${chapter.slug}" expand publication.chapter_url ` +
          `"${chapterUrl}" to the same route "/${chapter.path}/"`,
      );
    }
    routeOwner.set(chapter.path, chapter.slug);
  }

  const includedById = new Map(included.map((chapter) => [chapter.id, chapter]));

  const characters = await loadCharacters(
    repoPath,
    charactersGlob,
    rawHtmlAllowed,
    basePath,
    warnings,
  );
  // Chapters referencing each character, in reading order.
  const refsByCharacter = new Map<string, { title: string; href: string }[]>();
  for (const chapter of repoChapters) {
    const includedChapter = includedById.get(chapter.frontmatter.id);
    if (includedChapter === undefined) {
      continue;
    }
    for (const ref of chapter.frontmatter.character_refs ?? []) {
      const list = refsByCharacter.get(ref) ?? [];
      list.push({ title: includedChapter.title, href: includedChapter.href });
      refsByCharacter.set(ref, list);
    }
  }
  for (const entry of characters) {
    const refs = refsByCharacter.get(entry.refsId);
    if (refs !== undefined) {
      const order = new Map(included.map((chapter, index) => [chapter.href, index]));
      entry.character.chapters = [...refs].sort(
        (a, b) => (order.get(a.href) ?? 0) - (order.get(b.href) ?? 0),
      );
    }
  }

  const outlineSource = await readTextIfExists(path.join(repoPath, outlinePath));
  const outline = buildOutline(
    parseYamlSafe(outlineSource, "story outline", warnings),
    includedById,
    warnings,
  );

  const timelineSource = await readTextIfExists(path.join(repoPath, timelinePath));
  const timeline = buildTimeline(
    parseYamlSafe(timelineSource, "timeline", warnings),
    characters,
    includedById,
    warnings,
  );

  const model: SiteModel = {
    book: {
      title: book.title,
      slug: book.slug,
      language: book.language,
      showRevision: book.publication?.show_revision === true,
      showAttribution: book.publication?.show_attribution === true,
    },
    basePath,
    includeDrafts,
    chapters: included,
    outline,
    timeline,
    characters: characters.map((entry) => entry.character),
    collab: resolveCollab(book, options),
  };
  if (book.license !== undefined) {
    model.book.license = book.license;
  }
  return { model, warnings };
}
