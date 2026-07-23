/**
 * @authorbot/publisher - read-only static-site publisher (Phase 1 contract
 * sections 1-4): Astro 5 invoked programmatically, sanitized Markdown
 * rendering from the mdast AST, story views, and the `authorbot.build/v1`
 * manifest.
 */

export { buildSite, VIRTUAL_MODULE_ID, type BuildSiteOptions } from "./build.js";
export {
  basePathOf,
  chapterRoutePath,
  loadSiteModel,
  resolveCollab,
  PublisherError,
  type LoadSiteModelOptions,
  type LoadedSite,
} from "./load.js";
export {
  createManifest,
  detectGitCommit,
  publisherVersion,
  type CreateManifestOptions,
} from "./manifest.js";
export {
  escapeHtml,
  renderAstToHtml,
  renderMarkdownToHtml,
  type RenderOptions,
} from "./render.js";
export type {
  ChapterCredit,
  IncludedChapterStatus,
  OutlineNode,
  SiteBook,
  SiteChapter,
  SiteCharacter,
  SiteCollab,
  SiteModel,
  TimelineChapterRef,
  TimelineParticipant,
  TimelineRow,
} from "./model.js";
