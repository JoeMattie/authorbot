import path from "node:path";
import { loadBookConfig } from "./book.js";
import { loadChapters } from "./chapters.js";
import { FindingCollector, type ValidationReport } from "./findings.js";
import { isDirectory } from "./fs-utils.js";
import { checkAuthorbotRecords } from "./records.js";
import { checkStoryGraph } from "./story-graph.js";
import { checkChapterWorldRefs, loadStoryWorld } from "./story-world.js";

/** Thrown when the repository path itself cannot be used (CLI exit code 2). */
export class RepoAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoAccessError";
  }
}

/**
 * Validate an Authorbot book repository per Phase 0 contract section 5.
 *
 * Schema validation uses `@authorbot/schemas`; block markers, raw-HTML,
 * URL-scheme, and work-item delimiter checks use `@authorbot/markdown`;
 * cross-reference checks follow the contract section 5 table.
 *
 * Throws {@link RepoAccessError} when `rootDir` is not a readable directory;
 * every other problem becomes a finding in the returned report.
 */
export async function validateBookRepo(rootDir: string): Promise<ValidationReport> {
  const root = path.resolve(rootDir);
  if (!(await isDirectory(root))) {
    throw new RepoAccessError(`not a readable directory: ${rootDir}`);
  }
  const findings = new FindingCollector();
  const book = await loadBookConfig(root, findings);
  const chapters = await loadChapters(root, book, findings);
  const world = await loadStoryWorld(root, book, chapters.byId, findings);
  checkChapterWorldRefs(chapters.list, world, findings);
  await checkStoryGraph(root, book, chapters.byId, world, findings);
  await checkAuthorbotRecords(root, chapters.byId, findings);
  return findings.report();
}

export { DEFAULT_BOOK_SETTINGS, loadBookConfig, type BookSettings } from "./book.js";
export { loadChapters, type ChapterIndex, type ChapterInfo } from "./chapters.js";
export {
  FindingCollector,
  VALIDATION_CODES,
  type Finding,
  type FindingSeverity,
  type ValidationCode,
  type ValidationReport,
} from "./findings.js";
export { checkAuthorbotRecords } from "./records.js";
export { checkStoryGraph } from "./story-graph.js";
export { checkChapterWorldRefs, loadStoryWorld, type StoryWorld } from "./story-world.js";
