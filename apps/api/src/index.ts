/**
 * @authorbot/api - runtime-agnostic surface. Node-only pieces (local FS book
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
  type RepoTextFilePage,
} from "./projection/reader.js";
export { rebuildProjection, type RebuildResult } from "./projection/rebuild.js";
export { seedProject } from "./seed.js";
export { PROBLEM_TYPES, type ProblemSlug } from "./problems.js";
export {
  LEASE_ENV_NAMES,
  leaseConfigFromEnv,
  mintLeaseToken,
  sweepExpiredLeases,
  verifyLeaseToken,
  type MintedLeaseToken,
  type SweepResult,
} from "./leases.js";
export {
  createSubmissionApplier,
  type CreateSubmissionApplierOptions,
} from "./submission-applier.js";
export {
  REANCHOR_ALGORITHM_VERSION,
  finalizeSubmissionOutcomes,
  type FinalizeSubmissionOptions,
} from "./reanchor.js";
export {
  coordinatorAlarmMsFromEnv,
  createCoordinatorGit,
  createProjectCoordinator,
  gitIntegrationStatus,
  parseRepoCoordinates,
  DEFAULT_COORDINATOR_ALARM_SECONDS,
  MAX_COORDINATOR_ALARM_SECONDS,
  type AlarmScheduler,
  type CoordinatorAlarmResult,
  type CoordinatorBindings,
  type CoordinatorGit,
  type CoordinatorStore,
  type DrainOutboxResult,
  type GitIntegrationStatus,
  type ProjectCoordinator,
  type ProjectCoordinatorOptions,
  type RefreshProjectionResult,
} from "./coordinator.js";
export {
  callCoordinator,
  coordinatorStub,
  ProjectCoordinator as ProjectCoordinatorDurableObject,
  COORDINATOR_ORIGIN,
  PROJECT_ID_KEY,
  type CoordinatorAction,
  type CoordinatorDoBindings,
  type DurableObjectNamespaceLike,
  type DurableObjectStateLike,
  type DurableObjectStubLike,
} from "./coordinator-do.js";
export { createDrainRunner, type DrainRunner, type DrainRunnerOptions } from "./drain.js";
export { uuidv7 } from "./ids.js";
export { sha256Hex, hmacSha256Hex, randomBase64Url, timingSafeEqual } from "./crypto.js";
export {
  SESSION_COOKIE,
  sessionCookieHeader,
  signSessionCookieValue,
  verifySessionCookieValue,
} from "./sessions.js";
