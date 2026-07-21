/**
 * `authorbot upgrade` and the book-repo migration framework it runs
 * (ADR-0021 §3).
 */

export {
  runUpgrade,
  UPGRADE_USAGE,
  CHECK_EXIT_NONE,
  CHECK_EXIT_AVAILABLE,
  CHECK_EXIT_MIGRATION,
} from "./upgrade.js";
export {
  applyMigrations,
  selectMigrations,
  BOOK_REPO_MIGRATIONS,
  MigrationApplyError,
  MigrationRegistryError,
  type AppliedMigration,
  type BookRepoMigration,
  type MigrationRepo,
  type MigrationRunResult,
  type SelectedMigration,
} from "./migrations.js";
export { resolvePlan, type ResolveOptions, type UpgradePlan } from "./plan.js";
export {
  CLI_PACKAGE,
  UpgradeRepoError,
  migrationRepoFor,
  readD1Binding,
  readDefaultBranch,
  readPin,
  rewritePin,
  stripJsonComments,
  type D1Binding,
  type PinLocation,
} from "./repo.js";
export {
  compareVersions,
  isPrerelease,
  maxVersion,
  mustParseVersion,
  parsePin,
  parseVersion,
  renderPin,
  versionsEqual,
  type Pin,
  type PinKind,
  type SemVer,
} from "./semver.js";
export type {
  CommitRequest,
  D1MigrationResult,
  DeployResult,
  GitPort,
  HealthPort,
  HealthResult,
  PullRequestRequest,
  ReleasesPort,
  UpgradeDeps,
  UpgradeFs,
  WranglerPort,
} from "./ports.js";
