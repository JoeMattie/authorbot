/**
 * Everything a stage is allowed to touch, in one injected object.
 *
 * Stages take a `WizardContext` and nothing else - no module-level singletons,
 * no direct `node:*` imports, no `process.env` reads. That is what makes the
 * fakes in `test/fakes.ts` substitutions rather than monkey-patches
 * (contract §6).
 */
import type { Actions } from "./actions.js";
import type { Journal } from "./journal.js";
import type {
  BrowserOpener,
  Clock,
  Environment,
  FileSystemPort,
  HttpClient,
  LoopbackServerFactory,
  ProcessRunner,
  Prompter,
  RandomSource,
} from "./ports.js";
import type { SecretVault } from "./secrets.js";
import type { Reporter } from "./ui/reporter.js";

export interface WizardOptions {
  readonly dryRun: boolean;
  readonly nonInteractive: boolean;
  /** `--check`, forwarded to `authorbot upgrade`. */
  readonly check: boolean;
  /** Book directory as given on the command line, before resolution. */
  readonly directoryArg?: string;
}

export interface WizardContext {
  readonly actions: Actions;
  readonly reporter: Reporter;
  readonly prompter: Prompter;
  readonly journal: Journal;
  readonly vault: SecretVault;
  readonly fs: FileSystemPort;
  readonly runner: ProcessRunner;
  readonly http: HttpClient;
  readonly browser: BrowserOpener;
  readonly loopback: LoopbackServerFactory;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly env: Environment;
  /** Absolute path to the book directory. */
  readonly directory: string;
  readonly options: WizardOptions;
}

export function nowIso(ctx: WizardContext): string {
  return ctx.clock.now().toISOString();
}

/**
 * What a stage reports back. `continue: false` stops the default flow without
 * being an error - the author choosing to stop is a supported ending, not a
 * failure (contract §3: "stopping wherever the user chooses").
 */
export interface StageOutcome {
  readonly continue: boolean;
  /** Short, redacted note for the journal. */
  readonly note?: string;
}

export type Stage = (ctx: WizardContext) => Promise<StageOutcome>;
