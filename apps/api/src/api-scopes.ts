/**
 * Phase 3 scope extension (Phase 3 contract §2): `votes:write` joins the
 * scope vocabulary and the **contributor** role bundle (and everything above
 * it, bundles being cumulative).
 *
 * `@authorbot/domain`'s scope module still pins the Phase 2 vocabulary and is
 * outside this workstream's assigned paths, so the extension lives here in
 * the API layer: the auth middleware computes effective scopes with these
 * functions instead of the domain ones. The domain bundles remain the single
 * source for everything that is not `votes:write`.
 */
import { z } from "zod";
import {
  MAX_TOKEN_NAME_LENGTH,
  ROLE_SCOPES,
  SCOPES,
  roleScopes,
  type Role,
  type Scope,
} from "@authorbot/domain";

export const VOTES_WRITE = "votes:write" as const;

/** Full Phase 3 API scope vocabulary (domain SCOPES + votes:write). */
export const API_SCOPES = [...SCOPES, VOTES_WRITE] as const;
export type ApiScope = Scope | typeof VOTES_WRITE;
export const apiScopeSchema = z.enum(API_SCOPES as unknown as [string, ...string[]]);

/**
 * Role → scope bundle with the Phase 3 addition: contributor and above gain
 * `votes:write` (contract §2: "added to the contributor role bundle").
 */
export function apiRoleScopes(role: Role): readonly ApiScope[] {
  if (role === "reader") {
    return ROLE_SCOPES[role];
  }
  return [...roleScopes(role), VOTES_WRITE];
}

/**
 * An agent's effective scopes = token.scopes ∩ its membership role bundle
 * (Phase 2 contract §3), over the extended vocabulary. Agents vote only when
 * their token names `votes:write` AND their membership role grants it
 * (design §11.2: "agents cannot vote unless their project membership grants
 * it" - agent memberships are pinned to `editor`, whose bundle includes it).
 */
export function apiEffectiveScopes(
  tokenScopes: readonly string[],
  role: Role,
): ApiScope[] {
  const token = new Set(tokenScopes);
  const bundle = new Set<string>(apiRoleScopes(role));
  return API_SCOPES.filter((scope) => token.has(scope) && bundle.has(scope));
}

/**
 * Phase 3 mint command: identical to the domain
 * `mintAgentTokenCommandSchema` but admitting `votes:write` in `scopes`
 * (mirrored here because the domain schema pins the Phase 2 enum).
 */
export const mintAgentTokenApiCommandSchema = z.strictObject({
  name: z
    .string()
    .min(1, "name must not be empty")
    .max(MAX_TOKEN_NAME_LENGTH, `name must be at most ${MAX_TOKEN_NAME_LENGTH} characters`),
  scopes: z
    .array(apiScopeSchema)
    .min(1, "at least one scope is required")
    .refine(
      (scopes) => new Set(scopes).size === scopes.length,
      "scopes must not contain duplicates",
    ),
  expiresInDays: z.number().int().min(1).max(90).default(30),
});
export type MintAgentTokenApiCommand = z.infer<typeof mintAgentTokenApiCommandSchema>;
