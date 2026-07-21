/**
 * `unpublish` and `teardown` - taking it all back down again.
 *
 * The wizard has always ended by listing what it created and how to remove it,
 * which is honest but leaves the author to run five commands in the right
 * order across two providers and one browser page. These stages do it.
 *
 * - **`unpublish`** removes everything outside GitHub's repository: the
 *   Cloudflare Worker, the D1 database, and the GitHub App. The repository -
 *   the book itself, its whole history - is untouched. This is the one to
 *   reach for when the hosting is wrong and the writing is not.
 * - **`teardown`** does all of that and then deletes the remote repository,
 *   finishing with what to type to remove the local copy. It never deletes
 *   local files itself.
 *
 * THE LOCAL DIRECTORY IS NEVER TOUCHED. `rm -rf` on a directory the wizard
 * derived from a flag, run by a tool the author invoked to clean up their
 * *hosting*, is the one mistake here that cannot be undone with a re-run -
 * their drafts may be the only copy. It is printed, not executed.
 *
 * COMMANDS ARE REBUILT, NOT REPLAYED. The journal records a `deleteWith`
 * string for every resource, and it is tempting to just run it. But
 * `.authorbot-setup.json` is an ordinary file that a shared, forked, or
 * published book can carry, and `journal.ts` is explicit that its contents are
 * validated rather than adopted. Executing a string out of it would be a
 * command line assembled by whoever wrote the file. So `deleteWith` is shown
 * to the author and never run: each command is rebuilt here from the resource
 * kind and its validated name.
 */
import { AbortedError, WizardError } from "../errors.js";
import type { Stage, StageOutcome, WizardContext } from "../context.js";
import { nowIso } from "../context.js";
import type { CreatedResource } from "../journal.js";
import { D1_NAME_RE, REPO_RE, validateWorkerName } from "../slug.js";

/** Resources that live outside the repository. `unpublish` removes these. */
const HOSTING_KINDS = ["cloudflare-worker", "d1-database", "github-app"] as const;

/** Only `teardown` touches this. */
const REPO_KIND = "github-repo";

interface Removal {
  readonly resource: CreatedResource;
  /** The command to run, or null when only a human with a browser can do it. */
  readonly command: { readonly file: string; readonly args: readonly string[] } | null;
  /** Shown when there is no command. */
  readonly manual?: string;
}

/**
 * Turns a recorded resource into something safe to run.
 *
 * Returns null for a resource whose name does not match the shape its provider
 * uses - a journal that has been edited, or carried in from elsewhere, does not
 * get to choose an argument here.
 */
function removalFor(resource: CreatedResource): Removal | null {
  const name = resource.name.trim();
  switch (resource.kind) {
    case "cloudflare-worker":
      if (validateWorkerName(name) !== null) {
        return null;
      }
      return { resource, command: { file: "wrangler", args: ["delete", "--name", name] } };
    case "d1-database":
      if (!D1_NAME_RE.test(name)) {
        return null;
      }
      return { resource, command: { file: "wrangler", args: ["d1", "delete", name, "-y"] } };
    case "github-repo":
      if (!REPO_RE.test(name)) {
        return null;
      }
      return { resource, command: { file: "gh", args: ["repo", "delete", name, "--yes"] } };
    case "github-app":
      // GitHub has no API for deleting an app: the manifest flow creates it in
      // a browser and only a browser can remove it.
      // Straight to the page with the button on it. "Open the apps list, find
      // yours, then Advanced" is three navigations to reach a link we can
      // simply give them - and the app's name is its slug, because the wizard
      // names it `authorbot-<slug>` precisely so GitHub does not reshape it.
      return {
        resource,
        command: null,
        manual: `https://github.com/settings/apps/${name}/advanced - the Delete GitHub App button is at the bottom.`,
      };
    default:
      // An agent token is a row in the book's own database, which the D1
      // deletion above takes with it. Anything else unknown is listed rather
      // than guessed at.
      return { resource, command: null, manual: resource.deleteWith };
  }
}

async function run(ctx: WizardContext, mode: "unpublish" | "teardown"): Promise<StageOutcome> {
  const wantRepo = mode === "teardown";
  ctx.reporter.heading(wantRepo ? "Taking the whole book down" : "Taking the site down");
  ctx.reporter.explain(
    wantRepo
      ? "This deletes everything this wizard created for your book, including the GitHub repository and its entire history. Your local files are never touched - you will be told how to remove them yourself."
      : "This deletes the reading site and the collaboration database, and removes the GitHub App. Your repository and everything in it is left exactly as it is, so the book itself survives.",
  );

  const wanted = new Set<string>(HOSTING_KINDS);
  if (wantRepo) {
    wanted.add(REPO_KIND);
  }
  const resources = ctx.journal.resources().filter((entry) => wanted.has(entry.kind));

  if (resources.length === 0) {
    ctx.reporter.ok(
      "Nothing recorded to remove. If you created something by hand, or the setup journal is gone, the Cloudflare and GitHub dashboards are the place to look.",
    );
    return { continue: false, note: "nothing to remove" };
  }

  const removals = resources.map(removalFor);

  ctx.reporter.blank();
  ctx.reporter.info(wantRepo ? "This will delete:" : "This will delete:");
  for (const [index, removal] of removals.entries()) {
    const resource = resources[index] as CreatedResource;
    if (removal === null) {
      ctx.reporter.warn(
        `${resource.name} (${resource.kind}) - the setup journal records a name this wizard will not pass to a command. Remove it yourself: ${resource.deleteWith}`,
      );
      continue;
    }
    ctx.reporter.info(`  ${resource.name} - ${resource.description}`);
  }

  if (wantRepo) {
    ctx.reporter.blank();
    ctx.reporter.warn(
      "Deleting the repository deletes every chapter, every revision, and every comment ever recorded in it. There is no undo, and no copy left anywhere but your own disk.",
    );
  }

  const proceed = await ctx.prompter.confirm({
    id: wantRepo ? "teardown.confirm" : "unpublish.confirm",
    message: wantRepo
      ? "Delete all of this, including the repository?"
      : "Delete the site and its database?",
    hint: wantRepo
      ? "Nothing here can be recovered. Your local files stay where they are."
      : "Your repository is not touched, so `create-authorbot publish` can put the site back.",
    defaultValue: false,
  });
  if (!proceed) {
    throw new AbortedError(wantRepo ? "nothing was deleted" : "nothing was deleted");
  }

  const removed: string[] = [];
  const leftBehind: string[] = [];

  for (const removal of removals) {
    if (removal === null) {
      continue;
    }
    const { resource, command } = removal;
    if (command === null) {
      leftBehind.push(`${resource.name} - ${removal.manual ?? resource.deleteWith}`);
      continue;
    }

    ctx.reporter.step(`Deleting ${resource.name}`);
    const result = await ctx.actions.run({
      purpose: `delete ${resource.kind} ${resource.name}`,
      command: command.file,
      args: [...command.args],
      cwd: ctx.directory,
      mutates: true,
    });

    // "Already gone" is success: this stage has to be re-runnable after a
    // partial failure, and a resource someone removed by hand in between is
    // exactly the outcome being asked for.
    const output = `${result.stdout}\n${result.stderr}`;
    const alreadyGone = /not found|does not exist|could not find|no such/i.test(output);
    if (result.code === 0 || alreadyGone) {
      removed.push(resource.name);
      await ctx.journal.forgetResource(resource.kind, resource.name, nowIso(ctx));
      ctx.reporter.ok(alreadyGone ? `${resource.name} was already gone.` : `${resource.name} deleted.`);
    } else {
      leftBehind.push(`${resource.name} - ${resource.deleteWith}`);
      ctx.reporter.warn(
        `Could not delete ${resource.name}: ${(result.stderr || result.stdout).trim().split("\n")[0] ?? "unknown error"}`,
      );
    }
  }

  ctx.reporter.blank();
  if (removed.length > 0) {
    ctx.reporter.ok(`Removed ${String(removed.length)}: ${removed.join(", ")}.`);
  }
  if (leftBehind.length > 0) {
    ctx.reporter.blank();
    ctx.reporter.warn("Still there, and needing you:");
    for (const line of leftBehind) {
      ctx.reporter.info(`  ${line}`);
    }
  }

  // The Cloudflare API token is not on the resource list, because the wizard
  // never created it - the author made it in the dashboard and pasted it in.
  // That is exactly why it needs saying: it is a live credential with rights
  // over every Worker in the account, it outlives everything this just
  // deleted, and nothing else is ever going to mention it again.
  if (ctx.journal.hasSecret("CLOUDFLARE_API_TOKEN")) {
    ctx.reporter.blank();
    ctx.reporter.warn("One credential is left, and only you can remove it:");
    ctx.reporter.info(
      "  The Cloudflare API token you created for CI. It still works, and still has permission over your Workers.",
    );
    ctx.reporter.literal("https://dash.cloudflare.com/profile/api-tokens");
  }

  if (wantRepo) {
    ctx.reporter.blank();
    ctx.reporter.info(
      "Your local copy is untouched - this wizard does not delete files on your own disk. When you are sure you want it gone:",
    );
    ctx.reporter.literal(`rm -rf ${ctx.directory}`);
  } else {
    ctx.reporter.blank();
    ctx.reporter.info(
      "Your repository and every chapter in it are untouched. `create-authorbot publish` will put the site back.",
    );
  }

  return {
    continue: false,
    note: `${mode}: removed ${String(removed.length)}, ${String(leftBehind.length)} left`,
  };
}

export const unpublishStage: Stage = (ctx: WizardContext): Promise<StageOutcome> =>
  run(ctx, "unpublish");

export const teardownStage: Stage = (ctx: WizardContext): Promise<StageOutcome> =>
  run(ctx, "teardown");
