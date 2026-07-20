import { describe, expect, it } from "vitest";
import {
  GIT_OPERATION_STATES,
  GIT_OPERATION_TRANSITIONS,
  INITIAL_GIT_OPERATION,
  MAX_GIT_ATTEMPTS,
  canRetryGitOperation,
  canTransitionGitOperation,
  isGitOperationTerminal,
  transitionGitOperation,
  type GitOperationProgress,
  type GitOperationState,
} from "../src/index.js";

const LEGAL: ReadonlyArray<readonly [GitOperationState, GitOperationState]> = [
  ["queued", "preparing"],
  ["preparing", "committing"],
  ["preparing", "conflict"],
  ["preparing", "failed"],
  ["committing", "committed"],
  ["committing", "conflict"],
  ["committing", "failed"],
  ["committed", "verified"],
  ["conflict", "queued"],
  ["conflict", "failed"],
];

function isLegal(from: GitOperationState, to: GitOperationState): boolean {
  return LEGAL.some(([f, t]) => f === from && t === to);
}

function at(state: GitOperationState, attempts: number): GitOperationProgress {
  return { state, attempts };
}

describe("git operation state machine", () => {
  it("transition table matches design section 20.2 exactly", () => {
    for (const from of GIT_OPERATION_STATES) {
      const expected = LEGAL.filter(([f]) => f === from).map(([, t]) => t);
      expect([...GIT_OPERATION_TRANSITIONS[from]].sort()).toEqual(expected.sort());
    }
  });

  // Exhaustive: every ordered pair of states.
  for (const from of GIT_OPERATION_STATES) {
    for (const to of GIT_OPERATION_STATES) {
      const legal = isLegal(from, to);
      it(`${from} -> ${to} is ${legal ? "legal" : "illegal"}`, () => {
        expect(canTransitionGitOperation(from, to)).toBe(legal);
        const result = transitionGitOperation(at(from, 1), to);
        expect(result.allowed).toBe(legal);
        if (!result.allowed && !legal) {
          expect(result.reason).toBe("illegal-transition");
        }
      });
    }
  }

  it("verified and failed are terminal; all other states are not", () => {
    for (const state of GIT_OPERATION_STATES) {
      expect(isGitOperationTerminal(state)).toBe(state === "verified" || state === "failed");
    }
  });
});

describe("bounded retry accounting", () => {
  it("starts at queued with zero attempts", () => {
    expect(INITIAL_GIT_OPERATION).toEqual({ state: "queued", attempts: 0 });
    expect(MAX_GIT_ATTEMPTS).toBe(3);
  });

  it("queued -> preparing increments attempts; other transitions do not", () => {
    const first = transitionGitOperation(INITIAL_GIT_OPERATION, "preparing");
    expect(first).toMatchObject({ allowed: true, next: { state: "preparing", attempts: 1 } });

    const committing = transitionGitOperation(at("preparing", 1), "committing");
    expect(committing).toMatchObject({ allowed: true, next: { attempts: 1 } });

    const conflicted = transitionGitOperation(at("committing", 1), "conflict");
    expect(conflicted).toMatchObject({ allowed: true, next: { attempts: 1 } });
  });

  it("allows retries until the third attempt has been used", () => {
    expect(transitionGitOperation(at("conflict", 1), "queued")).toMatchObject({
      allowed: true,
      next: { state: "queued", attempts: 1 },
    });
    expect(transitionGitOperation(at("conflict", 2), "queued")).toMatchObject({
      allowed: true,
    });
  });

  it("denies a fourth attempt with retries-exhausted", () => {
    const result = transitionGitOperation(at("conflict", MAX_GIT_ATTEMPTS), "queued");
    expect(result).toMatchObject({ allowed: false, reason: "retries-exhausted" });
  });

  it("still allows conflict -> failed after retries are exhausted", () => {
    expect(transitionGitOperation(at("conflict", MAX_GIT_ATTEMPTS), "failed")).toMatchObject({
      allowed: true,
      next: { state: "failed", attempts: MAX_GIT_ATTEMPTS },
    });
  });

  it("full happy path: queued -> ... -> verified with one attempt", () => {
    let op: GitOperationProgress = INITIAL_GIT_OPERATION;
    for (const next of ["preparing", "committing", "committed", "verified"] as const) {
      const result = transitionGitOperation(op, next);
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        op = result.next;
      }
    }
    expect(op).toEqual({ state: "verified", attempts: 1 });
  });

  it("retry loop walks attempts to the bound then must fail", () => {
    let op: GitOperationProgress = INITIAL_GIT_OPERATION;
    for (let attempt = 1; attempt <= MAX_GIT_ATTEMPTS; attempt += 1) {
      const prep = transitionGitOperation(op, "preparing");
      expect(prep.allowed).toBe(true);
      if (!prep.allowed) return;
      expect(prep.next.attempts).toBe(attempt);
      const conflicted = transitionGitOperation(prep.next, "conflict");
      expect(conflicted.allowed).toBe(true);
      if (!conflicted.allowed) return;
      op = conflicted.next;
      if (attempt < MAX_GIT_ATTEMPTS) {
        expect(canRetryGitOperation(op)).toBe(true);
        const retried = transitionGitOperation(op, "queued");
        expect(retried.allowed).toBe(true);
        if (!retried.allowed) return;
        op = retried.next;
      }
    }
    expect(canRetryGitOperation(op)).toBe(false);
    expect(transitionGitOperation(op, "queued")).toMatchObject({
      allowed: false,
      reason: "retries-exhausted",
    });
  });

  it("respects a custom maxAttempts", () => {
    expect(transitionGitOperation(at("conflict", 1), "queued", 1)).toMatchObject({
      allowed: false,
      reason: "retries-exhausted",
    });
    expect(transitionGitOperation(at("conflict", 3), "queued", 5)).toMatchObject({
      allowed: true,
    });
  });

  it("canRetryGitOperation is false for non-conflict states", () => {
    for (const state of GIT_OPERATION_STATES) {
      if (state !== "conflict") {
        expect(canRetryGitOperation(at(state, 0))).toBe(false);
      }
    }
  });
});
