import { ANNOTATION_STATUSES, type AnnotationStatus } from "@authorbot/schemas";
import { ALLOWED, denied, type Decision } from "./decision.js";
import type { Role } from "./scopes.js";

export { ANNOTATION_STATUSES };
export type { AnnotationStatus };

/**
 * Annotation state machine (design section 9.4; statuses per Phase 0 contract
 * section 4). `open` fans out; `rejected -> open` is the Phase 3 maintainer
 * reopen override (Phase 3 contract section 4); every other status is
 * terminal. The reanchor flow (`needs_reanchor -> open`) is intentionally not
 * legal yet — adding transitions later is additive.
 */
export const ANNOTATION_TRANSITIONS: Readonly<
  Record<AnnotationStatus, readonly AnnotationStatus[]>
> = Object.freeze({
  open: [
    "work_item_created",
    "accepted",
    "resolved",
    "rejected",
    "withdrawn",
    "superseded",
    "orphaned",
    "needs_reanchor",
  ],
  work_item_created: [],
  accepted: [],
  resolved: [],
  rejected: ["open"],
  withdrawn: [],
  superseded: [],
  orphaned: [],
  needs_reanchor: [],
});

export function canTransitionAnnotation(
  from: AnnotationStatus,
  to: AnnotationStatus,
): boolean {
  return ANNOTATION_TRANSITIONS[from].includes(to);
}

export type AnnotationTransitionDenialReason = "illegal-transition";

/** Typed decision for a requested annotation status change. */
export function transitionAnnotation(
  from: AnnotationStatus,
  to: AnnotationStatus,
): Decision<AnnotationTransitionDenialReason> {
  if (canTransitionAnnotation(from, to)) {
    return ALLOWED;
  }
  return denied(
    "illegal-transition",
    `annotation status cannot change from "${from}" to "${to}"`,
  );
}

export type WithdrawDenialReason =
  | "not-author-or-maintainer"
  | "illegal-transition";

/**
 * Withdraw authorization rule (Phase 2 contract section 4): withdraw is
 * author-or-maintainer, and only an `open` annotation can be withdrawn.
 * `annotationAuthor` and `actor` are canonical actor refs
 * (`<namespace>:<identifier>`, Phase 0 contract section 2); comparison is
 * exact string equality.
 */
export function authorizeAnnotationWithdraw(input: {
  annotationAuthor: string;
  annotationStatus: AnnotationStatus;
  actor: string;
  actorRole: Role;
}): Decision<WithdrawDenialReason> {
  if (input.actor !== input.annotationAuthor && input.actorRole !== "maintainer") {
    return denied(
      "not-author-or-maintainer",
      "only the annotation author or a maintainer may withdraw an annotation",
    );
  }
  const transition = transitionAnnotation(input.annotationStatus, "withdrawn");
  if (!transition.allowed) {
    return denied(
      "illegal-transition",
      `annotation with status "${input.annotationStatus}" cannot be withdrawn`,
    );
  }
  return ALLOWED;
}
