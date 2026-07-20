/**
 * Typed `GitHubAdapter` stub (Phase 2 contract §5). Real GitHub App Git
 * writes (Git Data API blob/tree/commit/ref sequence, design §14.2) are a
 * Phase 5 deliverable; until then every call throws `not-implemented`.
 */
import {
  GitWriteError,
  type BookRepoWriter,
  type CommitFilesInput,
  type CommitFilesResult,
} from "./writer.js";

export interface GitHubAdapterOptions {
  /** Repository coordinates, e.g. `JoeMattie/causal-projector`. */
  repo: string;
  /** GitHub App installation id (short-lived installation tokens, §14.1). */
  installationId?: string;
}

export class GitHubAdapter implements BookRepoWriter {
  constructor(readonly options: GitHubAdapterOptions) {}

  commitFiles(_input: CommitFilesInput): Promise<CommitFilesResult> {
    return Promise.reject(
      new GitWriteError(
        "not-implemented",
        `GitHubAdapter.commitFiles for ${this.options.repo} is a Phase 5 deliverable; use LocalGitAdapter in Phase 2`,
      ),
    );
  }

  readFile(_branch: string, _filePath: string): Promise<string | null> {
    return Promise.reject(
      new GitWriteError(
        "not-implemented",
        `GitHubAdapter.readFile for ${this.options.repo} is a Phase 5 deliverable; use LocalGitAdapter until then`,
      ),
    );
  }
}
