/**
 * `upgrade` — moving to a newer Authorbot (Phase 6 contract §3.7, ADR-0021).
 *
 * This stage **delegates**. `authorbot upgrade` is the implementation: it
 * resolves the pin against the target release, runs that release's book-repo
 * migrations, validates before and after, opens a pull request rather than
 * pushing, applies pending D1 migrations, redeploys, and verifies health.
 *
 * Reimplementing any of that here would produce two upgraders that must agree
 * forever — and the one inside the CLI is the one an author's scheduled
 * `--check` job runs. So this stage's whole job is to find the CLI, forward
 * the flags, and degrade with a clear message when it is not there.
 */
import { WizardError } from "../errors.js";
import type { Stage, StageOutcome, WizardContext } from "../context.js";
import { resolveTool, runTool } from "../toolchain.js";
import { requireBookDirectory } from "./shared.js";

export const upgradeStage: Stage = async (ctx: WizardContext): Promise<StageOutcome> => {
  ctx.reporter.heading("Checking for a newer Authorbot");
  ctx.reporter.explain(
    "This moves your book to a newer version of Authorbot, including any changes to the book's own file format. It opens a pull request rather than pushing, so you see exactly what changed and can decline it.",
  );

  await requireBookDirectory(ctx);

  const resolved = await resolveTool(ctx, "authorbot");
  if (resolved === null) {
    // Not an error: a book whose dependencies are not installed yet has
    // nothing to upgrade *from*, and saying so is more use than failing.
    ctx.reporter.warn("The `authorbot` command is not available here, so there is nothing to check.");
    ctx.reporter.info(
      `Run \`npm install\` in ${ctx.directory} (it installs the toolchain your book pins), then run \`create-authorbot upgrade\` again. If your book was created moments ago it is already on the current version.`,
    );
    return { continue: true, note: "upgrade skipped: authorbot not installed" };
  }

  const args = ["upgrade"];
  if (ctx.options.check) {
    args.push("--check");
  }
  if (ctx.actions.dryRun) {
    args.push("--dry-run");
  }
  if (ctx.options.nonInteractive) {
    args.push("--non-interactive");
  }

  ctx.reporter.step(`Running \`authorbot ${args.join(" ")}\``);
  const result = await runTool(ctx, "authorbot", args, {
    purpose: "move the book to a newer Authorbot release",
    // Even `--check` is declared as mutating so a dry run plans it rather than
    // running it: `--dry-run` must change nothing, and deciding which
    // sub-invocations of another program are safe is not this stage's call.
    mutates: true,
    timeoutMs: 900_000,
  });

  if (result === null) {
    throw new WizardError(
      "The `authorbot` command disappeared between finding it and running it.",
      `Run \`npx authorbot ${args.join(" ")}\` in ${ctx.directory} yourself.`,
    );
  }

  const output = (result.stdout + result.stderr).trim();
  if (output.length > 0) {
    ctx.reporter.literal(output);
  }

  // `authorbot upgrade --check` signals its finding through the exit code
  // (ADR-0021 §3): 0 nothing to do, 10 an upgrade is available, 11 available
  // and carrying a book-format migration. Anything else is a real failure.
  //
  // These are matched by value rather than imported, deliberately: the wizard
  // runs whichever `authorbot` the author has installed, which may be a
  // different version than this package. The exit codes are a documented wire
  // contract between the two, not a shared constant. An UNRECOGNISED non-zero
  // code is therefore treated as a failure, never as good news — reporting
  // "an upgrade is available" when the check actually broke would be a
  // fabricated success.
  const CHECK_AVAILABLE = 10;
  const CHECK_AVAILABLE_WITH_MIGRATION = 11;
  if (result.code !== 0) {
    if (
      ctx.options.check &&
      (result.code === CHECK_AVAILABLE || result.code === CHECK_AVAILABLE_WITH_MIGRATION)
    ) {
      const migration = result.code === CHECK_AVAILABLE_WITH_MIGRATION;
      ctx.reporter.info(
        migration
          ? "An upgrade is available, and it updates your book's file format. Run `create-authorbot upgrade` without --check: the changes arrive as a pull request you review before anything lands."
          : "An upgrade is available. Run `create-authorbot upgrade` without --check to prepare the pull request.",
      );
      return { continue: true, note: migration ? "upgrade available (format migration)" : "upgrade available" };
    }
    if (/unknown command|not a command|unrecognized/i.test(output)) {
      throw new WizardError(
        "The installed Authorbot toolchain is too old to understand `authorbot upgrade`.",
        "Update it by hand once — `npm install --save-dev @authorbot/cli@latest` in your book directory — and every upgrade after that can use this command.",
      );
    }
    throw new WizardError(
      `The upgrade did not finish (exit ${String(result.code)}).`,
      `Run \`npx authorbot ${args.join(" ")}\` in ${ctx.directory} to see the full output. Nothing was pushed — upgrades arrive as a pull request you review.`,
    );
  }

  ctx.reporter.ok(
    ctx.options.check ? "Your book is on the current version." : "Upgrade prepared.",
  );
  return { continue: true, note: "upgrade completed" };
};
