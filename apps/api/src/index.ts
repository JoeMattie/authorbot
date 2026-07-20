/**
 * @authorbot/api — runtime-agnostic surface. Node-only pieces (local FS book
 * repo reader) live in `@authorbot/api/local`; the Worker entry is
 * src/worker.ts (bundled by wrangler, not exported).
 */
export { createApp, createApi, type AuthorbotApi } from "./app.js";
export {
  SYSTEM_CLOCK,
  type AppConfig,
  type AppDeps,
  type AppEnv,
  type AuthContext,
  type AuthMode,
  type Clock,
  type GitHubOAuthConfig,
  type MirrorMode,
} from "./deps.js";
export {
  createDevIdentityProvider,
  type DevIdentityProvider,
  type GitHubIdentityProvider,
  type IdentityProvider,
  type ResolvedIdentity,
} from "./identity/provider.js";
export { createGitHubIdentityProvider } from "./identity/github.js";
export {
  type BookRepoReader,
  type BookRepoSnapshot,
  type RepoAnnotationSnapshot,
  type RepoChapterSnapshot,
  type RepoReplySnapshot,
} from "./projection/reader.js";
export { rebuildProjection, type RebuildResult } from "./projection/rebuild.js";
export { seedProject } from "./seed.js";
export { PROBLEM_TYPES, type ProblemSlug } from "./problems.js";
export { uuidv7 } from "./ids.js";
export { sha256Hex, hmacSha256Hex, randomBase64Url, timingSafeEqual } from "./crypto.js";
export {
  SESSION_COOKIE,
  sessionCookieHeader,
  signSessionCookieValue,
  verifySessionCookieValue,
} from "./sessions.js";
