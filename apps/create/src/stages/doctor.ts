/**
 * `doctor` - prerequisites (Phase 6 contract §3.1).
 *
 * Detects and reports, with install guidance, and installs nothing unasked.
 * It also runs standalone against an existing project, which is why it never
 * requires a book directory to exist and never writes anything except its own
 * journal entry.
 */
import type { Stage, StageOutcome, WizardContext } from "../context.js";
import {
  checkGh,
  checkGit,
  checkNode,
  checkPnpm,
  checkWrangler,
  type ToolReport,
} from "../tools.js";

export interface DoctorResult {
  readonly reports: readonly ToolReport[];
  /** True when every *required* tool is ok. */
  readonly ready: boolean;
}

/**
 * Runs every probe and prints the report. Exported separately from the stage
 * so later stages can re-use the findings without re-running the stage (and
 * without re-printing it).
 */
export async function diagnose(ctx: WizardContext): Promise<DoctorResult> {
  const reports: ToolReport[] = [
    checkNode(ctx.env.nodeVersion),
    await checkGit(ctx.actions),
    await checkGh(ctx.actions),
    await checkWrangler(ctx.actions),
    await checkPnpm(ctx.actions),
  ];
  const ready = reports.every((report) => !report.required || report.status === "ok");
  return { reports, ready };
}

function line(report: ToolReport): string {
  const detail = [report.version, report.account].filter((part) => part !== undefined).join(", ");
  const suffix = detail.length > 0 ? ` (${detail})` : "";
  return `${report.name}${suffix} - ${report.purpose}`;
}

export const doctorStage: Stage = async (ctx: WizardContext): Promise<StageOutcome> => {
  ctx.reporter.heading("Checking your machine");
  ctx.reporter.explain(
    "Authorbot leans on a few tools you probably already have. Nothing is installed here - this only looks, and tells you what to do about anything missing.",
  );

  const { reports, ready } = await diagnose(ctx);

  for (const report of reports) {
    if (report.status === "ok") {
      ctx.reporter.ok(line(report));
    } else if (report.required) {
      ctx.reporter.fail(line(report));
    } else {
      ctx.reporter.warn(line(report));
    }
    if (report.remedy !== undefined) {
      ctx.reporter.info(report.remedy);
    }
  }

  // The two sign-in flows are offered, never scripted: both open a browser and
  // neither should ever be handed a password by a wizard.
  const offers = reports.filter((report) => report.status === "unauthenticated");
  for (const report of offers) {
    if (ctx.options.nonInteractive || ctx.options.dryRun) {
      continue;
    }
    const command = report.name === "gh" ? ["gh", "auth", "login"] : ["wrangler", "login"];
    const approved = await ctx.prompter.confirm({
      id: `doctor.login.${report.name}`,
      message: `Run \`${command.join(" ")}\` now? It opens your browser; Authorbot never sees your password.`,
      defaultValue: true,
    });
    if (!approved) {
      continue;
    }
    ctx.reporter.info("Follow the prompts in your browser, then come back here.");
    // Inherited stdio is not available through the runner, so the command is
    // run to completion and its output surfaced afterwards; both tools print
    // a URL and a code that the author needs to see.
    const result = await ctx.actions.run({
      purpose: `sign in to ${report.name}`,
      command: command[0] ?? report.name,
      args: command.slice(1),
      mutates: true,
      timeoutMs: 300_000,
    });
    if (result.stdout.trim().length > 0) {
      ctx.reporter.literal(result.stdout.trim());
    }
    if (result.code === 0) {
      ctx.reporter.ok(`${report.name} is signed in.`);
    } else {
      ctx.reporter.warn(
        `${report.name} is still not signed in. Run \`${command.join(" ")}\` in another terminal, then run this again.`,
      );
    }
  }

  ctx.reporter.blank();
  if (ready) {
    ctx.reporter.ok("Everything required is in place.");
  } else {
    ctx.reporter.warn(
      "Something required is missing. Fix the items marked above, then run this again - nothing you have already done will be repeated.",
    );
  }

  return {
    continue: ready,
    note: ready ? "all required tools present" : "required tools missing",
  };
};
