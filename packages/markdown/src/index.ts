/**
 * @authorbot/markdown — Phase 0 markdown responsibilities (design section
 * 6.2 subset, contract sections 3 and 5). No dependency on
 * `@authorbot/schemas`: everything here returns raw parsed data and findings;
 * schema validation and error-code mapping happen in the CLI.
 */

export { parseChapterMarkdown, parseProseMarkdown, type ParsedChapter } from "./parse.js";
export {
  extractBlocks,
  type AssociatedBlockType,
  type BlockScanResult,
  type MalformedMarker,
  type MalformedMarkerReason,
  type MarkerBlock,
  type RequiredBlockType,
  type UnmarkedBlock,
} from "./blocks.js";
export {
  forbiddenUrlScheme,
  isAuthorbotComment,
  scanSafety,
  type ForbiddenUrlFinding,
  type RawHtmlFinding,
  type SafetyScanResult,
} from "./safety.js";
export {
  checkWorkItemDelimiters,
  type DelimiterCheckOptions,
  type DelimiterCheckResult,
  type DelimiterIssue,
  type DelimiterIssueReason,
  type DelimiterSection,
} from "./delimiters.js";
export {
  normalizeBlockText,
  type NormalizedSegment,
  type NormalizedText,
} from "./normalize.js";
export { isUuidv7, UUIDV7_REGEX } from "./uuidv7.js";
export { generateUuidv7 } from "./generate.js";
export {
  buildBlockCharMap,
  mapNormalizedSpanToSource,
  type BlockCharMap,
  type MappedUnit,
} from "./sourcemap.js";
export {
  listMarkedBlocks,
  resolveTarget,
  type MarkedBlock,
  type RangeTarget,
  type ResolutionKind,
  type ResolveResult,
  type ResolvedSpan,
} from "./resolve.js";
export {
  applyBlockReplacement,
  applyChapterReplacement,
  applyRangeReplacement,
  PatchError,
  stripBlockMarkers,
  type BlockReplacementResult,
  type ChapterReplacementResult,
  type PatchErrorCode,
  type PatchOptions,
  type RangeReplacementResult,
} from "./patch.js";
