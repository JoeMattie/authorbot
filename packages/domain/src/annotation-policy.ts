/**
 * Annotation policy (Phase 7 contract "Restricting") - who may write to a
 * book, and whether what they write appears immediately.
 *
 * | Mode                | Who may write            | Appears                    |
 * |---------------------|--------------------------|----------------------------|
 * | `open`              | any signed-in user       | immediately                |
 * | `approval-gated`    | any signed-in user       | after a maintainer approves|
 * | `collaborators-only`| members only             | immediately *(default)*    |
 * | `locked`            | maintainers only         | immediately                |
 *
 * The rule is pure and lives here rather than in the API layer for the reason
 * the contract gives for it existing at all: it is enforced SERVER-SIDE, "not
 * merely reflected in the interface". A pure function with an exhaustive
 * decision table is testable against every combination of mode, role, and
 * credential kind without standing up a request, which is the only way to be
 * confident that `locked` really does admit a maintainer's agent and really
 * does refuse an editor.
 *
 * Two invariants hold across every mode and are asserted by the tests:
 *
 *   * **Anonymous writing is never available**, including under `open`.
 *     Design §19.7 defers it until moderation, spam controls, privacy, and a
 *     deletion policy all exist; Phase 7 supplies the first of the four.
 *   * **An agent never inherits its owner's access.** An agent token writes
 *     only through a membership of its own, which is the ordinary
 *     scope-intersection rule of Phase 2 §3 and a deliberate grant. That is
 *     also exactly how an author's agent keeps working under `locked`: it
 *     holds a membership with the maintainer role, granted on purpose.
 */
import { ALLOWED, denied, type Decision } from "./decision.js";
import type { Role } from "./scopes.js";

export const ANNOTATION_POLICIES = [
  "open",
  "approval-gated",
  "collaborators-only",
  "locked",
] as const;
export type AnnotationPolicy = (typeof ANNOTATION_POLICIES)[number];

/**
 * The mode a book with no declared policy runs in: the Phase 2 behaviour,
 * unchanged. A deployment upgrading into Phase 7 must not find its book
 * suddenly writable by strangers, so the default is the restrictive end of the
 * progression that people were already on - not the permissive end, and not
 * `locked` either, which would lock out the collaborators they already have.
 */
export const DEFAULT_ANNOTATION_POLICY: AnnotationPolicy = "collaborators-only";

export function isAnnotationPolicy(value: unknown): value is AnnotationPolicy {
  return typeof value === "string" && (ANNOTATION_POLICIES as readonly string[]).includes(value);
}

/** True when writes under this policy are queued for review rather than published. */
export function policyRequiresApproval(policy: AnnotationPolicy): boolean {
  return policy === "approval-gated";
}

export type AnnotationPolicyDenialReason =
  /** No credential at all. Refused in every mode, `open` included. */
  | "anonymous"
  /** Signed in, but this mode admits only members of the project. */
  | "members-only"
  /** The book is locked: maintainers only. */
  | "locked"
  /**
   * Signed in and not a member, asking for something a non-member could never
   * do (voting, claiming, submitting) even in an open book - those are member
   * capabilities, and `open` widens commenting, not the work queue.
   */
  | "member-capability";

/**
 * The write capabilities the policy arbitrates.
 *
 * `annotate` is the one the policy table is actually about - commenting and
 * suggesting. The other three are member capabilities that `open` and
 * `approval-gated` do NOT widen to strangers: a book that welcomes comments
 * from the internet is not thereby handing the internet its governance votes
 * or its work queue.
 *
 * `locked` restricts all four, because "existing collaborators keep their
 * membership and their history - they simply cannot write until the policy
 * opens again", and a vote that manufactures a work item is unambiguously a
 * write.
 */
export type PolicyCapability = "annotate" | "vote" | "claim" | "submit";

export interface AnnotationPolicyRequest {
  policy: AnnotationPolicy;
  /** Absent for an unauthenticated request. */
  credential: "session" | "token" | null;
  /** The actor's role through an unrevoked membership; null when not a member. */
  role: Role | null;
  capability: PolicyCapability;
}

/**
 * Decide whether the policy admits this write.
 *
 * This answers the policy question ONLY. Scope checks, freeze, the agent pause,
 * and rate limits are separate gates applied alongside it - a request must
 * satisfy all of them, and each refuses with its own problem type so the caller
 * can tell "the book is locked" from "the book is frozen" from "you are going
 * too fast".
 */
export function checkAnnotationPolicy(
  request: AnnotationPolicyRequest,
): Decision<AnnotationPolicyDenialReason> {
  const { policy, credential, role, capability } = request;

  // Invariant 1, checked before anything else so no mode can accidentally
  // relax it: anonymous writing is unavailable everywhere.
  if (credential === null) {
    return denied(
      "anonymous",
      "signing in is required to write to this book; anonymous contributions are not accepted in any mode",
    );
  }

  if (policy === "locked") {
    if (role === "maintainer") {
      return ALLOWED;
    }
    return denied(
      "locked",
      "this book is locked: only its maintainers may write. Existing collaborators keep their membership and their history, and may write again when the author reopens the policy.",
    );
  }

  const isMember = role !== null;

  if (policy === "open" || policy === "approval-gated") {
    if (isMember) {
      return ALLOWED;
    }
    // Invariant 2: a non-member agent token is NOT admitted by a permissive
    // policy. `open` means "any signed-in GitHub user", which describes a
    // person; an agent reaches a book through a membership granted to it on
    // purpose, never by its owner's access spilling over.
    if (credential === "token") {
      return denied(
        "members-only",
        "an agent token writes only through its own project membership; an open annotation policy admits signed-in people, not unenrolled agents",
      );
    }
    if (capability !== "annotate") {
      return denied(
        "member-capability",
        `${capability} is a collaborator capability: an open annotation policy widens commenting and suggesting, not voting, claiming, or submitting`,
      );
    }
    return ALLOWED;
  }

  // collaborators-only - the Phase 2 behaviour, and the default.
  if (isMember) {
    return ALLOWED;
  }
  return denied(
    "members-only",
    "this book accepts writes from its collaborators only",
  );
}
