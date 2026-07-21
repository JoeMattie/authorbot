/**
 * The workspace packages that go to npm, in dependency order (ADR-0022).
 *
 * The order is the publish order: a dependency reaches the registry before
 * anything that depends on it, so a consumer installing the moment a release
 * finishes never resolves a package whose dependency is not there yet.
 *
 * `packages/test-fixtures` is deliberately absent. It exists only for this
 * repository's own tests and is reached solely through devDependencies, which
 * are not installed by consumers.
 *
 * Adding a package here is the whole of "make it publishable" —
 * check-packaging, check-release-versions, and pack-release all read this
 * list, so there is one place to forget rather than three.
 */
export const PUBLISHABLE = [
  "packages/schemas",
  "packages/markdown",
  "packages/domain",
  "packages/rule-engine",
  "packages/database",
  "packages/repo-coordinator",
  "packages/git-github",
  "packages/publisher",
  "apps/cli",
  "apps/api",
  // The wizard. It was built after this list was written and so missed the
  // first release — `npx @authorbot/create`, the documented way an author
  // starts, resolved to nothing.
  "apps/create",
];
