/**
 * `@authorbot/repo-coordinator` — artifact rendering, the outbox processor,
 * and the `BookRepoWriter` seam.
 *
 * **Every module reachable from this barrel is pure**: top-level code
 * declares constants, functions and classes and nothing else — no
 * registration, no I/O, no global mutation at import time. `package.json`
 * therefore declares `"sideEffects": false`, and that declaration is load
 * bearing rather than cosmetic:
 *
 * `apps/api` imports the processor and the artifact renderers through this
 * barrel, which also re-exports `LocalGitAdapter` from `local-git.js`, which
 * imports `node:child_process`. Nothing on the Worker path ever *calls* the
 * adapter (the Durable Object commits through `GitHubBookRepoWriter`), but
 * without the side-effect declaration the bundler must assume the module
 * matters and ships it — putting a node-only module inside a Worker that can
 * never legally run it. With it, `local-git.js` is dropped entirely.
 *
 * So: if a module here ever acquires genuine import-time behaviour, remove
 * the `sideEffects` flag in the same change, or the bundler will silently
 * discard it.
 */
export {
  annotationDirectory,
  annotationFilePath,
  renderAnnotationArtifact,
  renderReplyArtifact,
  replyFilePath,
  type AnnotationArtifactInput,
  type AnnotationArtifactScope,
  type RenderedFile,
  type ReplyArtifactInput,
} from "./render.js";
export {
  BOOK_CONFIG_PATH,
  orderBookConfig,
  renderBookConfigArtifact,
} from "./book-config-artifact.js";
export {
  decisionFilePath,
  parseDecisionArtifact,
  renderDecisionArtifact,
  type DecisionArtifactInput,
  type ParsedDecisionArtifact,
} from "./decision-artifact.js";
export {
  COMPLETION_HEADING,
  DEFAULT_ACCEPTANCE_CRITERIA,
  DEFAULT_CONFLICT_ACCEPTANCE_CRITERIA,
  escapeWorkItemText,
  ORIGINAL_TEXT_END,
  ORIGINAL_TEXT_ESCAPE,
  ORIGINAL_TEXT_START,
  parseWorkItemArtifact,
  renderWorkItemArtifact,
  SUBMISSION_TYPE_BY_WORK_TYPE,
  SUBMITTED_TEXT_END,
  SUBMITTED_TEXT_START,
  unescapeWorkItemText,
  WORK_ITEM_SECTION_HEADINGS,
  workItemFilePath,
  type ParsedWorkItemArtifact,
  type WorkItemArtifactInput,
  type WorkItemArtifactSections,
  type WorkItemCompletion,
} from "./work-item-artifact.js";
export {
  appendAttributionEntry,
  attributionFilePath,
  parseAttributionArtifact,
  renderAttributionArtifact,
  type AppendAttributionResult,
  type AttributionEntryInput,
} from "./attribution-artifact.js";
export {
  applyChapterFrontmatterUpdate,
  type ChapterFrontmatterUpdate,
  type UpdatedChapterFile,
} from "./chapter-artifact.js";
export {
  ACTOR_TRAILER,
  ANNOTATION_TRAILER,
  BASE_REVISION_TRAILER,
  CHAPTER_TRAILER,
  formatCommitMessage,
  GitWriteError,
  isGitWriteError,
  OPERATION_TRAILER,
  WORK_ITEM_TRAILER,
  type BookRepoWriter,
  type CommitFile,
  type CommitFilesInput,
  type CommitFilesResult,
  type GitWriteFailure,
} from "./writer.js";
export { LocalGitAdapter, type LocalGitAdapterOptions } from "./local-git.js";
export { GitHubAdapter, type GitHubAdapterOptions } from "./github.js";
export {
  createProcessor,
  OUTBOX_KINDS,
  SYSTEM_APPLY_REF,
  SYSTEM_CLOCK,
  SYSTEM_RULE_ENGINE_REF,
  type AnnotationCreatePayload,
  type AnnotationWithdrawPayload,
  type BookConfigUpdatePayload,
  type ChapterComposeContext,
  type ChapterComposeOutcome,
  type ChapterComposer,
  type ChapterWriteAction,
  type ChapterWritePayload,
  type Clock,
  type CreateProcessorOptions,
  type DecisionCreatePayload,
  type DecisionUpdatePayload,
  type DrainResult,
  type DrainRowOutcome,
  type OutboxKind,
  type Processor,
  type ReplyCreatePayload,
  type SubmissionApplier,
  type SubmissionApplyContext,
  type SubmissionApplyOutcome,
  type SubmissionApplyPayload,
  type WorkItemUpdatePayload,
} from "./processor.js";
