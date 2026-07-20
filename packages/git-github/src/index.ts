/**
 * `@authorbot/git-github` — the GitHub integration for Authorbot (Phase 5
 * contract). **Worker-compatible only**: WebCrypto instead of `node:crypto`,
 * `fetch` instead of `node:http`. Nothing in `src/` may import a `node:`
 * module; a test asserts it.
 *
 * This entry point carries the pieces that are shared by the auth layer, the
 * reader and the writer: GitHub API constants and real git object hashing
 * (the reader needs base64 decoding and content hashing; the writer needs to
 * know what a git sha is).
 *
 * The deterministic fake GitHub used by tests lives behind the separate
 * `@authorbot/git-github/testing` entry point so production bundles never
 * pull it in.
 *
 * Credential handling rule for every module added here: installation tokens
 * and app private keys are never logged, never persisted, and never returned
 * in any response or error message (design §19.5, §20.6).
 */
export {
  GITHUB_ACCEPT,
  GITHUB_API_ORIGIN,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
} from "./constants.js";

export {
  decodeBase64,
  decodeUtf8,
  encodeBase64,
  encodeCommit,
  encodeTree,
  encodeUtf8,
  hashBlob,
  hashCommit,
  hashGitObject,
  hashTree,
  isObjectSha,
  sortTreeEntries,
  type GitCommitObject,
  type GitFileMode,
  type GitIdentity,
  type GitObjectType,
  type TreeEntry,
} from "./git-objects.js";

export {
  APP_JWT_SKEW_SECONDS,
  APP_JWT_TTL_SECONDS,
  createAppJwt,
  decodeJwtClaims,
  getGitHubAppAuth,
  GITHUB_APP_ENV_KEYS,
  GitHubAppAuth,
  GitHubAuthError,
  importAppPrivateKey,
  pkcs8PemToDer,
  readGitHubAppCredentialResult,
  readGitHubAppCredentials,
  resetGitHubAppAuthCache,
  scrubSecrets,
  TOKEN_REFRESH_MARGIN_MS,
  type AppJwtClaims,
  type AuthorizedFetch,
  type FetchLike,
  type GitHubAppAuthOptions,
  type GitHubAppCredentialResult,
  type GitHubAppCredentials,
  type GitHubAuthErrorCode,
  type GitHubCredentialStatus,
  type TokenCacheInfo,
} from "./app-auth.js";

export {
  GitHubBookRepoReader,
  GitHubReadError,
  isContainedRepoPath,
  isGitHubReadError,
  isSnapshotPath,
  MAX_BLOB_CONCURRENCY,
  normalizeRepoPath,
  stripFrontmatter,
  TruncatedTreeError,
  type BookRepoReader,
  type BookRepoSnapshot,
  type GitHubBookRepoReaderOptions,
  type GitHubBookRepoSnapshot,
  type GitHubReadErrorCode,
  type RepoAnnotationSnapshot,
  type RepoChapterSnapshot,
  type RepoDecisionSnapshot,
  type RepoReplySnapshot,
  type RepoWorkItemSnapshot,
} from "./reader.js";

export {
  AUTHORBOT_GIT_EMAIL,
  AUTHORBOT_GIT_NAME,
  GitHubBookRepoWriter,
  GitHubWriteError,
  safeRepoPath,
  toInstallationTokenGetter,
  type GitHubBookRepoWriterOptions,
  type GitHubWriteErrorInit,
  type InstallationTokenGetter,
  type InstallationTokenProvider,
  type InstallationTokenRequest,
  type InstallationTokenSource,
} from "./writer.js";
