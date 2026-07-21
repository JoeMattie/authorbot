/**
 * Helpers shared by the stages that operate on an existing book.
 *
 * These read `book.yml` rather than trusting the journal, because the journal
 * is an accelerator and the repository is the truth: an author who renamed
 * their book by editing `book.yml` (or the Settings view) should not have the
 * wizard act on a stale copy of the title.
 */
import path from "node:path";
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import { AbortedError, WizardError } from "../errors.js";
import type { WizardContext } from "../context.js";
import { nowIso } from "../context.js";

export interface BookFacts {
  readonly title: string;
  readonly slug: string;
  readonly id: string;
  readonly defaultBranch: string;
  /** `owner/repo` when the book has a GitHub remote. */
  readonly repo: string | null;
  /** Current `publication.api_url`, if set. */
  readonly apiUrl: string | null;
  /**
   * `publication.show_public_annotations`, which the Worker needs mirrored as
   * PUBLIC_ANNOTATIONS or it refuses every anonymous read. Defaults to the
   * scaffold's own default (true) when the key is absent.
   */
  readonly showPublicAnnotations: boolean;
}

export async function requireBookDirectory(ctx: WizardContext): Promise<void> {
  const bookYml = path.join(ctx.directory, "book.yml");
  if (await ctx.fs.exists(bookYml)) {
    return;
  }
  // A dry run of the whole flow reaches `publish` with no book on disk,
  // because `book` wrote nothing — that is the point of a dry run. The plan
  // must still cover every later stage (§2.4: "prints the full plan"), so the
  // precondition is satisfied by the book the same run has planned to create.
  if (ctx.actions.dryRun && ctx.journal.data.book?.slug !== undefined) {
    return;
  }
  throw new WizardError(
    `There is no book in ${ctx.directory} — no book.yml was found.`,
    "Run `create-authorbot book` first to create one, or re-run this from inside your book's directory (or pass its path).",
  );
}

export async function readBookIdentity(ctx: WizardContext): Promise<BookFacts> {
  const bookYml = path.join(ctx.directory, "book.yml");
  if (!(await ctx.fs.exists(bookYml))) {
    // Only reachable in a dry run, guarded by `requireBookDirectory` above.
    const planned = ctx.journal.data.book;
    return {
      title: planned?.title ?? "Untitled",
      slug: planned?.slug ?? "book",
      id: planned?.id ?? "",
      defaultBranch: planned?.defaultBranch ?? "main",
      repo: planned?.repo ?? null,
      apiUrl: null,
      showPublicAnnotations: true,
    };
  }
  const text = await ctx.fs.readFile(bookYml);
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new WizardError(
      `Could not read ${bookYml}: ${error instanceof Error ? error.message : String(error)}`,
      "Fix the YAML in book.yml (or restore it from Git), then run this again.",
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new WizardError(
      `${bookYml} does not look like a book configuration.`,
      "Restore it from Git, or run `create-authorbot book` in a fresh directory.",
    );
  }
  const record = parsed as Record<string, unknown>;
  const repository = record["repository"];
  const publication = record["publication"];
  const publicationRecord =
    typeof publication === "object" && publication !== null
      ? (publication as Record<string, unknown>)
      : undefined;
  const apiUrl = publicationRecord?.["api_url"];
  const showPublic = publicationRecord?.["show_public_annotations"];

  const facts: BookFacts = {
    title: typeof record["title"] === "string" ? record["title"] : "Untitled",
    slug: typeof record["slug"] === "string" ? record["slug"] : "book",
    id: typeof record["id"] === "string" ? record["id"] : "",
    defaultBranch:
      typeof repository === "object" &&
      repository !== null &&
      typeof (repository as Record<string, unknown>)["default_branch"] === "string"
        ? ((repository as Record<string, unknown>)["default_branch"] as string)
        : "main",
    repo: await resolveRepo(ctx),
    apiUrl: typeof apiUrl === "string" ? apiUrl : null,
    showPublicAnnotations: typeof showPublic === "boolean" ? showPublic : true,
  };
  return facts;
}

/**
 * Which GitHub repository this book actually lives in.
 *
 * **The remote is asked first, and it wins.** The journal used to outrank it,
 * which meant the true `origin` was never consulted at all — and `book.repo`
 * decides which repository receives the author's Cloudflare API token
 * (`gh secret set CLOUDFLARE_API_TOKEN --repo <repo>`). A `.authorbot-setup.json`
 * committed to a shared or forked book could therefore redirect that token to
 * a repository the author has never heard of, and nothing would contradict it.
 * The doc comment at the top of this file already said the repository is the
 * truth; this makes that true of the repository's identity too, not only its
 * `book.yml`.
 *
 * A disagreement is not resolved silently in either direction: it is exactly
 * the situation an author must look at, so it stops and asks.
 */
export async function resolveRepo(ctx: WizardContext): Promise<string | null> {
  const actual = await gitRemoteRepo(ctx);
  const recorded = ctx.journal.data.book?.repo;

  if (actual === null) {
    if (recorded === undefined) {
      return null;
    }
    // A dry run legitimately reaches here with nothing on disk: the `book`
    // stage planned the repository this same run, and later stages must be
    // able to plan against it (§2.4 — the plan covers every stage).
    if (ctx.actions.dryRun) {
      return recorded;
    }
    // Otherwise the journal names a repository the repository itself does not
    // corroborate. Proceeding would mean acting on an unverifiable claim, so
    // the claim is dropped and the caller sees "no repository" — which every
    // caller already handles, and which changes nothing outside this machine.
    ctx.reporter.warn(
      `The setup journal says this book lives at ${recorded}, but no \`origin\` remote could be read from ${ctx.directory}, so that claim is being ignored.`,
    );
    ctx.reporter.info(
      "If that is your repository, run `git remote add origin <url>` so the repository itself says so, then run this again.",
    );
    return null;
  }

  if (recorded !== undefined && recorded !== actual) {
    ctx.reporter.blank();
    ctx.reporter.warn(
      `This book's setup journal names a different GitHub repository than the one it is actually connected to.`,
    );
    ctx.reporter.info(`The journal (.authorbot-setup.json) says: ${recorded}`);
    ctx.reporter.info(`Your \`origin\` remote says:              ${actual}`);
    ctx.reporter.info(
      "Repository secrets, and the address collaboration commits to, follow whichever one is used — so this is worth a look. If you did not put that name in the journal yourself, the journal came from somewhere else and should not be trusted.",
    );
    const proceed = await ctx.prompter.confirm({
      id: "book.repoConflict",
      message: `Continue using ${actual}, the repository this book is actually connected to?`,
      hint: "Answering no stops without changing anything, so you can look at .authorbot-setup.json first.",
      defaultValue: false,
      destructive: true,
    });
    if (!proceed) {
      throw new AbortedError(
        "the setup journal and the repository disagree about where this book lives",
      );
    }
    // Agreed: make the journal match the repository rather than leaving the
    // disagreement to be re-asked on every later stage of the same run.
    await ctx.journal.update((data) => {
      if (data.book !== undefined) {
        data.book.repo = actual;
      }
    }, nowIso(ctx));
  }

  return actual;
}

/**
 * Which address this book is actually published at.
 *
 * `siteUrl` decides where readers' GitHub sign-in codes are redirected
 * (`GITHUB_REDIRECT_URI`), where the app's webhooks are delivered, and where a
 * maintainer bearer token is sent when minting an agent credential. Like
 * `book.repo`, it is read from a file that lives in the book repository — so a
 * `.authorbot-setup.json` committed to a shared or forked book could name a
 * host the author has never seen, and the wizard would wire three secrets to
 * it. `parseJournal` can only check the value is a well-formed `https:` URL;
 * `https://evil.example` passes that test perfectly.
 *
 * The corroboration available is the Worker name: a `workers.dev` address is
 * derived from a name this wizard chose, so `<workerName>.<subdomain>.workers.dev`
 * verifies itself. A custom domain cannot be derived from anything local, so it
 * is not silently trusted — it is shown, with what it controls spelled out, and
 * the author confirms. That mirrors `resolveRepo`: a claim the machine cannot
 * corroborate is a claim the author must look at.
 */
export async function resolveSiteUrl(
  ctx: WizardContext,
  workerName: string | undefined,
): Promise<string | undefined> {
  const recorded = ctx.journal.data.publish?.siteUrl;
  if (recorded === undefined) {
    return undefined;
  }

  let host: string;
  try {
    host = new URL(recorded).host;
  } catch {
    return undefined;
  }

  // Self-corroborating: the host is built from the Worker name this wizard
  // deployed, so it cannot name a third party.
  if (workerName !== undefined && new RegExp(`^${escapeForRegExp(workerName)}\\.[^.]+\\.workers\\.dev$`).test(host)) {
    return recorded;
  }

  // A dry run has nothing deployed to compare against; planning must still
  // reach the later stages (§2.4).
  if (ctx.actions.dryRun) {
    return recorded;
  }

  ctx.reporter.blank();
  ctx.reporter.warn("This book's address comes from its setup journal, and nothing local corroborates it.");
  ctx.reporter.info(`.authorbot-setup.json says your book is published at: ${recorded}`);
  ctx.reporter.info(
    "That address will receive your readers' GitHub sign-in codes, this book's webhooks, and — if you mint an agent token — a maintainer credential.",
  );
  ctx.reporter.info(
    "If that is your own custom domain, this is expected. If you did not put it there yourself, stop and look at .authorbot-setup.json.",
  );
  const proceed = await ctx.prompter.confirm({
    id: "publish.siteUrlUncorroborated",
    message: `Continue with ${recorded} as this book's address?`,
    hint: "Answering no stops without changing anything.",
    defaultValue: false,
    destructive: true,
  });
  if (!proceed) {
    throw new AbortedError("the book's address could not be corroborated");
  }
  return recorded;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Derives `owner/repo` from the `origin` remote. Both SSH and HTTPS forms are
 * accepted because both are normal, and the wizard should not care which one
 * the author's `gh` happened to configure.
 */
export async function gitRemoteRepo(ctx: WizardContext): Promise<string | null> {
  const result = await ctx.actions.run({
    purpose: "find out which GitHub repository this book lives in",
    command: "git",
    args: ["remote", "get-url", "origin"],
    cwd: ctx.directory,
    mutates: false,
  });
  if (result.code !== 0) {
    return null;
  }
  const url = result.stdout.trim();
  const match =
    /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url) ?? /^([^/]+)\/([^/]+)$/.exec(url);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  return `${match[1]}/${match[2]}`;
}

/**
 * Sets `publication.api_url` in `book.yml`, preserving comments and every
 * other field.
 *
 * `parseDocument` (rather than parse-and-restringify) is what keeps the
 * author's own comments and formatting: `book.yml` is a file a human reads and
 * edits, and a wizard that reflowed it on every run would make its diffs
 * unreadable.
 */
export async function setApiUrl(ctx: WizardContext, apiUrl: string): Promise<string> {
  const bookYml = path.join(ctx.directory, "book.yml");
  const text = await ctx.fs.readFile(bookYml);
  const doc = parseDocument(text);
  const publication = doc.get("publication");
  if (publication === undefined || publication === null) {
    doc.set("publication", { api_url: apiUrl });
  } else {
    doc.setIn(["publication", "api_url"], apiUrl);
  }
  return String(doc);
}

/** Re-exported so stages need only one YAML import site. */
export { stringifyYaml };

/**
 * Commits the files a stage generated, and optionally pushes them.
 *
 * Every stage that writes configuration has to do this, and until now each one
 * either did it privately or told the author to. `collaborate` did the latter
 * — "commit and push the changed book.yml and wrangler.jsonc when you are
 * ready" — which is a footnote at the end of a long run, and the consequence
 * of missing it is that the API never projects the book and the settings page
 * reports that it cannot read its own configuration. The author is then
 * looking at a broken page with no reason to connect it to a line they
 * scrolled past.
 *
 * Pushing matters for exactly that reason: the projection reads GitHub, not
 * the working tree. A commit that stays local leaves the deployment describing
 * a book it cannot see.
 *
 * Restricted to the named files. An author's work in progress is theirs, and
 * sweeping it into a commit they did not ask for is the kind of surprise the
 * wizard promises not to spring.
 */
export async function commitGenerated(
  ctx: WizardContext,
  options: {
    readonly files: readonly string[];
    readonly message: string;
    readonly push: boolean;
    /** Said when it worked, in the author's terms. */
    readonly done: string;
    /** Said when it did not, naming what they must do themselves. */
    readonly failed: string;
  },
): Promise<void> {
  const files = [...options.files];

  if (ctx.actions.dryRun) {
    ctx.actions.note(
      `run: git commit ${files.join(" ")}${options.push ? " && git push" : ""}`,
      options.done,
    );
    return;
  }

  const inside = await ctx.actions.run({
    purpose: "check this book is a git repository",
    command: "git",
    args: ["rev-parse", "--is-inside-work-tree"],
    cwd: ctx.directory,
    mutates: false,
  });
  if (inside.code !== 0) {
    return;
  }

  await ctx.actions.run({
    purpose: "stage the files this stage wrote",
    command: "git",
    args: ["add", "--", ...files],
    cwd: ctx.directory,
    mutates: true,
  });

  const staged = await ctx.actions.run({
    purpose: "see whether anything actually changed",
    command: "git",
    args: ["diff", "--cached", "--quiet", "--", ...files],
    cwd: ctx.directory,
    mutates: false,
  });
  if (staged.code === 0) {
    return;
  }

  const commit = await ctx.actions.run({
    purpose: "commit the files this stage wrote",
    command: "git",
    args: ["commit", "-m", options.message, "--", ...files],
    cwd: ctx.directory,
    mutates: true,
  });
  if (commit.code !== 0) {
    ctx.reporter.warn(options.failed);
    return;
  }

  if (!options.push) {
    ctx.reporter.ok(options.done);
    return;
  }

  const push = await ctx.actions.run({
    purpose: "push so the deployment can read the book",
    command: "git",
    args: ["push"],
    cwd: ctx.directory,
    mutates: true,
    timeoutMs: 120_000,
  });
  if (push.code === 0) {
    ctx.reporter.ok(options.done);
  } else {
    // Committed but not pushed is a real state and worth naming precisely: the
    // work is safe, and the deployment still cannot see it.
    ctx.reporter.warn(
      `Committed, but the push failed: ${(push.stderr || push.stdout).trim().split("\n")[0] ?? "unknown error"}`,
    );
    ctx.reporter.info("Run `git push` when you can — until then your site cannot read this change.");
  }
}
