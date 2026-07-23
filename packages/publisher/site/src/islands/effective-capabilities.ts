/**
 * Tiny, dependency-free capability projection shared by every browser entry.
 *
 * Keep this outside `api.ts`: the account-only story-page entry needs these
 * two checks but must not pull the full collaboration transport into its
 * reader-facing bootstrap.
 */
export interface EffectiveCapabilityCredential {
  scopes: readonly string[];
  capabilityMode?: "human" | "legacy" | "canonical";
  effectiveCapabilities?: readonly string[];
  legacyEffectiveActions?: ReadonlyArray<{ action: string; sourceScopes?: readonly string[] }>;
}

/** Canonical capability first; legacy scope only for an older Worker shape. */
export function hasEffectiveCapability(
  credential: EffectiveCapabilityCredential | null,
  capability: string,
  legacyScope?: string,
): boolean {
  if (credential === null) return false;
  if (Array.isArray(credential.effectiveCapabilities)) {
    return credential.effectiveCapabilities.includes(capability);
  }
  return legacyScope !== undefined && credential.scopes.includes(legacyScope);
}

/** High-impact compatibility actions are source-tagged, never inferred. */
export function hasLegacyEffectiveAction(
  credential: EffectiveCapabilityCredential | null,
  action: string,
  oldWorkerScope?: string,
): boolean {
  if (credential === null) return false;
  if (Array.isArray(credential.legacyEffectiveActions)) {
    return credential.legacyEffectiveActions.some((entry) => entry.action === action);
  }
  if (
    credential.capabilityMode !== undefined ||
    credential.effectiveCapabilities !== undefined
  ) {
    return false;
  }
  return oldWorkerScope !== undefined && credential.scopes.includes(oldWorkerScope);
}
