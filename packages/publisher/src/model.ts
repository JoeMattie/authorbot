/**
 * The site model handed to the Astro templates. Every value here must be
 * JSON-serializable: the model crosses into the Astro build through a Vite
 * virtual module whose source is `JSON.stringify(model)` (see build.ts and
 * the package README).
 *
 * Prose (`html` fields) is pre-rendered by `render.ts` from the mdast AST -
 * escaped, anchored, and sanitized - so the templates only ever inject it
 * with `set:html` inside a fixed layout.
 */

/** Chapter statuses that can appear in a build (archived is never included). */
export type IncludedChapterStatus = "draft" | "proposed" | "published";

export interface ChapterCredit {
  actor: string;
  label: string;
  /**
   * Accepted chapter revisions durably credited to this actor by the
   * repository attribution artifact. Empty when an older/manual repository
   * has only the frontmatter credit and cannot support an exact history link.
   */
  acceptedRevisions: number[];
}

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
  /** Ready-to-render names, using an agent token name when one was captured. */
  authorLabels: string[];
  /** First frontmatter credit: the chapter's originating author. */
  primaryAuthor: ChapterCredit | null;
  /** Later accepted prose/metadata credits, deduplicated in first-seen order. */
  contributors: ChapterCredit[];
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
  /** Scene planning fields, when the story graph provides them. */
  goal?: string;
  conflict?: string;
  outcome?: string;
  /** Relationships whose source and target are both visible in this build. */
  relationships: { type: string; targetTitle: string }[];
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
  facts: string[];
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
  /** Repository-relative canonical character document, for authorized editing. */
  sourcePath: string;
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
  /**
   * Root-relative API base path, normalized (ADR-0019 §5): `""` when the API
   * is at the origin root, otherwise a leading-slash, no-trailing-slash prefix
   * such as `/my-book`. The islands build every request URL as
   * `${apiBase}/v1/...`, so this must match the Worker's `API_BASE_PATH`.
   *
   * There is no companion origin: the API is always same-origin with the site,
   * so the CSP `connect-src 'self'` covers it (ADR-0019 §1).
   */
  apiBase: string;
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
  /** Author-selected planning method, when `book.yml` names one. */
  planningMethod?: string;
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
  /** Canonical repository paths used by the authorized planning editors. */
  planningDocuments: {
    outlinePath: string;
    timelinePath: string;
  };
  /** Collaboration-islands config, or null for a script-free build. */
  collab: SiteCollab | null;
  /** Present only in `authorbot dev`; never serialized into a production build. */
  localDev?: {
    bootstrapPath: string;
  };
}
