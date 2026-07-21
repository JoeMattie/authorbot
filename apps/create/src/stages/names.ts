/**
 * Stage identity, kept in its own module so the journal and the CLI can both
 * import it without pulling in stage implementations (and their ports).
 *
 * Order is the default flow (Phase 6 contract §3): each stage is independently
 * runnable as `create-authorbot <stage>`, and the default run walks this list,
 * stopping wherever the author chooses.
 */
export const STAGE_NAMES = [
  "doctor",
  "book",
  "publish",
  "collaborate",
  "agent",
  "upgrade",
  "unpublish",
  "teardown",
] as const;

export type StageName = (typeof STAGE_NAMES)[number];

export function isStageName(value: string): value is StageName {
  return (STAGE_NAMES as readonly string[]).includes(value);
}

/**
 * One line each, in author-facing language (contract §2.7). These are the
 * strings the help output and the stage picker show, and a documentation test
 * asserts they agree with the manual getting-started guide's headings.
 */
export const STAGE_SUMMARIES: Record<StageName, string> = {
  doctor: "Check that the tools this needs are installed and signed in.",
  book: "Create the book: its title, its web address, and its repository.",
  publish: "Put the reading site online and wait until it actually loads.",
  collaborate: "Turn on sign-in, comments, and the work queue (optional).",
  agent: "Invite a writing agent with a scoped token (optional).",
  upgrade: "Move an existing book to a newer version of Authorbot.",
  unpublish: "Take the site and database down, keeping the repository.",
  teardown: "Delete everything this created, including the repository.",
};

/**
 * Stages that destroy things, and so are never walked by any flow - only ever
 * run because someone typed their name. Keeping them in `STAGE_NAMES` is what
 * makes `create-authorbot teardown` resolve at all; keeping them out of every
 * flow is what stops a bare `create-authorbot` from walking into one.
 */
export const DESTRUCTIVE_STAGES: readonly StageName[] = ["unpublish", "teardown"];

/**
 * Stages that a fresh `create-authorbot` run offers to continue into rather
 * than running unasked. `doctor` and `book` are the irreducible path to a
 * book; everything after is a choice the author makes with the previous
 * stage's result in front of them.
 */
export const OPTIONAL_STAGES: readonly StageName[] = ["publish", "collaborate", "agent", "upgrade"];
