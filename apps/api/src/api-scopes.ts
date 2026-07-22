/**
 * API authorization compatibility during the Phase 11 granular-permissions
 * expansion.
 *
 * Existing editorial routes still name the legacy scope vocabulary in this
 * release increment. Auth therefore keeps a conservative effective `scopes`
 * projection alongside the canonical capability projection. New route work
 * consumes `effectiveCapabilities`; old routes keep their exact behaviour
 * until they are converted one by one.
 */
import { z } from "zod";
import {
  editorialCapabilitiesSchema,
  effectiveEditorialCapabilities,
  legacyEffectiveActions,
  legacyScopeShadow,
  MAX_TOKEN_NAME_LENGTH,
  parseEditorialCapabilities,
  parseLegacyScopes,
  ROLE_SCOPES,
  SCOPES,
  roleEditorialCapabilities,
  roleScopes,
  type EditorialCapability,
  type LegacyEffectiveAction,
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
 * The complete authorization picture returned by `/v1/me` and token metadata.
 * `scopes` remains internal compatibility data and is serialized separately on
 * the legacy response field; the other arrays are canonical Phase 11 values.
 */
export interface CapabilityProjection {
  capabilityMode: "human" | "legacy" | "canonical";
  grantedCapabilities: EditorialCapability[];
  roleCapabilityCeiling: EditorialCapability[];
  effectiveCapabilities: EditorialCapability[];
  legacyEffectiveActions: LegacyEffectiveAction[];
  scopes: ApiScope[];
}

/** Public canonical fields shared by `/v1/me` and token metadata responses. */
export function capabilityProjectionJson(
  projection: CapabilityProjection,
): Omit<CapabilityProjection, "scopes"> {
  return {
    capabilityMode: projection.capabilityMode,
    grantedCapabilities: projection.grantedCapabilities,
    roleCapabilityCeiling: projection.roleCapabilityCeiling,
    effectiveCapabilities: projection.effectiveCapabilities,
    legacyEffectiveActions: projection.legacyEffectiveActions,
  };
}

/** Canonical role-derived projection for a human session. */
export function sessionCapabilityProjection(role: Role | null): CapabilityProjection {
  const ceiling = role === null ? [] : [...roleEditorialCapabilities(role)];
  return {
    capabilityMode: "human",
    grantedCapabilities: [...ceiling],
    roleCapabilityCeiling: [...ceiling],
    effectiveCapabilities: [...ceiling],
    legacyEffectiveActions: [],
    scopes: role === null ? [] : [...apiRoleScopes(role)],
  };
}

/**
 * Dual-read projection for an agent-token row.
 *
 * Canonical rows never trust the stored legacy shadow for authorization: it is
 * recomputed from the parsed canonical grant. A malformed or unknown
 * canonical set therefore produces no canonical authority and no compatibility
 * scope, even if the shadow column was corrupted or written too broadly.
 */
export function tokenCapabilityProjection(
  token: {
    scopes: readonly string[];
    capabilitiesV2?: readonly string[] | null;
    capabilityMode?: "legacy" | "canonical";
  },
  role: Role | null,
): CapabilityProjection {
  const capabilityMode = token.capabilityMode ?? "legacy";
  const ceiling = role === null ? [] : [...roleEditorialCapabilities(role)];

  if (capabilityMode === "canonical") {
    const parsed = parseEditorialCapabilities(token.capabilitiesV2 ?? null);
    const granted = parsed.ok ? parsed.capabilities : [];
    const safeShadow = parsed.ok ? legacyScopeShadow(granted) : [];
    return {
      capabilityMode,
      grantedCapabilities: [...granted],
      roleCapabilityCeiling: ceiling,
      effectiveCapabilities:
        role === null ? [] : effectiveEditorialCapabilities(granted, role),
      legacyEffectiveActions: [],
      scopes: role === null ? [] : apiEffectiveScopes(safeShadow, role),
    };
  }

  const parsed = parseLegacyScopes(token.scopes);
  const granted = parsed.ok ? parsed.capabilities : [];
  return {
    capabilityMode,
    grantedCapabilities: [...granted],
    roleCapabilityCeiling: ceiling,
    effectiveCapabilities:
      role === null ? [] : effectiveEditorialCapabilities(granted, role),
    legacyEffectiveActions:
      parsed.ok && role !== null ? legacyEffectiveActions(parsed.scopes, role) : [],
    // Preserve legacy route behaviour for known old scopes. Unknown names are
    // ignored by apiEffectiveScopes and never enter the canonical projection.
    scopes: parsed.ok && role !== null ? apiEffectiveScopes(token.scopes, role) : [],
  };
}

const tokenNameSchema = z
  .string()
  .min(1, "name must not be empty")
  .max(MAX_TOKEN_NAME_LENGTH, `name must be at most ${MAX_TOKEN_NAME_LENGTH} characters`);

const expiresInDaysSchema = z.number().int().min(1).max(90).default(30);

const canonicalMintSchema = z.strictObject({
  name: tokenNameSchema,
  capabilities: editorialCapabilitiesSchema,
  expiresInDays: expiresInDaysSchema,
}).transform((command) => ({ ...command, authorizationMode: "canonical" as const }));

/**
 * Deprecated request compatibility. It deliberately creates a legacy row so
 * callers using umbrella scopes retain their exact current route behaviour
 * until those routes move to canonical guards.
 */
const legacyMintSchema = z.strictObject({
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
  expiresInDays: expiresInDaysSchema,
}).transform((command) => ({ ...command, authorizationMode: "legacy" as const }));

/** New canonical mint body plus the temporary legacy request alias. */
export const mintAgentTokenApiCommandSchema = z.union([
  canonicalMintSchema,
  legacyMintSchema,
]);
export type MintAgentTokenApiCommand = z.infer<typeof mintAgentTokenApiCommandSchema>;

/** Complete-set replacement used by the session-only token update route. */
export const replaceAgentTokenCapabilitiesApiCommandSchema = z.strictObject({
  capabilities: editorialCapabilitiesSchema,
});
