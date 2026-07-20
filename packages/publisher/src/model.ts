/**
 * The site model handed to the Astro templates. Every value here must be
 * JSON-serializable: the model crosses into the Astro build through a Vite
 * virtual module whose source is `JSON.stringify(model)` (see build.ts and
 * the package README).
 *
 * Prose (`html` fields) is pre-rendered by `render.ts` from the mdast AST —
 * escaped, anchored, and sanitized — so the templates only ever inject it
 * with `set:html` inside a fixed layout.
 */

/** Chapter statuses that can appear in a build (archived is never included). */
export type IncludedChapterStatus = "draft" | "proposed" | "published";

export interface SiteChapter {
  id: string;
  slug: string;
  title: string;
  order: number;
  status: IncludedChapterStatus;
  revision: number;
  summary?: string;
  publishedAt?: string;
  /** Actor refs from frontmatter `authors` (e.g. `github:octocat`). */
  authors: string[];
  /**
   * Route path relative to the site root, no leading or trailing slash
   * (e.g. `chapters/baseline`), derived from `publication.chapter_url`.
   */
  path: string;
  /** Absolute href including the base path (e.g. `/chapters/baseline/`). */
  href: string;
  /** Sanitized, pre-rendered prose HTML (block anchors included). */
  html: string;
  /** True for `draft`/`proposed` chapters (drives the draft banner). */
  isDraft: boolean;
}

export interface OutlineNode {
  id: string;
  type: string;
  title?: string;
  summary?: string;
  order: number;
  /** For `chapter` nodes whose chapter is included in this build. */
  chapterHref?: string;
  /** Chapter status shown on chapter nodes when known. */
  status?: string;
  children: OutlineNode[];
}

export interface TimelineParticipant {
  id: string;
  /** Character display name when the character record exists, else the slug. */
  name: string;
  /** Character page href when the character record exists. */
  href?: string;
}

export interface TimelineChapterRef {
  title: string;
  /** Present when the chapter is included in this build. */
  href?: string;
}

export interface TimelineRow {
  id: string;
  sortKey: number;
  displayTime: string;
  title: string;
  participants: TimelineParticipant[];
  /** Location slugs (Phase 1 has no location pages). */
  locations: string[];
  chapters: TimelineChapterRef[];
}

export interface SiteCharacter {
  /** Node id, e.g. `character:mara-voss`. */
  id: string;
  /** Slug part of the id, e.g. `mara-voss`. */
  slug: string;
  name: string;
  aliases: string[];
  summary?: string;
  status?: string;
  href: string;
  /** Sanitized, pre-rendered character body HTML. */
  html: string;
  /** Included chapters whose `character_refs` mention this character. */
  chapters: { title: string; href: string }[];
}

/**
 * Collaboration-islands configuration (Phase 2b contract §1-§2). Present only
 * when the build was given an API base (`publication.api_url` or `--api-url`);
 * `null` disables every collaboration artifact, keeping the output
 * byte-comparable with a pre-2b build.
 */
export interface SiteCollab {
  /** API base URL exactly as configured, without a trailing slash. */
  apiBase: string;
  /**
   * Origin for the CSP `connect-src` directive (contract §3), or null when
   * `apiBase` is a same-origin path (covered by `'self'`).
   */
  apiOrigin: string | null;
  /** Project path parameter for `/v1/projects/{projectId}` (the book slug). */
  projectSlug: string;
  /** `publication.show_public_annotations` (default false). */
  showPublicAnnotations: boolean;
  /** Surface the dev-login form (local testing only; never for production). */
  devLogin: boolean;
}

export interface SiteBook {
  title: string;
  slug: string;
  /** `lang` attribute value, from `book.yml` `language`. */
  language: string;
  license?: string;
  /** `publication.show_revision` (default false). */
  showRevision: boolean;
  /** `publication.show_attribution` (default false). */
  showAttribution: boolean;
}

export interface SiteModel {
  book: SiteBook;
  /** Normalized base path with leading and trailing slash (default `/`). */
  basePath: string;
  includeDrafts: boolean;
  /** Included chapters sorted by `order` (prev/next navigation order). */
  chapters: SiteChapter[];
  /** Outline roots ordered by `order`, or null when the repo has no outline. */
  outline: OutlineNode[] | null;
  /** Timeline rows sorted by `sort_key`, or null when there is no timeline. */
  timeline: { calendar?: string; events: TimelineRow[] } | null;
  /** Characters sorted by name. */
  characters: SiteCharacter[];
  /** Collaboration-islands config, or null for a script-free build. */
  collab: SiteCollab | null;
}
