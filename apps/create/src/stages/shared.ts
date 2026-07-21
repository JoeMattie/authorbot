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
import { WizardError } from "../errors.js";
import type { WizardContext } from "../context.js";

export interface BookFacts {
  readonly title: string;
  readonly slug: string;
  readonly id: string;
  readonly defaultBranch: string;
  /** `owner/repo` when the book has a GitHub remote. */
  readonly repo: string | null;
  /** Current `publication.api_url`, if set. */
  readonly apiUrl: string | null;
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
  const apiUrl =
    typeof publication === "object" && publication !== null
      ? (publication as Record<string, unknown>)["api_url"]
      : undefined;

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
    repo: ctx.journal.data.book?.repo ?? (await gitRemoteRepo(ctx)),
    apiUrl: typeof apiUrl === "string" ? apiUrl : null,
  };
  return facts;
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
