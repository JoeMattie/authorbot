/**
 * How this wizard was invoked, as the author would have to type it again.
 *
 * `npx` unpacks into a cache directory and puts nothing on PATH, so every
 * resume hint reading `create-authorbot publish` was a command not found for
 * anyone who followed the documented `npx @authorbot/create` — and those hints
 * appear precisely when something has already failed, which is the worst
 * moment to hand someone an instruction that does not work.
 *
 * This lives in its own module rather than in `bin.ts` because `bin.ts` is the
 * entry point: importing it *runs the wizard*. A test that reached in for this
 * function got a process waiting on stdin instead of an assertion.
 */

/** The name the wizard's own messages use for itself. */
export const BINARY_NAME = "create-authorbot";

/**
 * The npx cache is the only case that needs detecting: a global or local
 * install does put the binary on PATH, and then its own name is the shortest
 * true answer.
 */
export function invocationCommand(argv1: string | undefined): string {
  const path = argv1 ?? "";
  return path.includes("/_npx/") || path.includes("\\_npx\\")
    ? "npx @authorbot/create"
    : BINARY_NAME;
}
