/**
 * `@authorbot/git-github/testing` - the deterministic fake GitHub API
 * (Phase 5 contract §7).
 *
 * Worker-safe like the rest of the package: the fake is an in-process object
 * with a `fetch`-shaped handler, not a server. It never reads the filesystem
 * - seed it with a path -> content map the caller assembled.
 *
 * Typical use:
 *
 * ```ts
 * const fake = await createFakeGitHub({
 *   owner: "JoeMattie",
 *   repo: "causal-projector",
 *   files: { "book.yml": "...", "chapters/001.md": "..." },
 * });
 * const writer = new GitHubBookRepoWriter({ fetchImpl: fake.fetch, ... });
 * ```
 */
export {
  createFakeGitHub,
  FakeGitHub,
  FAKE_GITHUB_ORIGIN,
  type CreateFakeGitHubOptions,
  type FakeGitHubOptions,
  type RequestLogEntry,
  type SeedOptions,
} from "./fake-github.js";
export {
  FAULT_NAMES,
  FaultController,
  type CountedFault,
  type FakeGitHubFaults,
  type FaultName,
  type InstallationTokenFault,
  type MovedHeadFault,
  type NonFastForwardFault,
  type RateLimitFault,
  type TruncatedTreeFault,
  type UnauthorizedFault,
} from "./faults.js";
export {
  FakeRepoError,
  FakeRepoState,
  flattenDirectoryTree,
  type CommitFilesOptions,
  type DirectoryTree,
  type FlatTreeEntry,
  type RepoFileMap,
  type TreeChange,
} from "./repo-state.js";
