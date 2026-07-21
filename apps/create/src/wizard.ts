/**
 * The stage runner: resume, ordering, stop-where-you-like, and the closing
 * report of everything that now exists outside the author's machine.
 */
import { AbortedError, WizardError } from "./errors.js";
import type { Stage, StageOutcome, WizardContext } from "./context.js";
import { nowIso } from "./context.js";
import { agentStage } from "./stages/agent.js";
import { bookStage } from "./stages/book.js";
import { collaborateStage } from "./stages/collaborate.js";
import { doctorStage } from "./stages/doctor.js";
import { publishStage } from "./stages/publish.js";
import { upgradeStage } from "./stages/upgrade.js";
import {
  OPTIONAL_STAGES,
  STAGE_NAMES,
  STAGE_SUMMARIES,
  type StageName,
} from "./stages/names.js";

export const STAGES: Record<StageName, Stage> = {
  doctor: doctorStage,
  book: bookStage,
  publish: publishStage,
  collaborate: collaborateStage,
  agent: agentStage,
  upgrade: upgradeStage,
};

export interface RunResult {
  /** Process exit code. */
  readonly code: number;
  readonly completed: readonly StageName[];
}

/**
 * Runs `stages` in order, journalling as it goes.
 *
 * Resume (contract §2.2) is not a special mode: a stage already marked done is
 * skipped when the whole flow is running, and re-run when the author names it
 * explicitly. Naming a stage is an instruction, and second-guessing it would
 * make "do this again" impossible to express.
 */
export async function runStages(
  ctx: WizardContext,
  stages: readonly StageName[],
  options: { readonly explicit: boolean },
): Promise<RunResult> {
  const completed: StageName[] = [];

  for (const [index, name] of stages.entries()) {
    if (!options.explicit && ctx.journal.isDone(name)) {
      ctx.reporter.info(`Already done: ${name}. Skipping.`);
      completed.push(name);
      continue;
    }

    // Optional stages are offered rather than run, with the previous stage's
    // result already on screen — which is the only moment the author has
    // enough information to decide.
    if (!options.explicit && index > 0 && OPTIONAL_STAGES.includes(name)) {
      const wanted = await ctx.prompter.confirm({
        id: `flow.continue.${name}`,
        message: `Next: ${STAGE_SUMMARIES[name]} Do that now?`,
        hint: `You can stop here and run \`create-authorbot ${name}\` whenever you like — nothing you have done will be repeated.`,
        defaultValue: name !== "upgrade" && name !== "agent",
      });
      if (!wanted) {
        ctx.reporter.blank();
        ctx.reporter.ok(
          `Stopped here, with everything so far in place. Run \`create-authorbot ${name}\` when you want to continue.`,
        );
        break;
      }
    }

    await ctx.journal.markStage(name, "started", nowIso(ctx));
    let outcome: StageOutcome;
    try {
      outcome = await STAGES[name](ctx);
    } catch (error) {
      await ctx.journal.markStage(
        name,
        "failed",
        nowIso(ctx),
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    await ctx.journal.markStage(name, "done", nowIso(ctx), outcome.note);
    completed.push(name);

    if (!outcome.continue) {
      break;
    }
  }

  return { code: 0, completed };
}

/**
 * The closing report (contract §2.6): everything that now exists outside this
 * machine, and how to remove it. Printed on success *and* on failure, because
 * the author who most needs it is the one who gave up halfway.
 */
export function reportResources(ctx: WizardContext): void {
  const resources = ctx.journal.resources();
  if (resources.length === 0) {
    return;
  }
  ctx.reporter.heading("What now exists, and how to remove it");
  ctx.reporter.explain(
    "These live outside your machine. If you decide not to keep this book, this is everything to clean up — nothing else was created anywhere.",
  );
  for (const resource of resources) {
    ctx.reporter.bullet(`${resource.name} — ${resource.description}`);
    ctx.reporter.literal(resource.deleteWith);
  }
}

/** Partial-failure report (contract §5): what exists, what does not, resume. */
export function reportProgress(ctx: WizardContext, order: readonly StageName[]): void {
  ctx.reporter.heading("Where you got to");
  for (const name of order) {
    const record = ctx.journal.stage(name);
    const marker =
      record.status === "done"
        ? "done "
        : record.status === "failed"
          ? "FAILED"
          : record.status === "started"
            ? "part  "
            : "todo ";
    ctx.reporter.info(`${marker}  ${name} — ${STAGE_SUMMARIES[name]}`);
  }
  const next = ctx.journal.resumeAt(order);
  if (next !== null) {
    ctx.reporter.blank();
    ctx.reporter.info("To pick up where this left off:");
    ctx.reporter.literal(`create-authorbot ${next}`);
  }
}

/**
 * Turns any thrown value into an author-facing message. Stack traces never
 * reach the terminal: they are unreadable, they name our files rather than the
 * author's problem, and they can carry values that appeared as arguments.
 */
export function reportError(ctx: WizardContext, error: unknown): number {
  if (error instanceof AbortedError) {
    ctx.reporter.blank();
    ctx.reporter.ok(error.message);
    ctx.reporter.info(error.nextAction);
    return 0;
  }
  if (error instanceof WizardError) {
    ctx.reporter.problem(error.message, error.nextAction);
    return 1;
  }
  ctx.reporter.problem(
    ctx.vault.redact(error instanceof Error ? error.message : String(error)),
    "This is a bug in the wizard rather than something you did. Please report it at https://github.com/JoeMattie/authorbot/issues — and re-running is safe, because every step checks before it acts.",
  );
  return 1;
}

export { STAGE_NAMES };
