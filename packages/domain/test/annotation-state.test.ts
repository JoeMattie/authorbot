import { describe, expect, it } from "vitest";
import {
  ANNOTATION_STATUSES,
  ANNOTATION_TRANSITIONS,
  authorizeAnnotationWithdraw,
  canTransitionAnnotation,
  transitionAnnotation,
  type AnnotationStatus,
} from "../src/index.js";

const NON_OPEN_STATUSES = ANNOTATION_STATUSES.filter((s) => s !== "open");

describe("annotation state machine", () => {
  it("open fans out to every other status (design section 9.4)", () => {
    expect([...ANNOTATION_TRANSITIONS.open].sort()).toEqual([...NON_OPEN_STATUSES].sort());
  });

  // Exhaustive: every ordered pair of statuses.
  for (const from of ANNOTATION_STATUSES) {
    for (const to of ANNOTATION_STATUSES) {
      const legal = from === "open" && to !== "open";
      it(`${from} -> ${to} is ${legal ? "legal" : "illegal"}`, () => {
        expect(canTransitionAnnotation(from, to)).toBe(legal);
        const decision = transitionAnnotation(from, to);
        expect(decision.allowed).toBe(legal);
        if (!decision.allowed) {
          expect(decision.reason).toBe("illegal-transition");
          expect(decision.message).toContain(from);
          expect(decision.message).toContain(to);
        }
      });
    }
  }
});

describe("authorizeAnnotationWithdraw", () => {
  const author = "github:octocat";

  it("allows the author regardless of role", () => {
    for (const role of ["reader", "contributor", "editor", "maintainer"] as const) {
      expect(
        authorizeAnnotationWithdraw({
          annotationAuthor: author,
          annotationStatus: "open",
          actor: author,
          actorRole: role,
        }).allowed,
      ).toBe(true);
    }
  });

  it("allows a maintainer who is not the author", () => {
    expect(
      authorizeAnnotationWithdraw({
        annotationAuthor: author,
        annotationStatus: "open",
        actor: "github:someone-else",
        actorRole: "maintainer",
      }).allowed,
    ).toBe(true);
  });

  it("denies a non-author non-maintainer", () => {
    for (const role of ["reader", "contributor", "editor"] as const) {
      const decision = authorizeAnnotationWithdraw({
        annotationAuthor: author,
        annotationStatus: "open",
        actor: "agent:helper-bot",
        actorRole: role,
      });
      expect(decision).toMatchObject({
        allowed: false,
        reason: "not-author-or-maintainer",
      });
    }
  });

  it("actor comparison is exact (namespace matters)", () => {
    const decision = authorizeAnnotationWithdraw({
      annotationAuthor: "github:octocat",
      annotationStatus: "open",
      actor: "agent:octocat",
      actorRole: "contributor",
    });
    expect(decision.allowed).toBe(false);
  });

  it("denies withdrawing any non-open annotation, even for the author", () => {
    for (const status of NON_OPEN_STATUSES as AnnotationStatus[]) {
      const decision = authorizeAnnotationWithdraw({
        annotationAuthor: author,
        annotationStatus: status,
        actor: author,
        actorRole: "maintainer",
      });
      expect(decision).toMatchObject({ allowed: false, reason: "illegal-transition" });
    }
  });

  it("authorization is checked before state (denied outsider on a closed annotation gets the authz reason)", () => {
    const decision = authorizeAnnotationWithdraw({
      annotationAuthor: author,
      annotationStatus: "resolved",
      actor: "github:intruder",
      actorRole: "reader",
    });
    expect(decision).toMatchObject({ allowed: false, reason: "not-author-or-maintainer" });
  });
});
