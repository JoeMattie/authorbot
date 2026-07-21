/**
 * `book` — create the book repository (Phase 6 contract §3.2).
 *
 * Three questions, and no more: **title**, **slug**, and **public or
 * private**. Everything else an author might eventually want to decide is
 * editable later in the browser (§3.6), and asking now would mean asking
 * someone to choose before they have anything to choose about.
 *
 * There are no chapters and no sample content. That is deliberate: a book
 * with zero chapters validates, builds, and publishes, and the first chapter
 * comes from the site's "New chapter" button — an author's first act should
 * not be hand-writing frontmatter and block markers.
 */
import path from "node:path";
import { WizardError } from "../errors.js";
import type { Stage, StageOutcome, WizardContext } from "../context.js";
import { nowIso } from "../context.js";
import { uuidv7 } from "../ids.js";
import { deriveSlug, validateSlug } from "../slug.js";
import { assertBookYmlValid, scaffoldFiles, type BookIdentity } from "../scaffold/render.js";
import { checkGh, checkGit, ghLogin, requireTool } from "../tools.js";
import { runAuthorbot } from "../toolchain.js";
import { resolveRepo } from "./shared.js";

/** Files whose presence means "this directory already holds a book". */
const BOOK_MARKER = "book.yml";

export const bookStage: Stage = async (ctx: WizardContext): Promise<StageOutcome> => {
  ctx.reporter.heading("Creating your book");
  ctx.reporter.explain(
    "This makes a folder that is your book: a title, a web address, and the files Authorbot needs. It has no chapters yet — that is normal, and you will write the first one in your browser rather than in a text editor.",
  );

  const git = await checkGit(ctx.actions);
  requireTool(git, "book");

  const gh = await checkGh(ctx.actions);
  const authorLogin = gh.status === "ok" ? await ghLogin(ctx.actions) : null;

  // ---- the three questions ------------------------------------------------

  const existingTitle = ctx.journal.data.book?.title;
  const title = await ctx.prompter.text({
    id: "book.title",
    message: "What is your book called?",
    hint: "You can change this later from your book's settings.",
    ...(existingTitle === undefined ? {} : { defaultValue: existingTitle }),
    validate: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return "A title is required.";
      }
      if (trimmed.length > 200) {
        return "That title is very long; keep it under 200 characters.";
      }
      return null;
    },
  });

  const derived = deriveSlug(title.trim());
  const slug = await ctx.prompter.text({
    id: "book.slug",
    message: "And its short name, for web addresses?",
    hint: `This becomes part of your URLs, like /chapters/<chapter>/ on your site. Lowercase letters, numbers, and hyphens.${
      derived.length === 0
        ? " Your title has no letters or numbers to build one from, so please type one."
        : ""
    }`,
    ...(ctx.journal.data.book?.slug !== undefined
      ? { defaultValue: ctx.journal.data.book.slug }
      : derived.length > 0
        ? { defaultValue: derived }
        : {}),
    validate: validateSlug,
  });

  const visibility = (await ctx.prompter.select({
    id: "book.visibility",
    message: "Should the repository holding your book be public or private?",
    choices: [
      {
        value: "private",
        label: "Private — only you and people you invite can see it",
        hint: "The usual choice for a work in progress. Your published reading site can still be public; this is about the drafts, notes, and history.",
      },
      {
        value: "public",
        label: "Public — anyone can read the repository",
        hint: "Everything, including every draft and every revision, is visible to anyone from the first commit onward.",
      },
    ],
    defaultValue: ctx.journal.data.book?.visibility ?? "private",
  })) as "public" | "private";

  // ---- scaffold -----------------------------------------------------------

  const id = ctx.journal.data.book?.id ?? uuidv7(ctx.clock, ctx.random);
  const identity: BookIdentity = {
    title: title.trim(),
    slug,
    id,
    workerName: slug,
    ...(authorLogin === null ? {} : { authorLogin }),
  };

  const files = scaffoldFiles(identity);
  const bookYml = files.find((file) => file.path === BOOK_MARKER);
  if (bookYml === undefined) {
    throw new WizardError(
      "The scaffold did not produce a book.yml.",
      "This is a bug in the wizard; please report it.",
    );
  }
  assertBookYmlValid(bookYml.contents);

  ctx.reporter.blank();
  ctx.reporter.step(`Writing ${String(files.length)} files into ${ctx.directory}`);

  await ctx.actions.mkdirp(ctx.directory);
  let written = 0;
  for (const file of files) {
    const outcome = await ctx.actions.writeFile({
      filePath: path.join(ctx.directory, file.path),
      contents: file.contents,
      purpose: file.purpose,
      // `.gitkeep` placeholders exist only to hold an empty directory. Once a
      // directory has real content the file is meaningless, so an existing one
      // that differs is left alone rather than argued about.
      ...(file.path.endsWith(".gitkeep") ? ({ onConflict: "keep" } as const) : {}),
    });
    if (outcome === "written" || outcome === "planned") {
      written += 1;
    }
  }
  ctx.reporter.ok(
    written === 0
      ? "Every file was already in place — nothing needed changing."
      : `${String(written)} files ready.`,
  );

  await ctx.journal.update((data) => {
    data.book = {
      title: identity.title,
      slug: identity.slug,
      id: identity.id,
      visibility,
      defaultBranch: "main",
      ...(data.book?.repo === undefined ? {} : { repo: data.book.repo }),
    };
  }, nowIso(ctx));

  // ---- the pinned toolchain -----------------------------------------------
  //
  // ADR-0022 puts the toolchain pin in the book's own package.json, so the
  // book is not self-sufficient until its dependencies are installed. Doing it
  // here rather than leaving it to the author serves three things at once:
  // the validation gate below gets the pinned `authorbot` instead of falling
  // through to whatever npx can find; `package-lock.json` comes into existence
  // and is committed by the git step that follows; and both generated
  // workflows stop failing on their first run, because `npm ci` refuses to
  // work without that lockfile.
  //
  // A failure here is not fatal. The book on disk is complete and valid
  // without it — the author can install later — so this reports and moves on
  // rather than discarding a scaffold over a network problem.

  if (!ctx.actions.dryRun) {
    ctx.reporter.step("Installing the Authorbot toolchain this book pins");
    const install = await ctx.actions.run({
      purpose: "install the toolchain pinned in the book's package.json",
      command: "npm",
      args: ["install", "--no-audit", "--no-fund"],
      cwd: ctx.directory,
      mutates: true,
      timeoutMs: 300_000,
    });
    if (install.code === 0) {
      ctx.reporter.ok("Toolchain installed, and package-lock.json now pins it.");
    } else {
      ctx.reporter.warn(
        "Could not install the toolchain (`npm install` failed). Your book is complete and valid; run `npm install` here when you can, and commit package-lock.json — CI needs it.",
      );
    }
  } else {
    ctx.actions.note(
      "run: npm install",
      "Installs the toolchain the book pins and writes package-lock.json, which both generated workflows require.",
    );
  }

  // ---- validation gate ----------------------------------------------------
  //
  // Contract §3.2: "Runs `authorbot validate` and does not proceed until it
  // passes." A book that does not validate cannot publish, so shipping it
  // forward would only move the failure somewhere less legible.

  if (!ctx.actions.dryRun) {
    ctx.reporter.step("Checking the book against Authorbot's rules");
    const validation = await runAuthorbot(ctx, ["validate", "."], {
      purpose: "check that the new book is valid",
    });
    if (validation === null) {
      ctx.reporter.warn(
        "Could not run `authorbot validate` — the toolchain is not installed yet. It will run in CI on your first push.",
      );
    } else if (validation.code !== 0) {
      throw new WizardError(
        `The new book did not pass validation:\n${(validation.stdout || validation.stderr).trim()}`,
        `Run \`npx authorbot validate .\` in ${ctx.directory} to see the full report. This is a bug in the wizard if you did not edit the files yourself; please report it.`,
      );
    } else {
      ctx.reporter.ok("The book is valid.");
    }
  } else {
    ctx.actions.note(
      "run: npx authorbot validate .",
      "Confirms the new book passes every Authorbot rule before anything else happens.",
    );
  }

  // ---- git ----------------------------------------------------------------

  await initialiseGit(ctx, identity);

  // ---- GitHub repository --------------------------------------------------

  const repo = await maybeCreateRemote(ctx, identity, visibility, gh.status === "ok");

  ctx.reporter.blank();
  ctx.reporter.ok(`Your book exists: ${ctx.directory}`);
  if (repo !== null) {
    ctx.reporter.info(`On GitHub: https://github.com/${repo}`);
  }

  return { continue: true, note: `book "${identity.slug}" created` };
};

/**
 * `git init` plus the first commit, both idempotent: an existing repository is
 * reused, and a clean tree produces no second commit.
 */
async function initialiseGit(ctx: WizardContext, identity: BookIdentity): Promise<void> {
  const alreadyRepo = await ctx.fs.exists(path.join(ctx.directory, ".git"));
  if (!alreadyRepo) {
    ctx.reporter.step("Starting the history of your book (git)");
    await ctx.actions.run({
      purpose: "start tracking the book's history",
      command: "git",
      args: ["init", "-b", "main"],
      cwd: ctx.directory,
      mutates: true,
      required: true,
    });
  }

  await ctx.actions.run({
    purpose: "stage the new files",
    command: "git",
    args: ["add", "."],
    cwd: ctx.directory,
    mutates: true,
    required: true,
  });

  if (ctx.actions.dryRun) {
    ctx.actions.note(
      'run: git commit -m "Start <your book>"',
      "The first commit, so nothing you have made so far can be lost.",
    );
    return;
  }

  // `--quiet --exit-code` on the staged diff: nothing staged means nothing to
  // commit, and re-running the wizard must not produce empty commits.
  const staged = await ctx.actions.run({
    purpose: "see whether anything needs committing",
    command: "git",
    args: ["diff", "--cached", "--quiet"],
    cwd: ctx.directory,
    mutates: false,
  });
  if (staged.code === 0) {
    ctx.reporter.info("Nothing new to commit — the history is already up to date.");
    return;
  }

  const commit = await ctx.actions.run({
    purpose: "make the first commit",
    command: "git",
    args: ["commit", "-m", `Start ${identity.title}`],
    cwd: ctx.directory,
    mutates: true,
  });
  if (commit.code !== 0) {
    // Overwhelmingly the cause is an unset user.name/user.email, which has a
    // specific fix worth naming rather than dumping git's output.
    throw new WizardError(
      `Git could not make the first commit:\n${(commit.stderr || commit.stdout).trim()}`,
      'If Git asked who you are, run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`, then run this again.',
    );
  }
  ctx.reporter.ok("First commit made.");
}

/**
 * Offers `gh repo create`. Declining is a supported ending: a local book is a
 * real book, and it can be pushed later.
 */
async function maybeCreateRemote(
  ctx: WizardContext,
  identity: BookIdentity,
  visibility: "public" | "private",
  ghReady: boolean,
): Promise<string | null> {
  // "Already on GitHub" is a claim about the world, so it is checked against
  // the world rather than read out of the journal. A planted journal must not
  // be able to make the wizard announce — and every later stage adopt — a
  // repository the author has no connection to.
  const recorded = ctx.journal.data.book?.repo;
  if (recorded !== undefined) {
    const confirmed = await resolveRepo(ctx);
    if (confirmed !== null) {
      ctx.reporter.info(`Already on GitHub: ${confirmed}`);
      return confirmed;
    }
    // The journal's claim did not survive (no readable `origin`); fall through
    // and offer to create the repository properly.
  }

  if (!ghReady) {
    ctx.reporter.warn(
      "Skipping the GitHub repository: the GitHub CLI is not signed in. Run `gh auth login`, then `create-authorbot book` again to add it.",
    );
    return null;
  }

  const wanted = await ctx.prompter.confirm({
    id: "book.createRemote",
    message: `Create a ${visibility} repository on GitHub for this book and push it?`,
    hint:
      visibility === "private"
        ? "Private means only you and people you invite can read it — including every draft."
        : "Public means anyone can read the repository, including every draft and every revision, from the first commit onward.",
    defaultValue: true,
  });
  if (!wanted) {
    ctx.reporter.info(
      "Left it local. When you want it on GitHub, run `create-authorbot book` again.",
    );
    return null;
  }

  const login = await ghLogin(ctx.actions);
  const owner = login ?? "";
  const fullName = owner.length > 0 ? `${owner}/${identity.slug}` : identity.slug;

  const result = await ctx.actions.run({
    purpose: "create the repository on GitHub and push the first commit",
    command: "gh",
    args: [
      "repo",
      "create",
      fullName,
      visibility === "private" ? "--private" : "--public",
      "--source",
      ".",
      "--remote",
      "origin",
      "--push",
      "--description",
      `${identity.title} — an Authorbot book`,
    ],
    cwd: ctx.directory,
    mutates: true,
    timeoutMs: 120_000,
  });

  if (result.code !== 0) {
    const message = (result.stderr || result.stdout).trim();
    if (/already exists/i.test(message)) {
      // A named collision is not a failure to recover from blindly: pushing
      // into someone's existing repository is exactly the destructive act the
      // contract forbids doing without being asked.
      throw new WizardError(
        `GitHub already has a repository called ${fullName}.`,
        `Pick a different short name (run \`create-authorbot book\` again and change the slug), or push into the existing repository yourself with \`git remote add origin\` and \`git push\`.`,
      );
    }
    throw new WizardError(
      `Could not create the GitHub repository:\n${message}`,
      `Check \`gh auth status\`, then run \`create-authorbot book\` again — the local book is already made and will not be recreated.`,
    );
  }

  await ctx.journal.update((data) => {
    if (data.book !== undefined) {
      data.book.repo = fullName;
    }
  }, nowIso(ctx));
  await ctx.actions.resource({
    kind: "github-repo",
    name: fullName,
    description: "The GitHub repository holding your book.",
    deleteWith: `gh repo delete ${fullName} --yes`,
  });
  await ctx.journal.update((data) => {
    if (data.book !== undefined) {
      data.book.repo = fullName;
    }
  }, nowIso(ctx));

  ctx.reporter.ok(`Pushed to https://github.com/${fullName}`);
  return fullName;
}
