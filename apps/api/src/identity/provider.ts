/**
 * IdentityProvider interface (Phase 2 contract §3, ADR 0015). Two
 * implementations: `dev` (POST /v1/dev/login, mounted only when
 * AUTH_MODE=dev - containment by construction: the route does not exist in
 * github mode) and `github` (OAuth web flow, exercised only when configured).
 */

/** Resolved external identity of a logging-in human. */
export interface ResolvedIdentity {
  /** Canonical actor ref, e.g. `github:octocat` (Phase 0 contract §2). */
  externalIdentity: string;
  displayName: string;
}

export interface DevIdentityProvider {
  readonly mode: "dev";
}

export interface GitHubIdentityProvider {
  readonly mode: "github";
  /** Build the GitHub authorize redirect URL for a state value. */
  authorizeUrl(state: string): string;
  /** Exchange an OAuth code for the user's identity. Never logs tokens. */
  resolveCallback(code: string): Promise<ResolvedIdentity>;
}

export type IdentityProvider = DevIdentityProvider | GitHubIdentityProvider;

export function createDevIdentityProvider(): DevIdentityProvider {
  return { mode: "dev" };
}
