export { DECISION_RESULTS, decisionResultSchema } from "@authorbot/schemas";
export type { DecisionResult } from "@authorbot/schemas";

/**
 * Sticky decision `support_changed` tracking (Phase 3 contract section 4,
 * design section 11.3). Later vote changes never delete a decision or its
 * work item; the decision only gains/loses a `support_changed` mark as the
 * live aggregate stops/starts satisfying the rule, with an event on each
 * flip. The original threshold-crossing metric snapshot is preserved
 * elsewhere (the decision row/artifact) and never rewritten here.
 */

/** Event emitted whenever the mark flips (contract section 5). */
export const DECISION_SUPPORT_CHANGED_EVENT = "decision_support_changed" as const;

export type SupportChangeTransition = "marked" | "cleared" | "unchanged";

export interface SupportChangeOutcome {
  /** The mark after applying the rule outcome. */
  readonly supportChanged: boolean;
  readonly transition: SupportChangeTransition;
  /** True exactly when a `decision_support_changed` event must be emitted. */
  readonly emitEvent: boolean;
}

/**
 * Pure transition: given the decision's current mark and whether the live
 * aggregate still satisfies the rule, decide the new mark.
 *
 * - satisfied + marked   → `cleared` (support returned)
 * - unsatisfied + unmarked → `marked` (support fell away)
 * - otherwise            → `unchanged`, no event
 */
export function resolveSupportChange(input: {
  supportChanged: boolean;
  ruleSatisfied: boolean;
}): SupportChangeOutcome {
  if (input.ruleSatisfied && input.supportChanged) {
    return { supportChanged: false, transition: "cleared", emitEvent: true };
  }
  if (!input.ruleSatisfied && !input.supportChanged) {
    return { supportChanged: true, transition: "marked", emitEvent: true };
  }
  return { supportChanged: input.supportChanged, transition: "unchanged", emitEvent: false };
}
