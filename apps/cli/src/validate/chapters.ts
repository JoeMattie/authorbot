import { scanSafety, type MalformedMarker } from "@authorbot/markdown";
import { chapterFrontmatterSchema } from "@authorbot/schemas";
import { chapterRouteUnsafeReason, type BookSettings } from "./book.js";
import {
  emitSchemaIssues,
  linePointer,
  readFrontmatter,
  truncate,
  unsafePathReason,
} from "./common.js";
import type { FindingCollector, ValidationCode } from "./findings.js";
import { expandGlob, readTextIfExists, repoRelative } from "./fs-utils.js";

/** What later cross-reference checks need to know about one chapter file. */
export interface ChapterInfo {
  /** Repo-relative path. */
  path: string;
  /** Raw frontmatter mapping (present even when schema-invalid). */
  raw: Record<string, unknown> | undefined;
  id: string | undefined;
  slug: string | undefined;
  order: number | undefined;
  revision: number | undefined;
  /** UUIDv7 block IDs declared by this chapter's markers. */
  blockIds: ReadonlySet<string>;
}

export interface ChapterIndex {
  list: ChapterInfo[];
  /** Chapters by UUID (first occurrence wins on duplicates). */
  byId: Map<string, ChapterInfo>;
}

function malformedMessage(marker: MalformedMarker): string {
  switch (marker.reason) {
    case "bad_syntax":
      return `malformed authorbot:block marker: ${truncate(marker.raw)}`;
    case "invalid_id":
      return `block marker id "${marker.id ?? ""}" is not a lowercase UUIDv7`;
    case "missing_block":
      return "block marker is not immediately followed by a semantic block";
    case "not_own_line":
      return "authorbot:block marker must be on its own line, not inline in another block";
  }
}

function reportDuplicates(
  list: ChapterInfo[],
  key: (chapter: ChapterInfo) => string | undefined,
  code: ValidationCode,
  field: string,
  findings: FindingCollector,
): void {
  const seen = new Map<string, ChapterInfo>();
  for (const chapter of list) {
    const value = key(chapter);
    if (value === undefined) {
      continue;
    }
    const first = seen.get(value);
    if (first === undefined) {
      seen.set(value, chapter);
    } else {
      findings.error(
        code,
        chapter.path,
        `chapter ${field} "${value}" is also used by ${first.path}`,
        `/${field}`,
      );
    }
  }
}

/**
 * Load every chapter matched by the chapters glob: frontmatter schema, slug
 * safety, block markers (missing/invalid/duplicate), raw HTML, URL schemes,
 * and chapter-level uniqueness (id, slug, order).
 */
export async function loadChapters(
  root: string,
  book: BookSettings,
  findings: FindingCollector,
): Promise<ChapterIndex> {
  const files = await expandGlob(root, book.chaptersGlob);
  const list: ChapterInfo[] = [];
  const blockSeen = new Map<string, { path: string; line: number | undefined }>();

  for (const abs of files) {
    const rel = repoRelative(root, abs);
    const source = await readTextIfExists(abs);
    if (source === undefined) {
      findings.error("CHAPTER_FRONTMATTER_INVALID", rel, "chapter file is unreadable");
      continue;
    }
    const { fm, fmError, parsed } = readFrontmatter(source);
    const info: ChapterInfo = {
      path: rel,
      raw: fm,
      id: undefined,
      slug: undefined,
      order: undefined,
      revision: undefined,
      blockIds: new Set<string>(),
    };

    if (fmError !== undefined) {
      findings.error(
        "CHAPTER_FRONTMATTER_INVALID",
        rel,
        `frontmatter is not valid YAML: ${fmError}`,
      );
    } else if (fm === undefined) {
      findings.error("CHAPTER_FRONTMATTER_INVALID", rel, "missing YAML frontmatter");
    } else {
      if (typeof fm.id === "string") {
        info.id = fm.id;
      }
      if (typeof fm.slug === "string") {
        info.slug = fm.slug;
        const reason = unsafePathReason(fm.slug);
        if (reason !== null) {
          findings.error("PATH_UNSAFE", rel, `chapter slug "${fm.slug}" ${reason}`, "/slug");
        } else if (
          book.chapterUrl.includes("{slug}") &&
          chapterRouteUnsafeReason(book.chapterUrl, "sample") === null
        ) {
          // Pattern-level problems are reported once against book.yml; this
          // catches routes that only THIS slug makes unusable - e.g.
          // chapter_url "/{slug}/" with a chapter slugged "story", which the
          // build would otherwise silently shadow with a static page.
          const routeReason = chapterRouteUnsafeReason(book.chapterUrl, fm.slug);
          if (routeReason !== null) {
            findings.error(
              "PATH_UNSAFE",
              rel,
              `publication.chapter_url "${book.chapterUrl}" with slug "${fm.slug}" ${routeReason}`,
              "/slug",
            );
          }
        }
      }
      if (typeof fm.order === "number") {
        info.order = fm.order;
      }
      if (typeof fm.revision === "number") {
        info.revision = fm.revision;
      }
      const result = chapterFrontmatterSchema.safeParse(fm);
      if (!result.success) {
        emitSchemaIssues(findings, "CHAPTER_FRONTMATTER_INVALID", rel, result.error);
      }
    }

    // Block markers (contract section 3).
    const blockIds = new Set<string>();
    for (const marker of parsed.blocks.markers) {
      const line = marker.position?.start.line;
      const first = blockSeen.get(marker.id);
      if (first !== undefined) {
        findings.error(
          "BLOCK_ID_DUPLICATE",
          rel,
          `block id "${marker.id}" is already used in ${first.path}` +
            (first.line === undefined ? "" : ` (line ${first.line})`),
          linePointer(line),
        );
      } else {
        blockSeen.set(marker.id, { path: rel, line });
      }
      // Only valid markers (UUIDv7 id AND an immediately following block)
      // identify a block; a dangling marker's id must not resolve annotation
      // targets (contract section 3: a marker identifies the block after it).
      if (marker.valid) {
        blockIds.add(marker.id);
      }
    }
    info.blockIds = blockIds;
    for (const block of parsed.blocks.unmarked) {
      findings.error(
        "BLOCK_ID_MISSING",
        rel,
        `top-level ${block.blockType} has no authorbot:block marker`,
        linePointer(block.position?.start.line),
      );
    }
    for (const marker of parsed.blocks.malformed) {
      findings.error(
        "BLOCK_ID_INVALID",
        rel,
        malformedMessage(marker),
        linePointer(marker.position?.start.line),
      );
    }

    // Safety scan (contract section 5).
    const safety = scanSafety(parsed.ast);
    if (!book.rawHtmlAllowed) {
      for (const finding of safety.rawHtml) {
        findings.error(
          "RAW_HTML_FORBIDDEN",
          rel,
          `raw HTML is forbidden while content.raw_html is false: ${truncate(finding.value)}`,
          linePointer(finding.position?.start.line),
        );
      }
    }
    for (const finding of safety.forbiddenUrls) {
      findings.error(
        "URL_SCHEME_FORBIDDEN",
        rel,
        `${finding.nodeType} URL uses forbidden scheme "${finding.scheme}": ${truncate(finding.url)}`,
        linePointer(finding.position?.start.line),
      );
    }

    list.push(info);
  }

  reportDuplicates(list, (chapter) => chapter.id, "CHAPTER_ID_DUPLICATE", "id", findings);
  reportDuplicates(list, (chapter) => chapter.slug, "CHAPTER_SLUG_DUPLICATE", "slug", findings);
  reportDuplicates(
    list,
    (chapter) => (chapter.order === undefined ? undefined : String(chapter.order)),
    "CHAPTER_ORDER_DUPLICATE",
    "order",
    findings,
  );

  const byId = new Map<string, ChapterInfo>();
  for (const chapter of list) {
    if (chapter.id !== undefined && !byId.has(chapter.id)) {
      byId.set(chapter.id, chapter);
    }
  }
  return { list, byId };
}
