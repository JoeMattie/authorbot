import { describe, expect, it } from "vitest";
import {
  VOTE_VALUES,
  authorizeVote,
  castVoteCommandSchema,
  clearVoteCommandSchema,
  voteValueSchema,
} from "../src/index.js";

const ANNOTATION_ID = "0190f300-2f7e-7467-b288-5e3c5a4bd991";

describe("vote value enum", () => {
  it("is exactly approve|reject|abstain (design section 25)", () => {
    expect([...VOTE_VALUES]).toEqual(["approve", "reject", "abstain"]);
  });

  for (const value of VOTE_VALUES) {
    it(`accepts "${value}"`, () => {
      expect(voteValueSchema.parse(value)).toBe(value);
    });
  }

  for (const bad of ["upvote", "Approve", "APPROVE", "", "yes", 1, null]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(voteValueSchema.safeParse(bad).success).toBe(false);
    });
  }
});

describe("castVoteCommandSchema", () => {
  it("accepts a valid command", () => {
    const parsed = castVoteCommandSchema.parse({
      annotationId: ANNOTATION_ID,
      value: "approve",
    });
    expect(parsed).toEqual({ annotationId: ANNOTATION_ID, value: "approve" });
  });

  it("rejects a non-UUIDv7 annotation id", () => {
    expect(
      castVoteCommandSchema.safeParse({
        annotationId: "not-a-uuid",
        value: "approve",
      }).success,
    ).toBe(false);
  });

  it("rejects a missing value", () => {
    expect(castVoteCommandSchema.safeParse({ annotationId: ANNOTATION_ID }).success).toBe(false);
  });

  it("is strict: unknown keys are rejected", () => {
    expect(
      castVoteCommandSchema.safeParse({
        annotationId: ANNOTATION_ID,
        value: "approve",
        weight: 2,
      }).success,
    ).toBe(false);
  });
});

describe("clearVoteCommandSchema", () => {
  it("accepts the route param alone", () => {
    expect(clearVoteCommandSchema.parse({ annotationId: ANNOTATION_ID })).toEqual({
      annotationId: ANNOTATION_ID,
    });
  });

  it("is strict: a body value on DELETE is rejected", () => {
    expect(
      clearVoteCommandSchema.safeParse({ annotationId: ANNOTATION_ID, value: "approve" }).success,
    ).toBe(false);
  });
});

describe("authorizeVote (comment and suggestion vote resource)", () => {
  it("allows voting on a suggestion", () => {
    expect(authorizeVote({ annotationKind: "suggestion" }).allowed).toBe(true);
  });

  it("allows voting on a comment (the API keeps it out of Work governance)", () => {
    expect(authorizeVote({ annotationKind: "comment" }).allowed).toBe(true);
  });
});
