import { z } from "zod";
import {
  uuidv7Schema,
  type AnnotationKind,
  type AnnotationStatus,
  type WorkItemStatus,
} from "@authorbot/schemas";
import { canTransitionAnnotation } from "./annotation-state.js";
import { ALLOWED, denied, type Decision } from "./decision.js";
import type { Role } from "./scopes.js";
import { transitionWorkItem } from "./work-item-state.js";

/**
 * Maintainer overrides (Phase 3 contract section 4; design section 11.2).
 * All four are maintainer-only, require a recorded `reason`, and are recorded
 * as decisions with `override_reason`. Force-create bypasses the rule but
 * respects the same uniqueness key `(source_annotation_id, action_type,
 * rule_version)` with `rule_version: 0`.
 */

/** Minimum meaningful override reason length (after trimming). */
export const MIN_OVERRIDE_REASON_LENGTH = 3;
/** Bound chosen for storage sanity (not contract-pinned). */
export const MAX_OVERRIDE_REASON_LENGTH = 2000;

export const overrideReasonSchema = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) => value.length >= MIN_OVERRIDE_REASON_LENGTH,
    `reason must be at least ${MIN_OVERRIDE_REASON_LENGTH} characters`,
  )
  .refine(
    (value) => value.length <= MAX_OVERRIDE_REASON_LENGTH,
    `reason must be at most ${MAX_OVERRIDE_REASON_LENGTH} characters`,
  );

/** `rule_version` recorded by force-created decisions (contract section 4). */
export const FORCE_CREATE_RULE_VERSION = 0;

/** Override 1: reject an open suggestion. */
export const rejectSuggestionCommandSchema = z.strictObject({
  annotationId: uuidv7Schema,
  reason: overrideReasonSchema,
});
export type RejectSuggestionCommand = z.infer<typeof rejectSuggestionCommandSchema>;

/** Override 2: cancel a `ready` work item. */
export const cancelWorkItemCommandSchema = z.strictObject({
  workItemId: uuidv7Schema,
  reason: overrideReasonSchema,
});
export type CancelWorkItemCommand = z.infer<typeof cancelWorkItemCommandSchema>;

/** Override 3: reopen a rejected suggestion. */
export const reopenSuggestionCommandSchema = z.strictObject({
  annotationId: uuidv7Schema,
  reason: overrideReasonSchema,
});
export type ReopenSuggestionCommand = z.infer<typeof reopenSuggestionCommandSchema>;

/**
 * Override 4: force-create a work item bypassing the rule. `work_type` is not
 * part of the command - it resolves from the annotation scope exactly as
 * rule-created items do (Phase 3 contract section 3).
 */
export const forceCreateWorkItemCommandSchema = z.strictObject({
  annotationId: uuidv7Schema,
  reason: overrideReasonSchema,
});
export type ForceCreateWorkItemCommand = z.infer<typeof forceCreateWorkItemCommandSchema>;

export type SuggestionOverrideDenialReason =
  | "not-maintainer"
  | "not-a-suggestion"
  | "illegal-transition";

function requireMaintainer(
  actorRole: Role,
): Decision<"not-maintainer"> {
  if (actorRole !== "maintainer") {
    return denied("not-maintainer", "only a maintainer may perform overrides");
  }
  return ALLOWED;
}

function requireSuggestion(
  kind: AnnotationKind,
): Decision<"not-a-suggestion"> {
  if (kind !== "suggestion") {
    return denied("not-a-suggestion", "this override applies to suggestions only");
  }
  return ALLOWED;
}

/** Reject an open suggestion (`open -> rejected`). */
export function authorizeRejectSuggestion(input: {
  actorRole: Role;
  annotationKind: AnnotationKind;
  annotationStatus: AnnotationStatus;
}): Decision<SuggestionOverrideDenialReason> {
  const maintainer = requireMaintainer(input.actorRole);
  if (!maintainer.allowed) return maintainer;
  const suggestion = requireSuggestion(input.annotationKind);
  if (!suggestion.allowed) return suggestion;
  if (!canTransitionAnnotation(input.annotationStatus, "rejected")) {
    return denied(
      "illegal-transition",
      `a suggestion with status "${input.annotationStatus}" cannot be rejected (only "open")`,
    );
  }
  return ALLOWED;
}

/** Reopen a rejected suggestion (`rejected -> open`). */
export function authorizeReopenSuggestion(input: {
  actorRole: Role;
  annotationKind: AnnotationKind;
  annotationStatus: AnnotationStatus;
}): Decision<SuggestionOverrideDenialReason> {
  const maintainer = requireMaintainer(input.actorRole);
  if (!maintainer.allowed) return maintainer;
  const suggestion = requireSuggestion(input.annotationKind);
  if (!suggestion.allowed) return suggestion;
  if (!canTransitionAnnotation(input.annotationStatus, "open")) {
    return denied(
      "illegal-transition",
      `a suggestion with status "${input.annotationStatus}" cannot be reopened (only "rejected")`,
    );
  }
  return ALLOWED;
}

export type WorkItemOverrideDenialReason =
  | "not-maintainer"
  | "illegal-transition"
  | "phase-not-enabled";

/** Cancel a `ready` work item (contract section 4: cancel before integration). */
export function authorizeCancelWorkItem(input: {
  actorRole: Role;
  workItemStatus: WorkItemStatus;
}): Decision<WorkItemOverrideDenialReason> {
  const maintainer = requireMaintainer(input.actorRole);
  if (!maintainer.allowed) return maintainer;
  return transitionWorkItem(input.workItemStatus, "cancelled");
}

/**
 * Force-create a work item for an open suggestion, bypassing the rule. The
 * annotation must still be able to make the `open -> work_item_created`
 * transition; uniqueness (one item per annotation/action/rule-version) is the
 * DB constraint's job.
 */
export function authorizeForceCreateWorkItem(input: {
  actorRole: Role;
  annotationKind: AnnotationKind;
  annotationStatus: AnnotationStatus;
}): Decision<SuggestionOverrideDenialReason> {
  const maintainer = requireMaintainer(input.actorRole);
  if (!maintainer.allowed) return maintainer;
  const suggestion = requireSuggestion(input.annotationKind);
  if (!suggestion.allowed) return suggestion;
  if (!canTransitionAnnotation(input.annotationStatus, "work_item_created")) {
    return denied(
      "illegal-transition",
      `a suggestion with status "${input.annotationStatus}" cannot receive a work item (only "open")`,
    );
  }
  return ALLOWED;
}
