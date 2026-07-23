import { WORK_ITEM_STATUSES, type WorkItemStatus } from "@authorbot/schemas";
import { ALLOWED, denied, type Decision, type Denied } from "./decision.js";
import { WORK_ITEM_TRANSITIONS, canTransitionWorkItem } from "./work-item-state.js";

/**
 * Phase 4 work-item lifecycle: the full design section 9.5 machine with the
 * Phase 3 gate lifted (Phase 4 contract sections 2, 4, 5). The graph itself
 * has been declared since Phase 3 (`WORK_ITEM_TRANSITIONS`); this module
 * adds the executable, trigger-labelled form. `transitionWorkItem` (the
 * Phase 3-gated function) is left untouched for compatibility - Phase 4
 * call sites use `transitionWorkItemPhase4` / `applyWorkItemTrigger`.
 */

/**
 * The design section 9.5 edge labels. One trigger per labelled arrow;
 * `expire` and `release` are the two expiry/release back-edges sharing
 * `leased -> ready`, and `cancel` covers both maintainer-action arrows.
 */
export const WORK_ITEM_TRIGGERS = [
  "claim",
  "expire",
  "release",
  "submit",
  "review_rejected",
  "validation_passed",
  "validation_failed",
  "apply_succeeded",
  "apply_conflicted",
  "conflict_resolution_prepared",
  "cancel",
] as const;
export type WorkItemTrigger = (typeof WORK_ITEM_TRIGGERS)[number];

/** Trigger -> the design edges it may traverse (exactly section 9.5). */
export const WORK_ITEM_TRIGGER_EDGES: Readonly<
  Record<WorkItemTrigger, ReadonlyArray<readonly [WorkItemStatus, WorkItemStatus]>>
> = Object.freeze({
  claim: [["ready", "leased"]],
  expire: [["leased", "ready"]],
  release: [["leased", "ready"]],
  submit: [["leased", "submitted"]],
  review_rejected: [["submitted", "ready"]],
  validation_passed: [["submitted", "applying"]],
  validation_failed: [["submitted", "failed"]],
  apply_succeeded: [["applying", "completed"]],
  apply_conflicted: [["applying", "conflict"]],
  conflict_resolution_prepared: [["conflict", "ready"]],
  cancel: [
    ["ready", "cancelled"],
    ["leased", "cancelled"],
  ],
});

/** Statuses with no outgoing edges (design section 9.5). */
export function isWorkItemTerminal(status: WorkItemStatus): boolean {
  return WORK_ITEM_TRANSITIONS[status].length === 0;
}

export type WorkItemLifecycleDenialReason = "illegal-transition";

/**
 * Phase 4 edge check: every design section 9.5 edge is executable, nothing
 * else is. (Contrast `transitionWorkItem`, which additionally applies the
 * Phase 3 gate.)
 */
export function transitionWorkItemPhase4(
  from: WorkItemStatus,
  to: WorkItemStatus,
): Decision<WorkItemLifecycleDenialReason> {
  if (!canTransitionWorkItem(from, to)) {
    return denied(
      "illegal-transition",
      `work item status cannot change from "${from}" to "${to}"`,
    );
  }
  return ALLOWED;
}

export type WorkItemTriggerResult =
  | { readonly allowed: true; readonly next: WorkItemStatus }
  | Denied<WorkItemLifecycleDenialReason>;

/**
 * Apply a labelled trigger to a status. Deterministic: every trigger maps a
 * given status to at most one next status, so commands can ask "what does
 * `expire` do to this item?" without hand-picking the target state.
 */
export function applyWorkItemTrigger(
  status: WorkItemStatus,
  trigger: WorkItemTrigger,
): WorkItemTriggerResult {
  for (const [from, to] of WORK_ITEM_TRIGGER_EDGES[trigger]) {
    if (from === status) {
      return { allowed: true, next: to };
    }
  }
  return denied(
    "illegal-transition",
    `trigger "${trigger}" does not apply to a work item in status "${status}"`,
  );
}

/** All statuses are live in Phase 4 (the Phase 3 stop-at-ready gate is lifted). */
export const PHASE4_WORK_ITEM_STATUSES = WORK_ITEM_STATUSES;
