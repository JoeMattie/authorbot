/**
 * Public surface of `@authorbot/create`.
 *
 * The package's contract is its binary; these exports exist so the test suite
 * (and anything embedding the wizard) can drive the same code the binary runs
 * rather than a parallel implementation of it.
 */
export { runCli, parseArgs, defaultFlow, USAGE, VERSION, type CliDeps } from "./cli.js";
export { Actions, type PlanEntry, type CommandSpec, type WriteFileSpec } from "./actions.js";
export { parseConfig, EXAMPLE_CONFIG, type WizardConfig } from "./config.js";
export type { Stage, StageOutcome, WizardContext, WizardOptions } from "./context.js";
export { AbortedError, NonInteractiveError, TimeoutError, WizardError } from "./errors.js";
export { uuidv7, randomToken } from "./ids.js";
export {
  Journal,
  JOURNAL_FILENAME,
  emptyJournal,
  parseJournal,
  type CreatedResource,
  type JournalData,
} from "./journal.js";
export type * from "./ports.js";
export { NonInteractivePrompter, TtyPrompter } from "./runtime/prompt.js";
export {
  CryptoRandom,
  FetchHttpClient,
  NodeFileSystem,
  NodeLoopbackServerFactory,
  SystemBrowserOpener,
  SystemClock,
} from "./runtime/node-ports.js";
export { NodeProcessRunner } from "./runtime/process.js";
export { REDACTED, SecretVault, redactError } from "./secrets.js";
export { deriveSlug, validateSlug, validateWorkerName, SLUG_RE } from "./slug.js";
export {
  DEFAULT_LICENSE,
  TOOLCHAIN_VERSION,
  assertBookYmlValid,
  renderBookYml,
  renderPackageJson,
  renderReadme,
  renderWranglerJsonc,
  scaffoldFiles,
  type BookIdentity,
  type ScaffoldFile,
} from "./scaffold/render.js";
export { renderWrangler, type CollaborationSettings, type WranglerSettings } from "./scaffold/wrangler.js";
export { KEEP_DIRECTORIES, STATIC_TEMPLATE_FILES } from "./scaffold/static-files.js";
export {
  OPTIONAL_STAGES,
  STAGE_NAMES,
  STAGE_SUMMARIES,
  isStageName,
  type StageName,
} from "./stages/names.js";
export { DEFAULT_AGENT_SCOPES, renderAgentPrompt } from "./stages/agent.js";
export { extractDatabaseId } from "./stages/collaborate.js";
export { deployedUrl } from "./stages/publish.js";
export {
  GITHUB_API_BASE,
  GITHUB_WEB_BASE,
  buildManifest,
  buildSubmitPage,
  convertManifestCode,
  runManifestFlow,
  withDeadline,
  type ManifestConversion,
  type ManifestFlowDeps,
  type ManifestFlowOptions,
} from "./github/manifest-flow.js";
export { createAppJwt, waitForInstallation } from "./github/installation.js";
export { Reporter, themeFor, wrap, type Theme } from "./ui/reporter.js";
export { MINIMUM_NODE_MAJOR, type ToolReport, type ToolStatus } from "./tools.js";
export { STAGES, reportError, reportProgress, reportResources, runStages } from "./wizard.js";
