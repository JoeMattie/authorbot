/**
 * The single choke point for anything that changes the world (Phase 6
 * contract §2.1, §2.4, §2.6).
 *
 * Every command, file write, and remote resource goes through here, which is
 * what makes three separate requirements true at once and by construction
 * rather than by discipline:
 *
 * - `--dry-run` prints the full plan and changes nothing, because this class
 *   records instead of executing.
 * - Existing files are never overwritten silently, because the only writer
 *   compares first and backs up.
 * - Every externally-created resource is reported at the end, because the
 *   only way to create one is to declare it here.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { AbortedError, WizardError } from "./errors.js";
import type { CreatedResource, Journal } from "./journal.js";
import type { Clock, ExecResult, FileSystemPort, ProcessRunner, Prompter } from "./ports.js";
import type { SecretVault } from "./secrets.js";
import type { Reporter } from "./ui/reporter.js";

export type PlanEntryKind = "command" | "file" | "resource" | "secret" | "note";

export interface PlanEntry {
  readonly kind: PlanEntryKind;
  /** One line, already redacted. */
  readonly summary: string;
  readonly detail?: string;
}

export interface CommandSpec {
  /** Author-facing sentence: what this command is for. */
  readonly purpose: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /**
   * Piped to stdin and never shown. This is how secrets reach
   * `wrangler secret put` without touching disk, argv, or the terminal
   * (contract §4.4) - argv is visible in the process table, stdin is not.
   */
  readonly stdin?: string;
  /** True when the command changes something. Read-only probes still run in a dry run. */
  readonly mutates: boolean;
  /** Plausible stdout to return in a dry run so the plan can keep going. */
  readonly dryRunStdout?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  /** When false, a non-zero exit is returned rather than thrown. */
  readonly required?: boolean;
  /** Used in the failure message when `required`. */
  readonly onFailure?: string;
}

export interface WriteFileSpec {
  readonly filePath: string;
  readonly contents: string;
  /** Author-facing description of the file's job. */
  readonly purpose: string;
  /**
   * What to do when the file exists with different contents. `backup` keeps a
   * timestamped copy after confirming; `keep` leaves the existing file alone
   * and reports that it did.
   */
  readonly onConflict?: "backup" | "keep";
}

export interface ActionsOptions {
  readonly runner: ProcessRunner;
  readonly fs: FileSystemPort;
  readonly reporter: Reporter;
  readonly prompter: Prompter;
  readonly journal: Journal;
  readonly vault: SecretVault;
  readonly clock: Clock;
  readonly dryRun: boolean;
  /** Default timeout for any command that does not set one (contract §5). */
  readonly commandTimeoutMs?: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

function shellish(command: string, args: readonly string[]): string {
  const rendered = [command, ...args].map((part) =>
    /^[A-Za-z0-9._/:@=,+-]+$/.test(part) ? part : JSON.stringify(part),
  );
  return rendered.join(" ");
}

export class Actions {
  readonly #o: ActionsOptions;
  readonly #plan: PlanEntry[] = [];

  constructor(options: ActionsOptions) {
    this.#o = options;
  }

  get dryRun(): boolean {
    return this.#o.dryRun;
  }

  get plan(): readonly PlanEntry[] {
    return this.#plan;
  }

  #record(entry: PlanEntry): void {
    this.#plan.push({
      kind: entry.kind,
      summary: this.#o.vault.redact(entry.summary),
      ...(entry.detail === undefined ? {} : { detail: this.#o.vault.redact(entry.detail) }),
    });
  }

  /** A plan line for something the wizard will do that is not a command or file. */
  note(summary: string, detail?: string): void {
    this.#record(detail === undefined ? { kind: "note", summary } : { kind: "note", summary, detail });
  }

  /**
   * Runs a command, or records it. Read-only commands (`mutates: false`) run
   * even in a dry run - `doctor` has to actually look at the machine for its
   * report to mean anything, and looking changes nothing.
   */
  async run(spec: CommandSpec): Promise<ExecResult> {
    const rendered = shellish(spec.command, spec.args);
    const stdinNote = spec.stdin === undefined ? "" : " (value piped on stdin, not shown)";

    if (this.#o.dryRun && spec.mutates) {
      this.#record({
        kind: "command",
        summary: `run: ${rendered}${stdinNote}`,
        detail: spec.purpose,
      });
      return { code: 0, stdout: spec.dryRunStdout ?? "", stderr: "" };
    }

    if (spec.mutates) {
      this.#record({ kind: "command", summary: `ran: ${rendered}${stdinNote}`, detail: spec.purpose });
    }

    const options: Parameters<ProcessRunner["run"]>[2] = {
      timeoutMs: spec.timeoutMs ?? this.#o.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      ...(spec.stdin === undefined ? {} : { stdin: spec.stdin }),
      ...(spec.env === undefined ? {} : { env: spec.env }),
    };

    const result = await this.#o.runner.run(spec.command, spec.args, options);
    if (result.code !== 0 && spec.required === true) {
      const detail = this.#o.vault.redact((result.stderr || result.stdout).trim());
      const firstLines = detail.split("\n").slice(0, 6).join("\n");
      throw new WizardError(
        `${spec.command} failed (exit ${String(result.code)}) while trying to ${spec.purpose}.` +
          (firstLines.length > 0 ? `\n${firstLines}` : ""),
        spec.onFailure ??
          `Run "${rendered}" yourself to see the full output, then re-run this command - finished steps are skipped.`,
      );
    }
    return result;
  }

  /**
   * Writes a file, idempotently. Identical contents are a no-op (so a resumed
   * run is silent rather than noisy), and differing contents are never
   * clobbered without the author saying so.
   */
  async writeFile(spec: WriteFileSpec): Promise<"written" | "unchanged" | "kept" | "planned"> {
    const exists = await this.#o.fs.exists(spec.filePath);
    // "Ours" means the bytes on disk are exactly what this wizard last wrote
    // there. Replacing those is not overwriting the author's work; it is the
    // wizard updating its own output, which every later stage has to do
    // (`collaborate` rewrites the `wrangler.jsonc` that `publish` wrote).
    let ours = false;
    if (exists) {
      const current = await this.#o.fs.readFile(spec.filePath);
      if (current === spec.contents) {
        await this.#remember(spec.filePath, spec.contents);
        return "unchanged";
      }
      ours = this.#o.journal.managedDigest(spec.filePath) === digestOf(current);
      if (!ours && spec.onConflict === "keep") {
        this.#o.reporter.info(
          `Left ${spec.filePath} as it is - it already exists and differs from the template.`,
        );
        return "kept";
      }
      if (!ours && this.#o.dryRun) {
        this.#record({
          kind: "file",
          summary: `overwrite (after backup): ${spec.filePath}`,
          detail: `${spec.purpose} - the existing file differs and would be copied to ${spec.filePath}.bak-<timestamp> first.`,
        });
        return "planned";
      }
      if (!ours) {
        const approved = await this.#o.prompter.confirm({
          id: `overwrite:${path.basename(spec.filePath)}`,
          message: `${spec.filePath} already exists and is different. Replace it (a backup copy is kept)?`,
          hint: describeDifference(current, spec.contents),
          defaultValue: false,
          destructive: true,
        });
        if (!approved) {
          throw new AbortedError(`${spec.filePath} was left untouched`);
        }
        const stamp = this.#o.clock.now().toISOString().replace(/[:.]/g, "-");
        const backup = `${spec.filePath}.bak-${stamp}`;
        await this.#o.fs.writeFile(backup, current);
        this.#o.reporter.info(`Kept a copy of the previous file at ${backup}`);
        this.#record({ kind: "file", summary: `backed up: ${backup}` });
      }
    }

    if (this.#o.dryRun) {
      this.#record({
        kind: "file",
        summary: `${exists ? "overwrite" : "create"}: ${spec.filePath}`,
        detail: spec.purpose,
      });
      return "planned";
    }

    await this.#o.fs.mkdirp(path.dirname(spec.filePath));
    await this.#o.fs.writeFile(spec.filePath, spec.contents);
    await this.#remember(spec.filePath, spec.contents);
    this.#record({ kind: "file", summary: `wrote: ${spec.filePath}`, detail: spec.purpose });
    return "written";
  }

  /** Records what the wizard just wrote, so a later stage may replace it. */
  async #remember(filePath: string, contents: string): Promise<void> {
    if (this.#o.dryRun) {
      return;
    }
    await this.#o.journal.recordManagedFile(
      filePath,
      digestOf(contents),
      this.#o.clock.now().toISOString(),
    );
  }

  async mkdirp(directory: string): Promise<void> {
    if (this.#o.dryRun) {
      this.#record({ kind: "file", summary: `create directory: ${directory}` });
      return;
    }
    await this.#o.fs.mkdirp(directory);
  }

  /**
   * Declares something that now exists outside the author's machine, with the
   * command that removes it (contract §2.6). Recorded in the journal so the
   * final report survives an interrupted run.
   */
  async resource(resource: CreatedResource): Promise<void> {
    this.#record({
      kind: "resource",
      summary: `${this.#o.dryRun ? "would create" : "created"} ${resource.kind}: ${resource.name}`,
      detail: `${resource.description} Remove with: ${resource.deleteWith}`,
    });
    if (this.#o.dryRun) {
      return;
    }
    await this.#o.journal.recordResource(resource, this.#o.clock.now().toISOString());
  }

  /**
   * Notes that a secret was set. The value is never passed to this method -
   * it went to its destination on a command's stdin and is already gone.
   */
  async secretSet(name: string, destination: string): Promise<void> {
    this.#record({
      kind: "secret",
      summary: `${this.#o.dryRun ? "would set" : "set"} secret ${name} on ${destination}`,
      detail: "The value is generated or received in memory and piped straight to its destination.",
    });
    if (this.#o.dryRun) {
      return;
    }
    await this.#o.journal.recordSecret(name, this.#o.clock.now().toISOString());
  }

  /** Prints the accumulated plan (dry run only). */
  printPlan(): void {
    this.#o.reporter.heading("Plan (nothing above or below this line was changed)");
    if (this.#plan.length === 0) {
      this.#o.reporter.info("Nothing to do - everything this run would create already exists.");
      return;
    }
    for (const entry of this.#plan) {
      this.#o.reporter.bullet(entry.summary);
      if (entry.detail !== undefined) {
        this.#o.reporter.info(entry.detail);
      }
    }
  }
}

function digestOf(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

/**
 * A one-line summary of how two versions of a file differ. A full diff would
 * be more precise and much less readable at a confirmation prompt; the author
 * only has to decide whether replacing is safe, and the backup makes that
 * decision recoverable either way.
 */
function describeDifference(current: string, next: string): string {
  const currentLines = current.split("\n");
  const nextLines = next.split("\n");
  let firstDifferent = 0;
  while (
    firstDifferent < currentLines.length &&
    firstDifferent < nextLines.length &&
    currentLines[firstDifferent] === nextLines[firstDifferent]
  ) {
    firstDifferent += 1;
  }
  return (
    `Yours has ${String(currentLines.length)} lines, the new one has ${String(nextLines.length)}; ` +
    `they first differ at line ${String(firstDifferent + 1)}.`
  );
}
