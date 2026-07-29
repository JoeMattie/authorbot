import path from "node:path";
import { bookConfigSchema } from "@authorbot/schemas";
import {
  emitSchemaIssues,
  isRecord,
  parseYamlDoc,
  unsafePathReason,
  unsafeRepoPathReason,
} from "./common.js";
import type { FindingCollector } from "./findings.js";
import { isFile, listDirEntries, readTextIfExists } from "./fs-utils.js";

/** Settings the rest of the validator needs, with design section 25 defaults. */
export interface BookSettings {
  /** `content.raw_html` (default false). */
  rawHtmlAllowed: boolean;
  chaptersGlob: string;
  charactersGlob: string;
  outlinePath: string;
  timelinePath: string;
  /** `publication.chapter_url` (default `/chapters/{slug}/`). */
  chapterUrl: string;
}

export const DEFAULT_BOOK_SETTINGS: BookSettings = {
  rawHtmlAllowed: false,
  chaptersGlob: "chapters/*.md",
  charactersGlob: "story/characters/*.md",
  outlinePath: "story/outline.yml",
  timelinePath: "story/timeline.yml",
  chapterUrl: "/chapters/{slug}/",
};

/**
 * Chapter-route rules mirrored from the publisher's `chapterRoutePath`
 * (imported logic would drag the Astro dependency into `validate`): the
 * validate gate must reject exactly what the build hard-errors on, so a
 * green `authorbot validate` is never followed by a failing (or silently
 * colliding) `authorbot build`.
 */
const SAFE_ROUTE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_TOP_SEGMENTS: ReadonlySet<string> = new Set([
  "story",
  "_astro",
  "authorbot-build.json",
  "authorbot-site.json",
  "index.html",
]);

/**
 * The only names a headless build still generates: the data artifacts and
 * the thumbnail dir. Everything else - `index.html` included - is the
 * book's own frontend.
 */
const HEADLESS_RESERVED_TOP_SEGMENTS: ReadonlySet<string> = new Set([
  "_astro",
  "authorbot-build.json",
  "authorbot-site.json",
]);

/**
 * Output roots that exist only in a collaboration build (`/work/`,
 * `/write/`, `/settings/`, `/revisions/`). A `public/` entry shadowing one
 * gets the same warning as the always-generated roots above, but these stay
 * out of {@link RESERVED_TOP_SEGMENTS}: a `chapter_url` routing chapters
 * under them is confusing, not colliding (the pages live at the bare root,
 * chapters under slugs), and erroring would invalidate a book that
 * validates today.
 */
const COLLAB_ROUTE_ROOTS: ReadonlySet<string> = new Set([
  "work",
  "write",
  "settings",
  "revisions",
]);

/**
 * Why the route expanded from `publication.chapter_url` for `slug` is
 * unusable, or null when it is safe (mirrors `@authorbot/publisher`).
 */
export function chapterRouteUnsafeReason(pattern: string, slug: string): string | null {
  const segments = pattern
    .replaceAll("{slug}", slug)
    .split("/")
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return "expands to an empty path";
  }
  for (const segment of segments) {
    if (!SAFE_ROUTE_SEGMENT.test(segment) || segment === "..") {
      return `produces unsafe path segment "${segment}"`;
    }
  }
  const first = segments[0];
  if (first !== undefined && RESERVED_TOP_SEGMENTS.has(first.toLowerCase())) {
    return `routes chapters under the reserved path "${first}/"`;
  }
  return null;
}

/** Pattern-level `publication.chapter_url` checks (per-slug checks live in chapters.ts). */
function checkChapterUrlPattern(findings: FindingCollector, pattern: string): void {
  const pointer = "/publication/chapter_url";
  if (!pattern.includes("{slug}")) {
    findings.error(
      "BOOK_CONFIG_INVALID",
      "book.yml",
      `publication.chapter_url "${pattern}" does not contain {slug}: every chapter would share one route`,
      pointer,
    );
    return;
  }
  const reason = chapterRouteUnsafeReason(pattern, "sample");
  if (reason !== null) {
    findings.error(
      "PATH_UNSAFE",
      "book.yml",
      `publication.chapter_url "${pattern}" ${reason}`,
      pointer,
    );
  }
}

/**
 * `publication.cover_images` entries must live under `public/` because that
 * is the only directory the publisher copies verbatim into the built site;
 * a cover anywhere else would validate here and 404 in production. A path
 * that is safe and well-placed but absent is a warning, not an error, so a
 * book can configure covers before committing the (large, binary) images.
 */
async function checkCoverImages(
  root: string,
  findings: FindingCollector,
  coverImages: unknown,
): Promise<void> {
  if (!Array.isArray(coverImages)) {
    return;
  }
  for (const [index, cover] of coverImages.entries()) {
    if (typeof cover !== "string" || cover.length === 0) {
      continue; // the schema pass reports the type error
    }
    const pointer = `/publication/cover_images/${index}`;
    const reason = unsafeRepoPathReason(cover);
    if (reason !== null) {
      findings.error(
        "PATH_UNSAFE",
        "book.yml",
        `publication.cover_images entry "${cover}" ${reason}`,
        pointer,
      );
      continue;
    }
    if (!cover.startsWith("public/")) {
      findings.error(
        "BOOK_CONFIG_INVALID",
        "book.yml",
        `publication.cover_images entry "${cover}" must live under public/ (the directory copied into the built site)`,
        pointer,
      );
      continue;
    }
    if (!(await isFile(path.join(root, cover)))) {
      findings.warning(
        "BOOK_CONFIG_INVALID",
        "book.yml",
        `publication.cover_images entry "${cover}" does not exist yet; the build will skip it`,
        pointer,
      );
    }
  }
}

/**
 * `public/` is copied verbatim into the site output, so a top-level entry
 * named like a generated route would silently shadow (or be shadowed by)
 * built pages. Warn rather than error: the collision is almost certainly a
 * mistake, but the build itself does not fail on it. A headless build
 * generates no pages, so only the data artifacts stay reserved there - the
 * route roots (including `index.html`) become the book's to use.
 */
async function checkPublicDirCollisions(
  root: string,
  findings: FindingCollector,
  chapterUrl: string,
  headless: boolean,
): Promise<void> {
  const entries = await listDirEntries(path.join(root, "public"));
  if (entries.length === 0) {
    return;
  }
  const chapterRoot = chapterUrl
    .split("/")
    .filter((segment) => segment.length > 0)[0]
    ?.toLowerCase();
  const reservedInMode = headless ? HEADLESS_RESERVED_TOP_SEGMENTS : RESERVED_TOP_SEGMENTS;
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    if (reservedInMode.has(name) || (!headless && (COLLAB_ROUTE_ROOTS.has(name) || (chapterRoot !== undefined && !chapterRoot.includes("{slug}") && name === chapterRoot)))) {
      findings.warning(
        "PATH_UNSAFE",
        `public/${entry.name}`,
        `public/${entry.name} collides with the generated "${name}" output path and may shadow built pages`,
      );
    }
  }
}

/**
 * A headless site serves whatever `public/` provides, so a missing
 * `public/index.html` means the site root 404s in production. A warning,
 * not an error: the book may be mid-migration, or serve its entry from a
 * Worker instead.
 */
async function checkHeadlessEntryPage(
  root: string,
  findings: FindingCollector,
): Promise<void> {
  if (!(await isFile(path.join(root, "public", "index.html")))) {
    findings.warning(
      "BOOK_CONFIG_INVALID",
      "book.yml",
      "publication.mode is headless but public/index.html does not exist; the site root will 404",
      "/publication/mode",
    );
  }
}

function settingPath(
  findings: FindingCollector,
  raw: unknown,
  fallback: string,
  pointer: string,
): string {
  if (typeof raw !== "string" || raw.length === 0) {
    return fallback;
  }
  const reason = unsafeRepoPathReason(raw);
  if (reason !== null) {
    findings.error("PATH_UNSAFE", "book.yml", `configured path "${raw}" ${reason}`, pointer);
    return fallback;
  }
  return raw;
}

/**
 * Load and validate `book.yml`. Always returns usable settings: defaults are
 * applied when the file is missing or invalid so validation can continue.
 */
export async function loadBookConfig(
  root: string,
  findings: FindingCollector,
): Promise<BookSettings> {
  const settings = { ...DEFAULT_BOOK_SETTINGS };
  const source = await readTextIfExists(path.join(root, "book.yml"));
  if (source === undefined) {
    findings.error("BOOK_CONFIG_MISSING", "book.yml", "book.yml is absent or unreadable");
    return settings;
  }
  const parsed = parseYamlDoc(source);
  if (!parsed.ok) {
    findings.error("BOOK_CONFIG_INVALID", "book.yml", `book.yml is not valid YAML: ${parsed.error}`);
    return settings;
  }

  if (isRecord(parsed.data)) {
    const data = parsed.data;
    if (typeof data.slug === "string") {
      const reason = unsafePathReason(data.slug);
      if (reason !== null) {
        findings.error("PATH_UNSAFE", "book.yml", `book slug "${data.slug}" ${reason}`, "/slug");
      }
    }
    const content = isRecord(data.content) ? data.content : {};
    const planning = isRecord(data.planning) ? data.planning : {};
    settings.rawHtmlAllowed = content.raw_html === true;
    settings.chaptersGlob = settingPath(
      findings,
      content.chapters_glob,
      settings.chaptersGlob,
      "/content/chapters_glob",
    );
    settings.charactersGlob = settingPath(
      findings,
      planning.characters_glob,
      settings.charactersGlob,
      "/planning/characters_glob",
    );
    settings.outlinePath = settingPath(
      findings,
      planning.outline,
      settings.outlinePath,
      "/planning/outline",
    );
    settings.timelinePath = settingPath(
      findings,
      planning.timeline,
      settings.timelinePath,
      "/planning/timeline",
    );
    const publication = isRecord(data.publication) ? data.publication : {};
    if (typeof publication.chapter_url === "string" && publication.chapter_url.length > 0) {
      settings.chapterUrl = publication.chapter_url;
      checkChapterUrlPattern(findings, publication.chapter_url);
    }
    await checkCoverImages(root, findings, publication.cover_images);
    const headless = publication.mode === "headless";
    await checkPublicDirCollisions(root, findings, settings.chapterUrl, headless);
    if (headless) {
      await checkHeadlessEntryPage(root, findings);
    }
  }

  const result = bookConfigSchema.safeParse(parsed.data);
  if (!result.success) {
    emitSchemaIssues(findings, "BOOK_CONFIG_INVALID", "book.yml", result.error);
  }
  return settings;
}
