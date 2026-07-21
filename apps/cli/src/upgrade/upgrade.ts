/**
 * `authorbot upgrade` — ADR-0021 §3.
 *
 *   1. resolve current pin → target release; show what changed
 *   2. run the target's book-repo migrations against a working copy
 *   3. validate BEFORE and AFTER; abort on any new error
 *   4. open a PULL REQUEST — never push to main
 *   5. apply pending D1 migrations
 *   6. redeploy, and verify health before declaring success
 *
 * Two properties matter more than the feature list.
 *
 * **The author's repository is not touched until the result is known good.**
 * Migrations run against a copy in a temporary directory. Validation runs
 * before and after. Only if no *new* error appeared does anything get written
 * back, and even then it lands on a fresh branch and becomes a pull request —
 * never a push to the default branch. The undo button is `git revert`, which
 * is why the toolchain bump and the format migration are separate commits.
 *
 * **Nothing is reported as done that was not verified.** A deploy whose URL
 * we could not learn is a deploy whose health we cannot check, and that exits
 * non-zero saying so. A partial run prints what completed and what did not,
 * with the command that recovers. The failure mode this guards against is not
 * a crash — it is an author believing their book is upgraded when it is not.
 */

import path from "node:path";
import type { CliIo } from "../cli.js";
import type { Finding, ValidationReport } from "../validate/findings.js";
import { RepoAccessError, validateBookRepo } from "../validate/index.js";
import {
  applyMigrations,
  BOOK_REPO_MIGRATIONS,
  MigrationApplyError,
  MigrationRegistryError,
  selectMigrations,
  type SelectedMigration,
} from "./migrations.js";
import { resolvePlan, type UpgradePlan } from "./plan.js";
import type { UpgradeDeps } from "./ports.js";
import {
  migrationRepoFor,
  readD1Binding,
  readDefaultBranch,
  rewritePin,
  UpgradeRepoError,
} from "./repo.js";
import { compareVersions, parseVersion, renderPin, type SemVer } from "./semver.js";

export const UPGRADE_USAGE = `Usage: authorbot upgrade [path] [options]

Move a book repository to a newer release of the Authorbot toolchain
(ADR-0021 §3). Migrations run against a working copy, validation runs before
and after, and the result arrives as a PULL REQUEST — never a push to your
default branch.

Options:
  --check           report whether an upgrade is available and whether it
                    would need a book-format migration; changes nothing.
                    Intended for a scheduled job: see the exit codes below
  --dry-run         print the full plan — including what the migrations would
                    change and whether the result validates — and change
                    nothing
  --json            machine-readable output (with --check or --dry-run)
  --to <version>    upgrade to an exact release instead of the newest one in
                    your current major. Crossing a major version requires
                    this flag: a major is where a valid book may stop being
                    valid, so it is never the default
  --deploy          after opening the pull request, continue to steps 5-6
                    (apply D1 migrations, redeploy, verify health)
  --finish          run ONLY steps 5-6 against the current checkout. This is
                    what you run after merging the pull request, if your CI
                    does not do it for you
  --rollback <ver>  move the pin BACK to <ver>, as a pull request. This rolls
                    back the TOOLCHAIN only. Rolling back a book-format
                    migration is a separate operation — reverting its commit
                    — and this will tell you which one (ADR-0021 §5)
  --url <url>       the deployed book's URL, used to verify health after a
                    redeploy. Without it, a deploy whose URL wrangler does
                    not report cannot be verified, and that is an error
  --base <branch>   pull request base branch (default: book.yml
                    repository.default_branch, else main)
  -h, --help        show this help

Exit codes (normal run):
  0  upgraded (or already current)
  1  the upgrade was refused or could not be completed
  2  usage, repository, or I/O error

Exit codes (--check), for scheduled jobs:
  0   no upgrade available
  10  upgrade available; no book-format migration needed
  11  upgrade available; a book-format migration would run
  2   usage, repository, or I/O error`;

export const CHECK_EXIT_NONE = 0;
export const CHECK_EXIT_AVAILABLE = 10;
export const CHECK_EXIT_MIGRATION = 11;

interface UpgradeOptions {
  repoPath: string;
  check: boolean;
  dryRun: boolean;
  json: boolean;
  deploy: boolean;
  finish: boolean;
  to?: string;
  rollback?: string;
  url?: string;
  base?: string;
}

/** Build the real ports. Imported lazily so `validate` never pays for them. */
async function defaultDeps(): Promise<UpgradeDeps> {
  const ports = await import("./node-ports.js");
  return {
    fs: ports.nodeFs,
    git: ports.nodeGit,
    lockfile: ports.nodeLockfile,
    releases: ports.npmReleases,
    wrangler: ports.wranglerCli,
    health: ports.httpHealth,
    validate: validateBookRepo,
    migrations: BOOK_REPO_MIGRATIONS,
    now: () => new Date(),
  };
}

export async function runUpgrade(
  args: string[],
  io: CliIo,
  injected?: UpgradeDeps,
): Promise<number> {
  const parsed = parseArgs(args, io);
  if (typeof parsed === "number") {
    return parsed;
  }
  const deps = injected ?? (await defaultDeps());

  try {
    if (parsed.finish) {
      return await runFinish(parsed, io, deps);
    }
    if (parsed.rollback !== undefined) {
      return await runRollback(parsed, parsed.rollback, io, deps);
    }
    if (parsed.check) {
      return await runCheck(parsed, io, deps);
    }
    return await runUpgradeFlow(parsed, io, deps);
  } catch (error) {
    if (error instanceof UpgradeRepoError || error instanceof MigrationRegistryError) {
      io.err(`authorbot: ${error.message}`);
      return 2;
    }
    if (error instanceof MigrationApplyError) {
      // A migration threw. It ran against a throwaway copy, so the author's
      // repository is untouched — say so, because "the upgrade crashed" and
      // "the upgrade damaged my book" are very different fears.
      io.err(`authorbot: ${error.message}`);
      io.err(
        "authorbot: this ran against a working copy; your repository was not modified. " +
          "This is a bug in the migration — please report it.",
      );
      return 2;
    }
    if (error instanceof RepoAccessError) {
      io.err(`authorbot: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

function parseArgs(args: string[], io: CliIo): UpgradeOptions | number {
  const options: UpgradeOptions = {
    repoPath: process.cwd(),
    check: false,
    dryRun: false,
    json: false,
    deploy: false,
    finish: false,
  };
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      io.out(UPGRADE_USAGE);
      return 0;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--deploy") {
      options.deploy = true;
    } else if (arg === "--finish") {
      options.finish = true;
    } else if (arg === "--to" || arg === "--rollback" || arg === "--url" || arg === "--base") {
      const value = args[i + 1];
      if (value === undefined) {
        io.err(`authorbot: ${arg} requires a value\n\n${UPGRADE_USAGE}`);
        return 2;
      }
      if (arg === "--to") {
        options.to = value;
      } else if (arg === "--rollback") {
        options.rollback = value;
      } else if (arg === "--url") {
        options.url = value;
      } else {
        options.base = value;
      }
      i += 1;
    } else if (arg.startsWith("-")) {
      io.err(`authorbot: unknown option "${arg}"\n\n${UPGRADE_USAGE}`);
      return 2;
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1) {
    io.err(`authorbot: upgrade takes at most one [path]\n\n${UPGRADE_USAGE}`);
    return 2;
  }
  const target = positionals[0];
  if (target !== undefined) {
    // Same policy as validate and build: relative to the process cwd.
    options.repoPath = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
  }
  if (options.check && options.dryRun) {
    io.err(`authorbot: --check and --dry-run are alternatives, not a combination\n\n${UPGRADE_USAGE}`);
    return 2;
  }
  if (options.rollback !== undefined && options.check) {
    io.err(
      `authorbot: --check reports on upgrades, not rollbacks; use --rollback --dry-run\n\n${UPGRADE_USAGE}`,
    );
    return 2;
  }
  if (options.finish && (options.check || options.dryRun || options.rollback !== undefined)) {
    io.err(`authorbot: --finish runs steps 5-6 alone; it cannot be combined\n\n${UPGRADE_USAGE}`);
    return 2;
  }
  return options;
}

// --------------------------------------------------------------------------
// --check
// --------------------------------------------------------------------------

async function runCheck(options: UpgradeOptions, io: CliIo, deps: UpgradeDeps): Promise<number> {
  const plan = await resolvePlan(deps, {
    repoPath: options.repoPath,
    ...(options.to === undefined ? {} : { to: options.to }),
  });
  const migrationRequired = plan.migrations.length > 0;

  if (options.json) {
    io.out(
      JSON.stringify(
        {
          current: plan.current.raw,
          target: plan.target.raw,
          upgradeAvailable: plan.upgradeAvailable,
          formatMigrationRequired: migrationRequired,
          migrations: plan.migrations.map(({ migration }) => ({
            id: migration.id,
            from: migration.from,
            to: migration.to,
            description: migration.description,
          })),
          newerMajorAvailable: plan.newerMajor?.raw ?? null,
        },
        null,
        2,
      ),
    );
  } else if (!plan.upgradeAvailable) {
    io.out(`authorbot: up to date (${plan.current.raw})`);
    if (plan.newerMajor !== undefined) {
      io.out(
        `authorbot: a newer major exists (${plan.newerMajor.raw}); ` +
          `crossing it is opt-in: authorbot upgrade --to ${plan.newerMajor.raw}`,
      );
    }
  } else {
    io.out(`authorbot: upgrade available: ${plan.current.raw} -> ${plan.target.raw}`);
    if (migrationRequired) {
      io.out(`authorbot: ${describeMigrationCount(plan.migrations)} would run:`);
      for (const { migration } of plan.migrations) {
        io.out(`  ${migration.id} (${migration.from} -> ${migration.to}): ${migration.description}`);
      }
    } else {
      io.out("authorbot: no book-format migration needed");
    }
    if (plan.newerMajor !== undefined && plan.newerMajor.major > plan.target.major) {
      io.out(`authorbot: a newer major exists (${plan.newerMajor.raw}); crossing it is opt-in`);
    }
  }

  if (!plan.upgradeAvailable) {
    return CHECK_EXIT_NONE;
  }
  return migrationRequired ? CHECK_EXIT_MIGRATION : CHECK_EXIT_AVAILABLE;
}

// --------------------------------------------------------------------------
// the upgrade itself
// --------------------------------------------------------------------------

interface WorkingCopyOutcome {
  readonly changed: string[];
  readonly applied: { id: string; description: string; to: string; changed: string[] }[];
  readonly before: ValidationReport;
  readonly after: ValidationReport;
  readonly newErrors: Finding[];
  /** Contents of every changed file, keyed by repo-relative path. */
  readonly contents: Map<string, string>;
}

/**
 * Steps 2 and 3: migrate a copy, validate before and after, and decide.
 *
 * The working copy is always removed, success or failure. Nothing in the
 * author's repository is written here — the caller does that, and only when
 * `newErrors` is empty.
 */
async function migrateWorkingCopy(
  plan: UpgradePlan,
  deps: UpgradeDeps,
  io: CliIo,
): Promise<WorkingCopyOutcome> {
  const before = await deps.validate(plan.repoPath);
  const tempRoot = await deps.fs.makeTempDir("authorbot-upgrade-");
  const workingCopy = path.join(tempRoot, "repo");
  try {
    await deps.fs.copyTree(plan.repoPath, workingCopy);
    const repo = migrationRepoFor(deps.fs, workingCopy);
    const run = await applyMigrations(plan.migrations, repo);

    const after = await deps.validate(workingCopy);
    const newErrors = findNewErrors(before, after);
    const contents = new Map<string, string>();
    for (const file of run.changed) {
      contents.set(file, await deps.fs.readFile(path.join(workingCopy, file)));
    }

    // Idempotency is a promise migrations make, and this is where it is
    // checked rather than assumed: a second application must be a no-op.
    // Checked *after* the validation gate so that a migration which both
    // breaks the book and repeats itself reports the failure that matters to
    // the author, not the one that matters to us.
    if (newErrors.length === 0) {
      const second = await applyMigrations(plan.migrations, repo);
      if (second.changed.length > 0) {
        throw new MigrationRegistryError(
          `migration(s) ${second.applied
            .filter((entry) => entry.changed.length > 0)
            .map((entry) => entry.id)
            .join(", ")} are not idempotent: a second application changed ` +
            `${second.changed.join(", ")}. This is a bug in the toolchain, not in your book; ` +
            "nothing has been written to your repository.",
        );
      }
    }

    if (run.changed.length > 0) {
      io.out(`authorbot: migrations changed ${run.changed.length} file(s) in the working copy`);
    }
    return { changed: run.changed, applied: run.applied, before, after, newErrors, contents };
  } finally {
    await deps.fs.removeTree(tempRoot);
  }
}

/**
 * A "new" error is one whose code, path, and pointer did not appear before.
 * Message text is deliberately excluded: a message that gained a line number
 * is the same error, and treating it as new would abort upgrades for no
 * reason. This is ADR-0021 §2 in code — a book valid under the old version
 * must stay valid.
 */
function findNewErrors(before: ValidationReport, after: ValidationReport): Finding[] {
  const key = (finding: Finding): string =>
    `${finding.code} ${finding.path} ${finding.pointer ?? ""}`;
  const known = new Set(before.errors.map(key));
  return after.errors.filter((finding) => !known.has(key(finding)));
}

async function runUpgradeFlow(
  options: UpgradeOptions,
  io: CliIo,
  deps: UpgradeDeps,
): Promise<number> {
  const plan = await resolvePlan(deps, {
    repoPath: options.repoPath,
    ...(options.to === undefined ? {} : { to: options.to }),
  });

  if (!plan.upgradeAvailable) {
    if (options.json) {
      io.out(JSON.stringify({ upgraded: false, current: plan.current.raw, reason: "up-to-date" }, null, 2));
    } else {
      io.out(`authorbot: already on ${plan.current.raw}; nothing to upgrade`);
      if (plan.newerMajor !== undefined) {
        io.out(
          `authorbot: a newer major exists (${plan.newerMajor.raw}); ` +
            `review its release notes, then: authorbot upgrade --to ${plan.newerMajor.raw}`,
        );
      }
    }
    return 0;
  }

  io.out(`authorbot: ${plan.current.raw} -> ${plan.target.raw}`);
  if (plan.target.major > plan.current.major) {
    io.out("authorbot: this crosses a major version; read the release notes before merging");
  }
  describePlan(plan, io);

  if (options.dryRun) {
    return runDryRun(plan, options, io, deps);
  }

  // Step 3 gate, plus the requirement that we have a clean tree to branch
  // from — an upgrade must never sweep up unrelated work in progress.
  if (!(await deps.git.isClean(plan.repoPath))) {
    io.err(
      "authorbot: the working tree has uncommitted changes. " +
        "Commit or stash them first: the upgrade needs a clean branch point so that " +
        "the pull request contains only the upgrade.",
    );
    return 2;
  }
  const originalBranch = await deps.git.currentBranch(plan.repoPath);

  const outcome = await migrateWorkingCopy(plan, deps, io);
  if (outcome.newErrors.length > 0) {
    io.err(
      `authorbot: UPGRADE ABORTED. ${plan.target.raw} would introduce ` +
        `${outcome.newErrors.length} validation error(s) that ${plan.current.raw} did not report.`,
    );
    renderFindings(outcome.newErrors, io);
    io.err(
      "A book that validates under your current release must keep validating (ADR-0021 §2), " +
        "so nothing was written to your repository and no branch was created. " +
        "Please report this — it is a bug in the migration, not in your book.",
    );
    return 1;
  }
  reportValidation(outcome, io);

  const branch = branchName("upgrade", plan.target, deps.now());
  const base = options.base ?? (await readDefaultBranch(deps.fs, plan.repoPath));
  const completed: string[] = [];

  try {
    await deps.git.createBranch(plan.repoPath, branch);
    completed.push(`created branch ${branch}`);

    // Commit 1: the toolchain pin, alone. Reverting this commit rolls the
    // toolchain back without touching prose (ADR-0021 §5).
    const newSpec = renderPin(plan.pinLocation.pin, plan.target);
    await deps.fs.writeFile(
      path.join(plan.repoPath, "package.json"),
      rewritePin(plan.pinLocation.packageJsonText, newSpec),
    );
    // The lockfile has to move with the pin. `npm ci` — which both generated
    // workflows run, and which exists to refuse a lockfile that disagrees with
    // its manifest — otherwise fails on this pull request, so every upgrade
    // opened one whose CI could not pass.
    const relocked = await deps.lockfile.relock(plan.repoPath);
    const pinPaths = relocked ? ["package.json", "package-lock.json"] : ["package.json"];
    if (!relocked) {
      io.err(
        "authorbot: could not refresh package-lock.json (npm unavailable, or offline). " +
          "Run `npm install --package-lock-only` on the upgrade branch and commit it, " +
          "or CI will fail on `npm ci` because the lockfile still pins the old version.",
      );
    }
    await deps.git.commit(plan.repoPath, {
      message:
        `chore(authorbot): upgrade toolchain ${plan.current.raw} -> ${plan.target.raw}\n\n` +
        `Pins ${plan.pinLocation.field}["@authorbot/cli"] to ${newSpec}.\n` +
        "Reverting this commit rolls the toolchain back; it does NOT undo any\n" +
        "book-format migration (ADR-0021 §5).",
      paths: pinPaths,
    });
    completed.push("committed the toolchain pin");

    // Commit 2: the format migration, alone, for the same reason in reverse.
    if (outcome.changed.length > 0) {
      for (const [file, content] of outcome.contents) {
        await deps.fs.writeFile(path.join(plan.repoPath, file), content);
      }
      await deps.git.commit(plan.repoPath, {
        message:
          `chore(authorbot): book-format migrations for ${plan.target.raw}\n\n` +
          outcome.applied
            .filter((entry) => entry.changed.length > 0)
            .map((entry) => `${entry.id}: ${entry.description}`)
            .join("\n") +
          "\n\nReverting this commit undoes the format migration only.",
        paths: outcome.changed,
      });
      completed.push(`committed ${outcome.changed.length} migrated file(s)`);
    }

    await deps.git.push(plan.repoPath, branch);
    completed.push(`pushed ${branch}`);

    const url = await deps.git.openPullRequest(plan.repoPath, {
      branch,
      base,
      title: `Upgrade Authorbot ${plan.current.raw} -> ${plan.target.raw}`,
      body: pullRequestBody(plan, outcome),
    });
    completed.push("opened the pull request");
    io.out(`authorbot: pull request opened: ${url}`);
  } catch (error) {
    reportPartial(io, completed, branch, originalBranch, error);
    return 1;
  }

  if (!options.deploy) {
    io.out("");
    io.out("Next: review and merge the pull request. Then your CI applies pending D1");
    io.out("migrations and redeploys (ADR-0021 §4). If it does not, run");
    io.out("`authorbot upgrade --finish` on the merged checkout to do steps 5-6 here.");
    return 0;
  }

  io.out("");
  io.out("authorbot: --deploy given; continuing to steps 5-6 against this checkout.");
  return runDeploySteps(options, plan.repoPath, io, deps);
}

function describePlan(plan: UpgradePlan, io: CliIo): void {
  if (plan.migrations.length === 0) {
    io.out("authorbot: no book-format migration is needed for this upgrade");
    return;
  }
  io.out(`authorbot: ${describeMigrationCount(plan.migrations)} will run:`);
  for (const { migration } of plan.migrations) {
    io.out(`  ${migration.id} (${migration.from} -> ${migration.to}): ${migration.description}`);
  }
}

function describeMigrationCount(migrations: readonly SelectedMigration[]): string {
  return `${migrations.length} book-format migration${migrations.length === 1 ? "" : "s"}`;
}

async function runDryRun(
  plan: UpgradePlan,
  options: UpgradeOptions,
  io: CliIo,
  deps: UpgradeDeps,
): Promise<number> {
  // A dry run does the genuinely informative half of the work — migrate a
  // throwaway copy and validate it — so that "no new errors" is a result
  // rather than a hope. The author's repository is never opened for writing.
  const outcome = await migrateWorkingCopy(plan, deps, io);
  const base = options.base ?? (await readDefaultBranch(deps.fs, plan.repoPath));
  const d1 = await readD1Binding(deps.fs, plan.repoPath);
  const newSpec = renderPin(plan.pinLocation.pin, plan.target);

  if (options.json) {
    io.out(
      JSON.stringify(
        {
          dryRun: true,
          current: plan.current.raw,
          target: plan.target.raw,
          pin: { from: plan.pinLocation.pin.spec, to: newSpec, field: plan.pinLocation.field },
          migrations: outcome.applied,
          changedFiles: outcome.changed,
          validation: {
            beforeErrors: outcome.before.errors.length,
            afterErrors: outcome.after.errors.length,
            newErrors: outcome.newErrors,
          },
          wouldAbort: outcome.newErrors.length > 0,
          pullRequestBase: base,
          d1Database: d1?.databaseName ?? null,
        },
        null,
        2,
      ),
    );
    return outcome.newErrors.length > 0 ? 1 : 0;
  }

  io.out("");
  io.out("Plan (nothing below has been done):");
  io.out(`  1. pin ${plan.pinLocation.field}["@authorbot/cli"]: ${plan.pinLocation.pin.spec} -> ${newSpec}`);
  if (outcome.changed.length === 0) {
    io.out("  2. book-format migrations: none change any file");
  } else {
    io.out(`  2. book-format migrations would change ${outcome.changed.length} file(s):`);
    for (const file of outcome.changed) {
      io.out(`       ${file}`);
    }
  }
  io.out(
    `  3. validation: ${outcome.before.errors.length} error(s) before, ` +
      `${outcome.after.errors.length} after, ${outcome.newErrors.length} new`,
  );
  if (outcome.newErrors.length > 0) {
    renderFindings(outcome.newErrors, io);
    io.err("authorbot: this upgrade WOULD BE REFUSED — the migration introduces new errors.");
    return 1;
  }
  io.out(`  4. open a pull request against ${base} with two commits (pin, then migrations)`);
  io.out(
    d1 === undefined
      ? "  5. apply D1 migrations: skipped, no d1_databases binding in wrangler config"
      : `  5. apply pending D1 migrations to ${d1.databaseName}`,
  );
  io.out(
    options.url === undefined
      ? "  6. redeploy and verify health (needs --url, or a URL reported by wrangler)"
      : `  6. redeploy and verify health at ${options.url}`,
  );
  return 0;
}

function pullRequestBody(plan: UpgradePlan, outcome: WorkingCopyOutcome): string {
  const lines = [
    `Upgrades the Authorbot toolchain from **${plan.current.raw}** to **${plan.target.raw}**.`,
    "",
    "Opened by `authorbot upgrade` (ADR-0021 §3). Nothing was pushed to your",
    "default branch; merging this pull request is the decision.",
    "",
    "### Commits",
    "",
    `1. **Toolchain pin** — \`@authorbot/cli\` ${plan.pinLocation.pin.spec} → ${renderPin(plan.pinLocation.pin, plan.target)}.`,
  ];
  if (outcome.changed.length > 0) {
    lines.push(
      `2. **Book-format migrations** — ${outcome.changed.length} file(s) rewritten.`,
      "",
      "These are separate commits on purpose: reverting the pin rolls back the",
      "toolchain, reverting the migration rolls back your file format, and those",
      "are different operations (ADR-0021 §5).",
      "",
      "### Migrations applied",
      "",
    );
    for (const entry of outcome.applied) {
      lines.push(`- \`${entry.id}\` (→ ${entry.to}): ${entry.description}`);
      for (const file of entry.changed) {
        lines.push(`  - \`${file}\``);
      }
    }
  } else {
    lines.push("", "No book-format migration was needed: only the pin changed.");
  }
  lines.push(
    "",
    "### Validation",
    "",
    `Validated before and after the migration with ${plan.target.raw}: ` +
      `${outcome.before.errors.length} error(s) before, ${outcome.after.errors.length} after, ` +
      "**0 new**. An upgrade that introduced an error would have been refused rather",
    "than opened as a pull request.",
    "",
    "### Before merging",
    "",
    "- Read the diff. This is prose and configuration you own.",
    "- Refresh your lockfile if your CI does not (`npm install --package-lock-only`).",
    "- After merging, CI applies pending D1 migrations and redeploys (ADR-0021 §4).",
  );
  return lines.join("\n");
}

function reportValidation(outcome: WorkingCopyOutcome, io: CliIo): void {
  io.out(
    `authorbot: validated before and after — ${outcome.before.errors.length} error(s) before, ` +
      `${outcome.after.errors.length} after, 0 new`,
  );
  if (outcome.after.warnings.length > outcome.before.warnings.length) {
    io.out(
      `authorbot: ${outcome.after.warnings.length - outcome.before.warnings.length} new warning(s) ` +
        "(allowed within a major — see the pull request diff)",
    );
  }
}

function renderFindings(findings: readonly Finding[], io: CliIo): void {
  for (const finding of findings) {
    const pointer = finding.pointer === undefined ? "" : ` [${finding.pointer}]`;
    io.err(`  ${finding.severity} ${finding.code} ${finding.path}${pointer}: ${finding.message}`);
  }
}

/**
 * Honest reporting of a half-finished run.
 *
 * The author needs three things: what actually happened, what did not, and
 * the one command that returns them to where they started. Anything vaguer
 * leaves them guessing about the state of a repository they care about.
 */
function reportPartial(
  io: CliIo,
  completed: readonly string[],
  branch: string,
  originalBranch: string,
  error: unknown,
): void {
  io.err(`authorbot: upgrade did not complete: ${error instanceof Error ? error.message : String(error)}`);
  if (completed.length === 0) {
    io.err("authorbot: nothing was changed.");
    return;
  }
  io.err("authorbot: completed before the failure:");
  for (const step of completed) {
    io.err(`  - ${step}`);
  }
  io.err(`authorbot: your default branch was not touched. The work sits on ${branch}.`);
  io.err(
    `authorbot: to discard it: git checkout ${originalBranch} && git branch -D ${branch}. ` +
      "To keep going, fix the cause and re-run `authorbot upgrade` — it starts from a clean tree.",
  );
}

function branchName(kind: string, version: SemVer, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `authorbot/${kind}-${version.raw}-${stamp}`;
}

// --------------------------------------------------------------------------
// steps 5-6
// --------------------------------------------------------------------------

async function runFinish(
  options: UpgradeOptions,
  io: CliIo,
  deps: UpgradeDeps,
): Promise<number> {
  io.out("authorbot: running steps 5-6 (D1 migrations, redeploy, health) against this checkout.");
  return runDeploySteps(options, options.repoPath, io, deps);
}

async function runDeploySteps(
  options: UpgradeOptions,
  repoPath: string,
  io: CliIo,
  deps: UpgradeDeps,
): Promise<number> {
  // Step 5. Ordered before the deploy on purpose (ADR-0021 §4): the running
  // Worker keeps serving during a deploy, so the schema must arrive first and
  // must be compatible with the code already running.
  const d1 = await readD1Binding(deps.fs, repoPath);
  if (d1 === undefined) {
    io.out("authorbot: step 5 skipped — no d1_databases binding, so there is no database to migrate.");
  } else {
    try {
      const result = await deps.wrangler.applyD1Migrations(repoPath, d1.databaseName);
      io.out(
        result.applied.length === 0
          ? `authorbot: ${d1.databaseName} already has every migration`
          : `authorbot: applied ${result.applied.length} D1 migration(s) to ${d1.databaseName}: ${result.applied.join(", ")}`,
      );
    } catch (error) {
      io.err(
        `authorbot: applying D1 migrations failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      io.err(
        "authorbot: NOT deploying. The Worker was left as it was, which is the safe state: " +
          "deploying code that expects schema the database lacks is the failure this ordering prevents.",
      );
      return 1;
    }
  }

  // Step 6.
  let deployUrl: string | undefined;
  try {
    const result = await deps.wrangler.deploy(repoPath);
    deployUrl = result.url;
    io.out("authorbot: deployed");
  } catch (error) {
    io.err(`authorbot: deploy failed: ${error instanceof Error ? error.message : String(error)}`);
    if (d1 !== undefined) {
      io.err(
        "authorbot: the D1 migrations above WERE applied. They are expand-phase by policy " +
          "(ADR-0021 §4), so the currently-deployed Worker keeps serving; re-run once the deploy is fixed.",
      );
    }
    return 1;
  }

  const url = options.url ?? deployUrl;
  if (url === undefined) {
    io.err(
      "authorbot: deployed, but health could NOT be verified: no URL was reported by wrangler " +
        "and none was given. Re-run with --url <your book's URL> to verify, or check it yourself. " +
        "Reporting success here would be a guess.",
    );
    return 1;
  }
  const health = await deps.health.check(url);
  if (!health.ok) {
    io.err(
      `authorbot: deployed, but ${url} is not healthy` +
        `${health.detail === undefined ? "" : ` (${health.detail})`}.`,
    );
    io.err(
      "authorbot: roll the toolchain back with `authorbot upgrade --rollback <previous version>` " +
        "if the new release is the cause.",
    );
    return 1;
  }
  io.out(`authorbot: ${url} is healthy (HTTP ${health.status ?? 200}). Upgrade complete.`);
  return 0;
}

// --------------------------------------------------------------------------
// --rollback
// --------------------------------------------------------------------------

/**
 * ADR-0021 §5, made behavioural.
 *
 * Rolling back the *toolchain* is a pin change. Rolling back a *format
 * migration* is reverting its commit. They are different operations, and an
 * author who does the first without the second has a new toolchain
 * expectation against old files — the exact state validation exists to catch.
 * So this command does the pin change, names every format migration that sits
 * between the two versions, and re-validates.
 */
async function runRollback(
  options: UpgradeOptions,
  requested: string,
  io: CliIo,
  deps: UpgradeDeps,
): Promise<number> {
  const wanted = parseVersion(requested);
  if (wanted === undefined) {
    io.err(`authorbot: --rollback expects a version like 1.4.0, got "${requested}"`);
    return 2;
  }
  const plan = await resolvePlan(deps, { repoPath: options.repoPath, to: requested });
  const current = plan.current;
  if (compareVersions(plan.target, current) >= 0) {
    io.err(
      `authorbot: ${plan.target.raw} is not older than the current pin (${current.raw}); ` +
        "use `authorbot upgrade --to` to move forward.",
    );
    return 2;
  }

  // Migrations that shipped between the target and the current pin: these
  // are what the pin change does NOT undo.
  const spanned = selectMigrations(deps.migrations, plan.target, current);

  io.out(`authorbot: rolling the TOOLCHAIN back: ${current.raw} -> ${plan.target.raw}`);
  if (spanned.length === 0) {
    io.out("authorbot: no book-format migration ran between these versions, so the pin is all there is.");
  } else {
    io.out("");
    io.out(`authorbot: this does NOT undo ${describeMigrationCount(spanned)} applied between these versions:`);
    for (const { migration } of spanned) {
      io.out(`  ${migration.id} (${migration.from} -> ${migration.to}): ${migration.description}`);
    }
    io.out("authorbot: rolling those back is a separate operation — revert their commit:");
    io.out('  git log --oneline --grep "book-format migrations"');
    io.out("  git revert <that commit>");
    io.out("authorbot: (ADR-0021 §5. Reverting the pin alone leaves migrated files with an older toolchain.)");
  }

  if (options.dryRun) {
    io.out("");
    io.out(`authorbot: --dry-run; the pin would become ${renderPin(plan.pinLocation.pin, plan.target)} and nothing else changed.`);
    return 0;
  }

  if (!(await deps.git.isClean(plan.repoPath))) {
    io.err("authorbot: the working tree has uncommitted changes; commit or stash them first.");
    return 2;
  }
  const originalBranch = await deps.git.currentBranch(plan.repoPath);
  const branch = branchName("rollback", plan.target, deps.now());
  const base = options.base ?? (await readDefaultBranch(deps.fs, plan.repoPath));
  const completed: string[] = [];

  try {
    await deps.git.createBranch(plan.repoPath, branch);
    completed.push(`created branch ${branch}`);
    const newSpec = renderPin(plan.pinLocation.pin, plan.target);
    await deps.fs.writeFile(
      path.join(plan.repoPath, "package.json"),
      rewritePin(plan.pinLocation.packageJsonText, newSpec),
    );
    const rollbackRelocked = await deps.lockfile.relock(plan.repoPath);
    await deps.git.commit(plan.repoPath, {
      message:
        `chore(authorbot): roll back toolchain ${current.raw} -> ${plan.target.raw}\n\n` +
        "Toolchain only. Book-format migrations, if any ran, are reverted separately\n" +
        "(ADR-0021 §5).",
      paths: rollbackRelocked ? ["package.json", "package-lock.json"] : ["package.json"],
    });
    completed.push("committed the pin rollback");
    await deps.git.push(plan.repoPath, branch);
    completed.push(`pushed ${branch}`);
    const url = await deps.git.openPullRequest(plan.repoPath, {
      branch,
      base,
      title: `Roll back Authorbot ${current.raw} -> ${plan.target.raw}`,
      body:
        `Rolls the Authorbot toolchain pin back to **${plan.target.raw}**.\n\n` +
        "This is a **toolchain** rollback. It does not undo any book-format\n" +
        "migration (ADR-0021 §5)" +
        (spanned.length === 0
          ? ", and none ran between these versions.\n"
          : `; ${spanned.length} ran between these versions and must be reverted separately:\n\n` +
            spanned.map(({ migration }) => `- \`${migration.id}\`: ${migration.description}`).join("\n") +
            "\n"),
    });
    completed.push("opened the pull request");
    io.out(`authorbot: pull request opened: ${url}`);
  } catch (error) {
    reportPartial(io, completed, branch, originalBranch, error);
    return 1;
  }

  // Re-validate on rollback (ADR-0021 §5): the point of the exercise is to
  // find out whether old toolchain expectations still match these files.
  const report = await deps.validate(plan.repoPath);
  if (report.errors.length > 0) {
    io.err(`authorbot: after the rollback the book has ${report.errors.length} validation error(s):`);
    renderFindings(report.errors, io);
    io.err(
      "authorbot: this is what ADR-0021 §5 warns about — an older toolchain against migrated files. " +
        "Revert the book-format migration commit as well, then re-validate.",
    );
    return 1;
  }
  io.out(
    `authorbot: re-validated after the rollback: ${report.errors.length} error(s), ` +
      `${report.warnings.length} warning(s).`,
  );
  io.out(
    `authorbot: note — that check ran with the toolchain installed here (${current.raw}), not with ` +
      `${plan.target.raw}. Once the pull request merges and ${plan.target.raw} is installed, run ` +
      "`authorbot validate .` again to confirm.",
  );
  return 0;
}
