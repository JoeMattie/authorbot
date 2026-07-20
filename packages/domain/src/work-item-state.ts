import { WORK_ITEM_STATUSES, type WorkItemStatus } from "@authorbot/schemas";
import { ALLOWED, denied, type Decision } from "./decision.js";

export { WORK_ITEM_STATUSES };
export type { WorkItemStatus };

/**
 * Work-item state machine (design section 9.5). The full transition graph is
 * declared so Phase 4 is additive data, but Phase 3 stops at `ready` (Phase 3
 * contract section 1: claims/leases/submissions are out of scope) — the only
 * transition that may actually execute is `ready -> cancelled` (maintainer
 * cancel). Every other graph edge is phase-gated: legal in the design, denied
 * at runtime with `phase-not-enabled` until Phase 4 lifts the gate.
 */
export const WORK_ITEM_TRANSITIONS: Readonly<
  Record<WorkItemStatus, readonly WorkItemStatus[]>
> = Object.freeze({
  ready: ["leased", "cancelled"],
  leased: ["ready", "submitted", "cancelled"],
  submitted: ["applying", "failed"],
  applying: ["completed", "conflict"],
  conflict: ["ready"],
  completed: [],
  failed: [],
  cancelled: [],
});

/** Statuses a work item can actually hold in Phase 3 (contract section 1). */
export const PHASE3_WORK_ITEM_STATUSES = ["ready", "cancelled"] as const satisfies
  readonly WorkItemStatus[];

export function isPhase3WorkItemStatus(status: WorkItemStatus): boolean {
  return (PHASE3_WORK_ITEM_STATUSES as readonly WorkItemStatus[]).includes(status);
}

/** Whether the full design section 9.5 graph has this edge (phase-agnostic). */
export function canTransitionWorkItem(from: WorkItemStatus, to: WorkItemStatus): boolean {
  return WORK_ITEM_TRANSITIONS[from].includes(to);
}

export type WorkItemTransitionDenialReason = "illegal-transition" | "phase-not-enabled";

/**
 * Typed decision for a requested work-item status change under the Phase 3
 * gate: the edge must exist in the design graph AND both endpoints must be
 * Phase 3 statuses. Graph-legal but gated edges (e.g. `ready -> leased`)
 * are denied with `phase-not-enabled` so callers can distinguish "never
 * legal" from "not yet".
 */
export function transitionWorkItem(
  from: WorkItemStatus,
  to: WorkItemStatus,
): Decision<WorkItemTransitionDenialReason> {
  if (!canTransitionWorkItem(from, to)) {
    return denied(
      "illegal-transition",
      `work item status cannot change from "${from}" to "${to}"`,
    );
  }
  if (!isPhase3WorkItemStatus(from) || !isPhase3WorkItemStatus(to)) {
    return denied(
      "phase-not-enabled",
      `work item transition "${from}" -> "${to}" is deferred to Phase 4 (work items stop at "ready" in Phase 3)`,
    );
  }
  return ALLOWED;
}
