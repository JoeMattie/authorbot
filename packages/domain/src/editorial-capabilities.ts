import { z } from "zod";
import { ALLOWED, denied, type Decision } from "./decision.js";
import type { Role } from "./scopes.js";

/**
 * Canonical Phase 11 editorial authority for agent tokens.
 *
 * This vocabulary is deliberately exact. A capability added by a later
 * release is absent from this tuple and therefore fails parsing instead of
 * inheriting authority from a broad read or write grant.
 */
export const EDITORIAL_CAPABILITIES = [
  "chapters:read",
  "comments:read",
  "suggestions:read",
  "comments:write",
  "suggestions:write",
  "replies:write",
  "comments:vote",
  "suggestions:vote",
  "feedback:withdraw-own",
  "feedback:moderate",
  "work:read",
  "work:promote",
  "work:claim",
  "work:submit",
  "work:cancel",
  "chapters:write",
  "chapters:publish",
] as const;
export type EditorialCapability = (typeof EDITORIAL_CAPABILITIES)[number];

export const editorialCapabilitySchema = z.enum(EDITORIAL_CAPABILITIES);

/**
 * A complete canonical grant set as stored on a canonical-mode token.
 *
 * Empty is valid and means that the token has no editorial authority. Unknown
 * and duplicate names invalidate the complete set rather than being partially
 * accepted. The transform gives every valid result one deterministic order.
 */
export const editorialCapabilitiesSchema = z
  .array(editorialCapabilitySchema)
  .superRefine((capabilities, ctx) => {
    const seen = new Set<EditorialCapability>();
    capabilities.forEach((capability, index) => {
      if (seen.has(capability)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate capability "${capability}"`,
          path: [index],
        });
      }
      seen.add(capability);
    });
  })
  .transform((capabilities) => {
    const granted = new Set(capabilities);
    return EDITORIAL_CAPABILITIES.filter((capability) => granted.has(capability));
  });

export type EditorialCapabilityParseFailureReason =
  | "invalid-capability-set"
  | "invalid-json";

export type EditorialCapabilityParseResult =
  | {
      readonly ok: true;
      readonly capabilities: EditorialCapability[];
    }
  | {
      readonly ok: false;
      readonly capabilities: readonly [];
      readonly reason: EditorialCapabilityParseFailureReason;
    };

const invalidCapabilitySet = (
  reason: EditorialCapabilityParseFailureReason,
): EditorialCapabilityParseResult => ({
  ok: false,
  capabilities: [],
  reason,
});

/** Parse a decoded canonical capability value, denying every grant on error. */
export function parseEditorialCapabilities(input: unknown): EditorialCapabilityParseResult {
  const parsed = editorialCapabilitiesSchema.safeParse(input);
  return parsed.success
    ? { ok: true, capabilities: parsed.data }
    : invalidCapabilitySet("invalid-capability-set");
}

/** Parse the JSON stored in `capabilities_v2`, denying every grant on error. */
export function parseStoredEditorialCapabilities(
  input: string | null,
): EditorialCapabilityParseResult {
  if (input === null) {
    return invalidCapabilitySet("invalid-capability-set");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(input) as unknown;
  } catch {
    return invalidCapabilitySet("invalid-json");
  }
  return parseEditorialCapabilities(decoded);
}

const READER_CAPABILITIES = [
  "chapters:read",
  "comments:read",
  "suggestions:read",
] as const satisfies readonly EditorialCapability[];

const CONTRIBUTOR_CAPABILITIES = [
  ...READER_CAPABILITIES,
  "comments:write",
  "suggestions:write",
  "replies:write",
  "comments:vote",
  "suggestions:vote",
  "feedback:withdraw-own",
] as const satisfies readonly EditorialCapability[];

const EDITOR_CAPABILITIES = [
  ...CONTRIBUTOR_CAPABILITIES,
  "work:read",
  "work:claim",
  "work:submit",
  "chapters:write",
] as const satisfies readonly EditorialCapability[];

const MAINTAINER_CAPABILITIES = EDITORIAL_CAPABILITIES;

/**
 * Maximum canonical authority admitted by each current project role.
 * Token grants and this ceiling are independent; effective authority is their
 * intersection.
 */
export const ROLE_EDITORIAL_CAPABILITIES: Readonly<
  Record<Role, readonly EditorialCapability[]>
> = Object.freeze({
  reader: READER_CAPABILITIES,
  contributor: CONTRIBUTOR_CAPABILITIES,
  editor: EDITOR_CAPABILITIES,
  maintainer: MAINTAINER_CAPABILITIES,
});

export function roleEditorialCapabilities(role: Role): readonly EditorialCapability[] {
  return ROLE_EDITORIAL_CAPABILITIES[role];
}

/** Token grants intersected with the actor's current role, in canonical order. */
export function effectiveEditorialCapabilities(
  grantedCapabilities: readonly EditorialCapability[],
  role: Role,
): EditorialCapability[] {
  const granted = new Set(grantedCapabilities);
  const ceiling = new Set(ROLE_EDITORIAL_CAPABILITIES[role]);
  return EDITORIAL_CAPABILITIES.filter(
    (capability) => granted.has(capability) && ceiling.has(capability),
  );
}

export type EditorialCapabilityDenialReason = "missing-capability" | "role-ceiling";

/** Enforce the independent exact-grant and current-role checks. */
export function authorizeEditorialCapability(
  grantedCapabilities: readonly EditorialCapability[],
  role: Role,
  required: EditorialCapability,
): Decision<EditorialCapabilityDenialReason> {
  if (!grantedCapabilities.includes(required)) {
    return denied(
      "missing-capability",
      `token lacks required editorial capability "${required}"`,
    );
  }
  if (!ROLE_EDITORIAL_CAPABILITIES[role].includes(required)) {
    return denied(
      "role-ceiling",
      `project role "${role}" does not admit editorial capability "${required}"`,
    );
  }
  return ALLOWED;
}

/** Legacy names that exercised editorial authority before canonical mode. */
export const LEGACY_EDITORIAL_SCOPES = [
  "chapters:read",
  "annotations:read",
  "annotations:write",
  "work:read",
  "work:claim",
  "submissions:write",
  "votes:write",
] as const;
export type LegacyEditorialScope = (typeof LEGACY_EDITORIAL_SCOPES)[number];

/** Known old control-plane names. They never translate to editorial authority. */
export const LEGACY_CONTROL_SCOPES = ["tokens:manage", "members:manage"] as const;
export type LegacyControlScope = (typeof LEGACY_CONTROL_SCOPES)[number];

export const LEGACY_AGENT_SCOPES = [
  "chapters:read",
  "annotations:read",
  "annotations:write",
  "work:read",
  "work:claim",
  "submissions:write",
  ...LEGACY_CONTROL_SCOPES,
  "votes:write",
] as const;
export type LegacyAgentScope = (typeof LEGACY_AGENT_SCOPES)[number];
export const legacyAgentScopeSchema = z.enum(LEGACY_AGENT_SCOPES);

const LEGACY_TRANSLATION: Readonly<
  Record<LegacyEditorialScope, readonly EditorialCapability[]>
> = Object.freeze({
  "chapters:read": ["chapters:read"],
  "annotations:read": ["comments:read", "suggestions:read"],
  "annotations:write": [
    "comments:write",
    "suggestions:write",
    "replies:write",
    "feedback:withdraw-own",
  ],
  "work:read": ["work:read"],
  "work:claim": ["work:claim"],
  "submissions:write": ["work:submit", "chapters:write", "chapters:publish"],
  "votes:write": ["suggestions:vote"],
});

/**
 * Translate safe, known legacy editorial names. Unknown and control-plane
 * names never produce authority, and prerequisites are deliberately not
 * synthesized.
 */
export function translateLegacyScopes(scopes: readonly string[]): EditorialCapability[] {
  const present = new Set(scopes);
  const translated = new Set<EditorialCapability>();
  for (const scope of LEGACY_EDITORIAL_SCOPES) {
    if (!present.has(scope)) continue;
    for (const capability of LEGACY_TRANSLATION[scope]) {
      translated.add(capability);
    }
  }
  return EDITORIAL_CAPABILITIES.filter((capability) => translated.has(capability));
}

export type LegacyScopeParseResult =
  | {
      readonly ok: true;
      readonly scopes: LegacyEditorialScope[];
      readonly removedScopes: string[];
      readonly capabilities: EditorialCapability[];
    }
  | {
      readonly ok: false;
      readonly scopes: readonly [];
      readonly removedScopes: readonly [];
      readonly capabilities: readonly [];
      readonly reason: "invalid-legacy-scope-set";
    };

/**
 * Sanitize a decoded legacy scope set for dual-read mode.
 *
 * Known control-plane and unknown string names are returned for audit and
 * removed. Structurally malformed input denies the complete set so a corrupt
 * row cannot partially authorize a request.
 */
export function parseLegacyScopes(input: unknown): LegacyScopeParseResult {
  if (!Array.isArray(input) || !input.every((scope) => typeof scope === "string")) {
    return {
      ok: false,
      scopes: [],
      removedScopes: [],
      capabilities: [],
      reason: "invalid-legacy-scope-set",
    };
  }

  const values = input as string[];
  const present = new Set(values);
  const scopes = LEGACY_EDITORIAL_SCOPES.filter((scope) => present.has(scope));
  const safe = new Set<string>(LEGACY_EDITORIAL_SCOPES);
  const removedScopes = [...new Set(values.filter((scope) => !safe.has(scope)))];
  return {
    ok: true,
    scopes,
    removedScopes,
    capabilities: translateLegacyScopes(scopes),
  };
}

export const LEGACY_COMPATIBILITY_ACTIONS = [
  "feedback:moderate",
  "work:promote",
  "work:cancel",
] as const;
export type LegacyCompatibilityAction = (typeof LEGACY_COMPATIBILITY_ACTIONS)[number];

export interface LegacyEffectiveAction {
  readonly action: LegacyCompatibilityAction;
  readonly source: "legacy-scope";
  readonly sourceScope: "annotations:write" | "work:claim";
}

/**
 * Old maintainer-only actions preserved only while a row remains in legacy
 * mode. They are reported separately and are never canonical grants.
 */
export function legacyEffectiveActions(
  scopes: readonly string[],
  role: Role,
): LegacyEffectiveAction[] {
  if (role !== "maintainer") return [];
  const present = new Set(scopes);
  const actions: LegacyEffectiveAction[] = [];
  if (present.has("annotations:write")) {
    actions.push({
      action: "feedback:moderate",
      source: "legacy-scope",
      sourceScope: "annotations:write",
    });
  }
  if (present.has("work:claim")) {
    actions.push(
      {
        action: "work:promote",
        source: "legacy-scope",
        sourceScope: "work:claim",
      },
      {
        action: "work:cancel",
        source: "legacy-scope",
        sourceScope: "work:claim",
      },
    );
  }
  return actions;
}

/**
 * Requirements for writing an old scope alongside a canonical grant set.
 *
 * These are evaluated against granted capabilities, not today's role. A role
 * may be raised later without rewriting the token, so the shadow must remain
 * safe at the maintainer ceiling. Prerequisites used only by canonical routes
 * are included where an old umbrella route did not enforce them.
 */
const LEGACY_SHADOW_REQUIREMENTS: Readonly<
  Record<LegacyEditorialScope, readonly EditorialCapability[]>
> = Object.freeze({
  "chapters:read": ["chapters:read"],
  "annotations:read": ["comments:read", "suggestions:read"],
  "annotations:write": [
    "chapters:read",
    "comments:read",
    "suggestions:read",
    "comments:write",
    "suggestions:write",
    "replies:write",
    "feedback:withdraw-own",
    "feedback:moderate",
  ],
  "work:read": ["work:read"],
  "work:claim": ["work:promote", "work:claim", "work:cancel"],
  "submissions:write": ["work:submit", "chapters:write", "chapters:publish"],
  "votes:write": ["suggestions:vote"],
});

/**
 * Conservative old-scope shadow for a canonical row.
 *
 * A prior Worker may deny a granular action after deploy or rollback, but
 * every scope it does see is guaranteed not to exceed the canonical grant.
 * Control-plane and unknown names can never be emitted.
 */
export function legacyScopeShadow(
  capabilities: readonly EditorialCapability[],
): LegacyEditorialScope[] {
  const granted = new Set(capabilities);
  return LEGACY_EDITORIAL_SCOPES.filter((scope) =>
    LEGACY_SHADOW_REQUIREMENTS[scope].every((capability) => granted.has(capability)),
  );
}
