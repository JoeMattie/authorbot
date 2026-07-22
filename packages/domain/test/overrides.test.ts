import { describe, expect, it } from "vitest";
import { ANNOTATION_STATUSES, WORK_ITEM_STATUSES } from "@authorbot/schemas";
import {
  FORCE_CREATE_RULE_VERSION,
  MAX_OVERRIDE_REASON_LENGTH,
  MIN_OVERRIDE_REASON_LENGTH,
  authorizeCancelWorkItem,
  authorizeForceCreateWorkItem,
  authorizeRejectSuggestion,
  authorizeReopenSuggestion,
  cancelWorkItemCommandSchema,
  forceCreateWorkItemCommandSchema,
  overrideReasonSchema,
  rejectSuggestionCommandSchema,
  reopenSuggestionCommandSchema,
} from "../src/index.js";

const ID = "0190f300-2f7e-7467-b288-5e3c5a4bd991";
const NON_MAINTAINER_ROLES = ["reader", "contributor", "editor"] as const;

describe("overrideReasonSchema (contract section 4: reason required)", () => {
  it("accepts a reason of exactly the minimum length", () => {
    expect(overrideReasonSchema.parse("abc")).toBe("abc");
    expect(MIN_OVERRIDE_REASON_LENGTH).toBe(3);
  });

  it("trims surrounding whitespace before measuring", () => {
    expect(overrideReasonSchema.parse("  duplicate of #12  ")).toBe("duplicate of #12");
  });

  for (const bad of ["", "ab", "  a  ", "\n\t ab \n"]) {
    it(`rejects ${JSON.stringify(bad)} (under ${MIN_OVERRIDE_REASON_LENGTH} chars after trim)`, () => {
      expect(overrideReasonSchema.safeParse(bad).success).toBe(false);
    });
  }

  it("rejects an over-long reason", () => {
    expect(overrideReasonSchema.safeParse("x".repeat(MAX_OVERRIDE_REASON_LENGTH + 1)).success).toBe(
      false,
    );
    expect(overrideReasonSchema.safeParse("x".repeat(MAX_OVERRIDE_REASON_LENGTH)).success).toBe(
      true,
    );
  });

  it("rejects non-strings", () => {
    expect(overrideReasonSchema.safeParse(42).success).toBe(false);
    expect(overrideReasonSchema.safeParse(null).success).toBe(false);
  });
});

describe("override command schemas", () => {
  const annotationCommands = {
    reject: rejectSuggestionCommandSchema,
    reopen: reopenSuggestionCommandSchema,
  } as const;

  for (const [name, schema] of Object.entries(annotationCommands)) {
    it(`${name}: accepts { annotationId, reason }`, () => {
      expect(schema.parse({ annotationId: ID, reason: "off-scope change" })).toEqual({
        annotationId: ID,
        reason: "off-scope change",
      });
    });

    it(`${name}: rejects a missing or too-short reason`, () => {
      expect(schema.safeParse({ annotationId: ID }).success).toBe(false);
      expect(schema.safeParse({ annotationId: ID, reason: "no" }).success).toBe(false);
    });

    it(`${name}: is strict about unknown keys`, () => {
      expect(schema.safeParse({ annotationId: ID, reason: "abc", force: true }).success).toBe(
        false,
      );
    });
  }

  it("force-create accepts a reasonless promotion and an optional legacy reason", () => {
    expect(forceCreateWorkItemCommandSchema.parse({ annotationId: ID })).toEqual({
      annotationId: ID,
    });
    expect(
      forceCreateWorkItemCommandSchema.parse({ annotationId: ID, reason: "editorial call" }),
    ).toEqual({ annotationId: ID, reason: "editorial call" });
    expect(
      forceCreateWorkItemCommandSchema.safeParse({ annotationId: ID, reason: "no" }).success,
    ).toBe(false);
    expect(
      forceCreateWorkItemCommandSchema.safeParse({ annotationId: ID, force: true }).success,
    ).toBe(false);
  });

  it("cancel: keys on workItemId and requires the reason", () => {
    expect(cancelWorkItemCommandSchema.parse({ workItemId: ID, reason: "stale" }).workItemId).toBe(
      ID,
    );
    expect(cancelWorkItemCommandSchema.safeParse({ workItemId: ID, reason: "ab" }).success).toBe(
      false,
    );
    expect(
      cancelWorkItemCommandSchema.safeParse({ annotationId: ID, reason: "stale" }).success,
    ).toBe(false);
  });

  it("force-create records rule_version 0 (contract section 4 uniqueness key)", () => {
    expect(FORCE_CREATE_RULE_VERSION).toBe(0);
  });
});

describe("authorizeRejectSuggestion", () => {
  it("allows a maintainer rejecting an open suggestion", () => {
    expect(
      authorizeRejectSuggestion({
        actorRole: "maintainer",
        annotationKind: "suggestion",
        annotationStatus: "open",
      }).allowed,
    ).toBe(true);
  });

  it("denies every non-maintainer role first", () => {
    for (const role of NON_MAINTAINER_ROLES) {
      expect(
        authorizeRejectSuggestion({
          actorRole: role,
          annotationKind: "suggestion",
          annotationStatus: "open",
        }),
      ).toMatchObject({ allowed: false, reason: "not-maintainer" });
    }
  });

  it("denies comments", () => {
    expect(
      authorizeRejectSuggestion({
        actorRole: "maintainer",
        annotationKind: "comment",
        annotationStatus: "open",
      }),
    ).toMatchObject({ allowed: false, reason: "not-a-suggestion" });
  });

  it("denies every non-open status", () => {
    for (const status of ANNOTATION_STATUSES.filter((s) => s !== "open")) {
      expect(
        authorizeRejectSuggestion({
          actorRole: "maintainer",
          annotationKind: "suggestion",
          annotationStatus: status,
        }),
      ).toMatchObject({ allowed: false, reason: "illegal-transition" });
    }
  });
});

describe("authorizeReopenSuggestion", () => {
  it("allows a maintainer reopening a rejected suggestion", () => {
    expect(
      authorizeReopenSuggestion({
        actorRole: "maintainer",
        annotationKind: "suggestion",
        annotationStatus: "rejected",
      }).allowed,
    ).toBe(true);
  });

  it("denies non-maintainers", () => {
    for (const role of NON_MAINTAINER_ROLES) {
      expect(
        authorizeReopenSuggestion({
          actorRole: role,
          annotationKind: "suggestion",
          annotationStatus: "rejected",
        }),
      ).toMatchObject({ allowed: false, reason: "not-maintainer" });
    }
  });

  it("denies comments even when rejected", () => {
    expect(
      authorizeReopenSuggestion({
        actorRole: "maintainer",
        annotationKind: "comment",
        annotationStatus: "rejected",
      }),
    ).toMatchObject({ allowed: false, reason: "not-a-suggestion" });
  });

  it("denies every non-rejected status (incl. withdrawn: reopen is for rejected only)", () => {
    for (const status of ANNOTATION_STATUSES.filter((s) => s !== "rejected")) {
      expect(
        authorizeReopenSuggestion({
          actorRole: "maintainer",
          annotationKind: "suggestion",
          annotationStatus: status,
        }),
      ).toMatchObject({ allowed: false, reason: "illegal-transition" });
    }
  });
});

describe("authorizeCancelWorkItem", () => {
  it("allows a maintainer cancelling a ready work item", () => {
    expect(
      authorizeCancelWorkItem({ actorRole: "maintainer", workItemStatus: "ready" }).allowed,
    ).toBe(true);
  });

  it("denies non-maintainers before looking at state", () => {
    for (const role of NON_MAINTAINER_ROLES) {
      expect(authorizeCancelWorkItem({ actorRole: role, workItemStatus: "ready" })).toMatchObject({
        allowed: false,
        reason: "not-maintainer",
      });
    }
  });

  it("denies every non-ready status with the state machine's reason", () => {
    for (const status of WORK_ITEM_STATUSES.filter((s) => s !== "ready")) {
      const decision = authorizeCancelWorkItem({
        actorRole: "maintainer",
        workItemStatus: status,
      });
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        // leased -> cancelled is a design edge but Phase 4 (no leases exist yet).
        expect(decision.reason).toBe(status === "leased" ? "phase-not-enabled" : "illegal-transition");
      }
    }
  });
});

describe("authorizeForceCreateWorkItem", () => {
  it("allows a maintainer force-creating from an open suggestion", () => {
    expect(
      authorizeForceCreateWorkItem({
        actorRole: "maintainer",
        annotationKind: "suggestion",
        annotationStatus: "open",
      }).allowed,
    ).toBe(true);
  });

  it("denies non-maintainers", () => {
    for (const role of NON_MAINTAINER_ROLES) {
      expect(
        authorizeForceCreateWorkItem({
          actorRole: role,
          annotationKind: "suggestion",
          annotationStatus: "open",
        }),
      ).toMatchObject({ allowed: false, reason: "not-maintainer" });
    }
  });

  it("allows a maintainer force-creating from an open comment", () => {
    expect(
      authorizeForceCreateWorkItem({
        actorRole: "maintainer",
        annotationKind: "comment",
        annotationStatus: "open",
      }).allowed,
    ).toBe(true);
  });

  it("denies every non-open status (incl. work_item_created: uniqueness, not re-force)", () => {
    for (const status of ANNOTATION_STATUSES.filter((s) => s !== "open")) {
      expect(
        authorizeForceCreateWorkItem({
          actorRole: "maintainer",
          annotationKind: "suggestion",
          annotationStatus: status,
        }),
      ).toMatchObject({ allowed: false, reason: "illegal-transition" });
    }
  });
});
