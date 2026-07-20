import { denied, type Denied } from "./decision.js";

/**
 * Git operation state machine (design section 20.2, Phase 2 contract
 * section 5): `queued -> preparing -> committing -> committed -> verified`,
 * failures -> `conflict | failed`, with bounded retries (3).
 */

export const GIT_OPERATION_STATES = [
  "queued",
  "preparing",
  "committing",
  "committed",
  "verified",
  "conflict",
  "failed",
] as const;
export type GitOperationState = (typeof GIT_OPERATION_STATES)[number];

/** Maximum commit attempts per operation (contract section 5: bounded retries, 3). */
export const MAX_GIT_ATTEMPTS = 3;

/**
 * Legal transitions. `conflict -> queued` is the (bounded) retry edge;
 * `preparing`/`committing` may fail into `conflict` (stale expected head,
 * non-fast-forward) or `failed` (non-retryable error, retries exhausted).
 */
export const GIT_OPERATION_TRANSITIONS: Readonly<
  Record<GitOperationState, readonly GitOperationState[]>
> = Object.freeze({
  queued: ["preparing"],
  preparing: ["committing", "conflict", "failed"],
  committing: ["committed", "conflict", "failed"],
  committed: ["verified"],
  verified: [],
  conflict: ["queued", "failed"],
  failed: [],
});

export function canTransitionGitOperation(
  from: GitOperationState,
  to: GitOperationState,
): boolean {
  return GIT_OPERATION_TRANSITIONS[from].includes(to);
}

/**
 * Attempt-accounted snapshot of an operation. `attempts` counts how many
 * times the operation has entered `preparing` (i.e. commit attempts begun).
 * A fresh operation starts `{ state: "queued", attempts: 0 }`.
 */
export interface GitOperationProgress {
  readonly state: GitOperationState;
  readonly attempts: number;
}

export const INITIAL_GIT_OPERATION: GitOperationProgress = Object.freeze({
  state: "queued",
  attempts: 0,
});

export type GitOperationDenialReason = "illegal-transition" | "retries-exhausted";

export type GitOperationTransitionResult =
  | { readonly allowed: true; readonly next: GitOperationProgress }
  | Denied<GitOperationDenialReason>;

/**
 * Apply a state change with bounded-retry accounting:
 * - `queued -> preparing` increments `attempts` (an attempt begins).
 * - `conflict -> queued` (retry) is denied with `retries-exhausted` once
 *   `attempts >= maxAttempts`; the only legal exit is then `failed`.
 */
export function transitionGitOperation(
  current: GitOperationProgress,
  to: GitOperationState,
  maxAttempts: number = MAX_GIT_ATTEMPTS,
): GitOperationTransitionResult {
  if (!canTransitionGitOperation(current.state, to)) {
    return denied(
      "illegal-transition",
      `git operation cannot change from "${current.state}" to "${to}"`,
    );
  }
  if (current.state === "conflict" && to === "queued" && current.attempts >= maxAttempts) {
    return denied(
      "retries-exhausted",
      `git operation already used ${current.attempts} of ${maxAttempts} attempts; it must fail`,
    );
  }
  const attempts =
    current.state === "queued" && to === "preparing"
      ? current.attempts + 1
      : current.attempts;
  return { allowed: true, next: { state: to, attempts } };
}

/** Whether a conflicted operation may still be retried under the bound. */
export function canRetryGitOperation(
  current: GitOperationProgress,
  maxAttempts: number = MAX_GIT_ATTEMPTS,
): boolean {
  return current.state === "conflict" && current.attempts < maxAttempts;
}

/** Terminal states: no outgoing transitions remain. */
export function isGitOperationTerminal(state: GitOperationState): boolean {
  return GIT_OPERATION_TRANSITIONS[state].length === 0;
}
