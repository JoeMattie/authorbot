/**
 * Constants every GitHub caller in this package shares.
 *
 * They live in their own module rather than in `index.ts` so that `app-auth`,
 * `reader` and `writer` can import them without importing the barrel - a
 * barrel import from a module the barrel re-exports is a cycle, and under
 * `verbatimModuleSyntax` the value exports make it a real one at runtime.
 */
export const GITHUB_API_ORIGIN = "https://api.github.com";

/** `Accept` header GitHub asks REST clients to send. */
export const GITHUB_ACCEPT = "application/vnd.github+json";

/** `X-GitHub-Api-Version` pinned for every request this package makes. */
export const GITHUB_API_VERSION = "2022-11-28";

/** `User-Agent` GitHub requires on every request. */
export const GITHUB_USER_AGENT = "authorbot/0.1";
