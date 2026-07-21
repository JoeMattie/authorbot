/**
 * @authorbot/cli - `authorbot` command-line interface (Phase 0).
 *
 * The validation logic is importable so the API service can reuse it later:
 * `validateBookRepo(path)` returns the same `{ valid, errors, warnings }`
 * report the `--json` flag prints.
 */

export { runCli, type CliIo } from "./cli.js";
export { runBuild, BUILD_USAGE } from "./build.js";
export {
  BOOK_REPO_MIGRATIONS,
  CHECK_EXIT_AVAILABLE,
  CHECK_EXIT_MIGRATION,
  CHECK_EXIT_NONE,
  MigrationApplyError,
  MigrationRegistryError,
  UPGRADE_USAGE,
  UpgradeRepoError,
  applyMigrations,
  compareVersions,
  parsePin,
  parseVersion,
  renderPin,
  resolvePlan,
  runUpgrade,
  selectMigrations,
  type AppliedMigration,
  type BookRepoMigration,
  type MigrationRepo,
  type MigrationRunResult,
  type Pin,
  type SelectedMigration,
  type SemVer,
  type UpgradeDeps,
  type UpgradePlan,
} from "./upgrade/index.js";
export {
  DEFAULT_BOOK_SETTINGS,
  FindingCollector,
  RepoAccessError,
  VALIDATION_CODES,
  checkAuthorbotRecords,
  checkChapterWorldRefs,
  checkStoryGraph,
  loadBookConfig,
  loadChapters,
  loadStoryWorld,
  validateBookRepo,
  type BookSettings,
  type ChapterIndex,
  type ChapterInfo,
  type Finding,
  type FindingSeverity,
  type StoryWorld,
  type ValidationCode,
  type ValidationReport,
} from "./validate/index.js";
