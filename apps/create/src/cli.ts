/**
 * Argument handling and wiring (Phase 6 contract §1).
 *
 * Hand-rolled argv parsing, matching `@authorbot/cli` — the wizard's whole
 * pitch is "npx and answer questions", and adding a CLI framework to a package
 * whose contract says "zero runtime dependencies beyond what the workspace
 * already ships" would contradict it on the first line.
 *
 * `runCli` takes every port as an argument so the integration tests drive the
 * real entry point rather than a test-only approximation of it.
 */
import path from "node:path";
import { TOOLCHAIN_VERSION } from "./scaffold/render.js";
import { Actions } from "./actions.js";
import { EXAMPLE_CONFIG, parseConfig, secretAnswersIn } from "./config.js";
import type { WizardContext, WizardOptions } from "./context.js";
import { NonInteractiveError, WizardError } from "./errors.js";
import { Journal } from "./journal.js";
import type {
  BrowserOpener,
  Clock,
  Environment,
  FileSystemPort,
  HttpClient,
  LoopbackServerFactory,
  OutputPort,
  ProcessRunner,
  Prompter,
  RandomSource,
} from "./ports.js";
import { NonInteractivePrompter } from "./runtime/prompt.js";
import { SecretVault, registerEnvironmentCredentials } from "./secrets.js";
import { Reporter, themeFor } from "./ui/reporter.js";
import {
  DESTRUCTIVE_STAGES,
  STAGE_NAMES,
  STAGE_SUMMARIES,
  isStageName,
  type StageName,
} from "./stages/names.js";
import { reportError, reportProgress, reportResources, runStages } from "./wizard.js";

export const USAGE = `Usage: create-authorbot [stage] [options]

Guided setup for an Authorbot book. Run it with no arguments to go through
every step in order, stopping wherever you like.

Stages (each also runs on its own):
${STAGE_NAMES.map((name) => `  ${name.padEnd(12)} ${STAGE_SUMMARIES[name]}`).join("\n")}

Options:
  --dir <path>        where the book lives (default: the current directory)
  --dry-run           print everything that would happen; change nothing
  --non-interactive   never prompt; requires --config
  --config <file>     answers for --non-interactive (JSON or YAML)
  --check             for "upgrade": report whether one is available
  --example-config    print an example --config file and exit
  -h, --help          show this
  -v, --version       print the version

Nothing destructive happens without you agreeing to it, secrets are never
shown or written down, and everything created outside your machine is listed
at the end with how to remove it.`;

/**
 * What `--version` reports. Derived from the single pin rather than written
 * again: this shipped as 0.1.0 inside the 0.1.1 package, because a second
 * copy of a version is a copy that goes stale. `scripts/bump-version.mjs`
 * sets TOOLCHAIN_VERSION, and everything else follows from it.
 */
export const VERSION = TOOLCHAIN_VERSION;

export interface CliDeps {
  readonly runner: ProcessRunner;
  readonly prompter: Prompter;
  readonly fs: FileSystemPort;
  readonly http: HttpClient;
  readonly browser: BrowserOpener;
  readonly loopback: LoopbackServerFactory;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly env: Environment;
  readonly out: OutputPort;
  /**
   * Replaces `prompter` when `--non-interactive` is used. Supplied by the
   * caller so tests can assert the real construction path.
   */
  readonly nonInteractivePrompter?: (answers: Readonly<Record<string, unknown>>) => Prompter;
  /**
   * The vault to use, when the caller already built one. `bin.ts` does: the
   * real prompter and the top-level error handler both have to redact through
   * the *same* vault this run registers secrets with, and both are constructed
   * before `runCli` is called.
   */
  readonly vault?: SecretVault;
}

interface ParsedArgs {
  readonly stage: StageName | null;
  readonly directory: string | null;
  readonly options: WizardOptions;
  readonly configPath: string | null;
  readonly help: boolean;
  readonly version: boolean;
  readonly exampleConfig: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let stage: StageName | null = null;
  let directory: string | null = null;
  let configPath: string | null = null;
  let dryRun = false;
  let nonInteractive = false;
  let check = false;
  let help = false;
  let version = false;
  let exampleConfig = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "-h" || arg === "--help" || arg === "help") {
      help = true;
    } else if (arg === "-v" || arg === "--version") {
      version = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--non-interactive") {
      nonInteractive = true;
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--example-config") {
      exampleConfig = true;
    } else if (arg === "--dir" || arg === "--directory") {
      index += 1;
      const value = argv[index];
      if (value === undefined) {
        throw new WizardError("--dir needs a path after it.", "Try `--dir ./my-book`.");
      }
      directory = value;
    } else if (arg.startsWith("--dir=")) {
      directory = arg.slice("--dir=".length);
    } else if (arg === "--config") {
      index += 1;
      const value = argv[index];
      if (value === undefined) {
        throw new WizardError("--config needs a file path after it.", "Try `--config setup.yml`.");
      }
      configPath = value;
    } else if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    } else if (arg.startsWith("-")) {
      throw new WizardError(
        `"${arg}" is not an option this understands.`,
        "Run `create-authorbot --help` to see the options.",
      );
    } else if (stage === null && isStageName(arg)) {
      stage = arg;
    } else if (stage === null) {
      throw new WizardError(
        `"${arg}" is not one of the steps.`,
        `The steps are: ${STAGE_NAMES.join(", ")}. Run \`create-authorbot --help\` for what each one does.`,
      );
    } else {
      throw new WizardError(
        `Unexpected extra argument "${arg}".`,
        "Run `create-authorbot --help` to see how it is called.",
      );
    }
  }

  const options: WizardOptions = {
    dryRun,
    nonInteractive,
    check,
    ...(directory === null ? {} : { directoryArg: directory }),
  };
  return { stage, directory, options, configPath, help, version, exampleConfig };
}

/**
 * The stages a bare run walks. `upgrade` is excluded from a fresh run's
 * default path but stays in the list so `create-authorbot upgrade` works and
 * so the flow offers it: a book created ten seconds ago is on the current
 * version by construction, and asking an author to consider upgrading it
 * would be theatre.
 */
export function defaultFlow(): StageName[] {
  // Never `unpublish` or `teardown`. They are in STAGE_NAMES so that typing
  // their name works; a flow that could walk into one would be a wizard that
  // deletes an author's book because they pressed enter too many times.
  return STAGE_NAMES.filter((name) => !DESTRUCTIVE_STAGES.includes(name));
}

/**
 * Says so when a config file that carries a live credential is readable by
 * anyone but its owner.
 *
 * A warning rather than a refusal: the operator chose this file, it may sit on
 * a machine where the group *is* the trust boundary, and refusing to run would
 * break an unattended pipeline over something the wizard cannot judge. But an
 * `publish.cloudflareApiToken` in a mode-644 file is worth one line, because
 * the usual cause is a file created by a redirect and never chmodded, and
 * nothing else in the system will ever mention it.
 */
async function warnAboutConfigPermissions(
  deps: CliDeps,
  reporter: Reporter,
  configPath: string,
  config: { readonly answers: Readonly<Record<string, unknown>> },
): Promise<void> {
  const secrets = secretAnswersIn(config);
  if (secrets.length === 0 || deps.fs.mode === undefined) {
    return;
  }
  const mode = await deps.fs.mode(configPath);
  // null means "cannot tell" (Windows, or the file went away). Silence beats a
  // guess.
  if (mode === null || (mode & 0o077) === 0) {
    return;
  }
  reporter.warn(
    `${configPath} contains a credential (${secrets.join(", ")}) and is readable by other users on this machine.`,
  );
  reporter.info(
    `Restrict it with \`chmod 600 ${configPath}\`. Anyone who can read that file can use the credential in it.`,
  );
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const vault = deps.vault ?? new SecretVault();
  // Before anything can print. A credential that arrived through the
  // environment is just as capable of being echoed back by a failing
  // subprocess as one the wizard minted itself, and the vault only protects
  // what it has been told about.
  registerEnvironmentCredentials(vault, deps.env.env);
  const reporter = new Reporter(deps.out, vault, themeFor(deps.env), deps.env.invocation);
  // Once, before anything else this run prints.
  reporter.logo();

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof WizardError) {
      reporter.problem(error.message, error.nextAction);
      return 2;
    }
    throw error;
  }

  if (parsed.help) {
    deps.out.write(USAGE);
    return 0;
  }
  if (parsed.version) {
    deps.out.write(VERSION);
    return 0;
  }
  if (parsed.exampleConfig) {
    deps.out.write(EXAMPLE_CONFIG);
    return 0;
  }

  // ---- non-interactive configuration --------------------------------------

  let prompter = deps.prompter;
  let configDirectory: string | null = null;
  let configStages: readonly StageName[] | null = null;

  if (parsed.options.nonInteractive) {
    if (parsed.configPath === null) {
      reporter.problem(
        "--non-interactive needs a config file, because there is nobody to ask.",
        "Add `--config <file>`. Run `create-authorbot --example-config` to see one.",
      );
      return 2;
    }
    let text: string;
    try {
      text = await deps.fs.readFile(parsed.configPath);
    } catch {
      reporter.problem(
        `Could not read the config file ${parsed.configPath}.`,
        "Check the path and run again.",
      );
      return 2;
    }
    let config;
    try {
      config = parseConfig(text, parsed.configPath);
    } catch (error) {
      if (error instanceof WizardError) {
        reporter.problem(error.message, error.nextAction);
        return 2;
      }
      throw error;
    }
    await warnAboutConfigPermissions(deps, reporter, parsed.configPath, config);
    prompter =
      deps.nonInteractivePrompter?.(config.answers) ?? new NonInteractivePrompter(config.answers);
    configDirectory = config.directory ?? null;
    configStages = config.stages ?? null;
  } else if (parsed.configPath !== null) {
    reporter.problem(
      "--config only has an effect with --non-interactive.",
      "Add --non-interactive, or drop --config and answer the questions.",
    );
    return 2;
  }

  // ---- where the book lives ----------------------------------------------

  const rawDirectory = parsed.directory ?? configDirectory ?? deps.env.cwd;
  const directory = path.isAbsolute(rawDirectory)
    ? rawDirectory
    : path.resolve(deps.env.cwd, rawDirectory);

  // ---- context ------------------------------------------------------------

  const now = deps.clock.now().toISOString();
  const journal = await Journal.open({
    fs: deps.fs,
    vault,
    directory,
    now,
    readOnly: parsed.options.dryRun,
  });

  const ctx: WizardContext = {
    actions: undefined as unknown as Actions,
    reporter,
    prompter,
    journal,
    vault,
    fs: deps.fs,
    runner: deps.runner,
    http: deps.http,
    browser: deps.browser,
    loopback: deps.loopback,
    clock: deps.clock,
    random: deps.random,
    env: deps.env,
    directory,
    options: parsed.options,
  };
  // `Actions` needs the journal, prompter, and reporter, and the stages need
  // `Actions`; assigning once here keeps the cycle in one place instead of
  // threading a half-built context through five constructors.
  (ctx as { actions: Actions }).actions = new Actions({
    runner: deps.runner,
    fs: deps.fs,
    reporter,
    prompter,
    journal,
    vault,
    clock: deps.clock,
    dryRun: parsed.options.dryRun,
  });

  const stages: readonly StageName[] =
    parsed.stage !== null ? [parsed.stage] : (configStages ?? defaultFlow());
  const explicit = parsed.stage !== null || configStages !== null;

  if (parsed.options.dryRun) {
    reporter.heading("Dry run — nothing will be changed");
    reporter.explain(
      "Every command, file, and remote resource this would create is listed below and again as a plan at the end. Your machine, your GitHub account, and your Cloudflare account are all left exactly as they are.",
    );
  }

  try {
    await runStages(ctx, stages, { explicit });
  } catch (error) {
    const code = reportError(ctx, error);
    if (code !== 0) {
      reportProgress(ctx, stages);
      reportResources(ctx);
      if (error instanceof NonInteractiveError) {
        return 2;
      }
    }
    return code;
  }

  if (parsed.options.dryRun) {
    ctx.actions.printPlan();
    reporter.blank();
    reporter.ok("Nothing was changed. Run the same command without --dry-run to do it for real.");
    return 0;
  }

  reportResources(ctx);
  reporter.blank();
  reporter.ok("Done.");
  return 0;
}
