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
  ACTOR_TRAILER,
  ANNOTATION_TRAILER,
  formatCommitMessage,
  GitWriteError,
  isGitWriteError,
  OPERATION_TRAILER,
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
  SYSTEM_CLOCK,
  type AnnotationCreatePayload,
  type AnnotationWithdrawPayload,
  type Clock,
  type CreateProcessorOptions,
  type DrainResult,
  type DrainRowOutcome,
  type OutboxKind,
  type Processor,
  type ReplyCreatePayload,
} from "./processor.js";
