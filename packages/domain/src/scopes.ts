import { z } from "zod";
import { ALLOWED, denied, type Decision } from "./decision.js";

/**
 * Known scopes and role -> scope-bundle mapping (Phase 2 contract section 3,
 * design section 19.3). `votes:write` (design section 19.2) is deferred with
 * voting to Phase 3 and is intentionally not a known scope in this phase.
 */

export const SCOPES = [
  "chapters:read",
  "annotations:read",
  "annotations:write",
  "work:read",
  "work:claim",
  "submissions:write",
  "tokens:manage",
  "members:manage",
] as const;
export type Scope = (typeof SCOPES)[number];
export const scopeSchema = z.enum(SCOPES);

export const ROLES = ["reader", "contributor", "editor", "maintainer"] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);

const READER_SCOPES = ["chapters:read", "annotations:read"] as const;
const CONTRIBUTOR_SCOPES = [...READER_SCOPES, "annotations:write"] as const;
const EDITOR_SCOPES = [
  ...CONTRIBUTOR_SCOPES,
  "work:read",
  "work:claim",
  "submissions:write",
] as const;
const MAINTAINER_SCOPES = [
  ...EDITOR_SCOPES,
  "tokens:manage",
  "members:manage",
] as const;

/** Role -> scope bundle (contract section 3). Bundles are cumulative. */
export const ROLE_SCOPES: Readonly<Record<Role, readonly Scope[]>> = Object.freeze({
  reader: READER_SCOPES,
  contributor: CONTRIBUTOR_SCOPES,
  editor: EDITOR_SCOPES,
  maintainer: MAINTAINER_SCOPES,
});

/** The scope bundle a membership role grants (human sessions use this directly). */
export function roleScopes(role: Role): readonly Scope[] {
  return ROLE_SCOPES[role];
}

/**
 * An agent's effective scopes = token.scopes ∩ its membership role bundle
 * (contract section 3). Result is deduplicated and in canonical SCOPES order.
 */
export function effectiveScopes(
  tokenScopes: readonly Scope[],
  role: Role,
): Scope[] {
  const token = new Set(tokenScopes);
  const bundle = new Set(ROLE_SCOPES[role]);
  return SCOPES.filter((scope) => token.has(scope) && bundle.has(scope));
}

export type ScopeDenialReason = "missing-scope";

/** Require a single scope among the actor's effective scopes. */
export function requireScope(
  actorScopes: readonly Scope[],
  required: Scope,
): Decision<ScopeDenialReason> {
  if (actorScopes.includes(required)) {
    return ALLOWED;
  }
  return denied("missing-scope", `actor lacks required scope "${required}"`);
}

/** Require every listed scope (denies on the first missing one, in SCOPES order). */
export function requireScopes(
  actorScopes: readonly Scope[],
  required: readonly Scope[],
): Decision<ScopeDenialReason> {
  const have = new Set(actorScopes);
  for (const scope of SCOPES) {
    if (required.includes(scope) && !have.has(scope)) {
      return denied("missing-scope", `actor lacks required scope "${scope}"`);
    }
  }
  return ALLOWED;
}
