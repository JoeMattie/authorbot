import { describe, expect, it } from "vitest";
import {
  DECISION_RESULTS,
  DECISION_SUPPORT_CHANGED_EVENT,
  decisionResultSchema,
  resolveSupportChange,
} from "../src/index.js";

describe("decision result enum (Phase 0 contract section 4)", () => {
  it("is exactly the four contract results", () => {
    expect([...DECISION_RESULTS]).toEqual([
      "create_work_item",
      "rejected",
      "support_changed",
      "overridden",
    ]);
  });

  it("schema rejects anything outside the enum", () => {
    expect(decisionResultSchema.safeParse("create_work_item").success).toBe(true);
    expect(decisionResultSchema.safeParse("deleted").success).toBe(false);
  });
});

describe("resolveSupportChange (design section 11.3 sticky semantics)", () => {
  it("marks when support falls away from an unmarked decision", () => {
    expect(resolveSupportChange({ supportChanged: false, ruleSatisfied: false })).toEqual({
      supportChanged: true,
      transition: "marked",
      emitEvent: true,
    });
  });

  it("clears when support returns to a marked decision", () => {
    expect(resolveSupportChange({ supportChanged: true, ruleSatisfied: true })).toEqual({
      supportChanged: false,
      transition: "cleared",
      emitEvent: true,
    });
  });

  it("no-ops (no event) while support persists", () => {
    expect(resolveSupportChange({ supportChanged: false, ruleSatisfied: true })).toEqual({
      supportChanged: false,
      transition: "unchanged",
      emitEvent: false,
    });
  });

  it("no-ops (no event) while support remains withdrawn", () => {
    expect(resolveSupportChange({ supportChanged: true, ruleSatisfied: false })).toEqual({
      supportChanged: true,
      transition: "unchanged",
      emitEvent: false,
    });
  });

  it("mark then clear round-trips (flip emits each time, steady state does not)", () => {
    let marked = false;
    const drop = resolveSupportChange({ supportChanged: marked, ruleSatisfied: false });
    marked = drop.supportChanged;
    expect(drop.emitEvent).toBe(true);
    const still = resolveSupportChange({ supportChanged: marked, ruleSatisfied: false });
    expect(still.emitEvent).toBe(false);
    const back = resolveSupportChange({ supportChanged: marked, ruleSatisfied: true });
    expect(back).toMatchObject({ supportChanged: false, transition: "cleared", emitEvent: true });
  });

  it("the event name matches the Phase 3 SSE vocabulary", () => {
    expect(DECISION_SUPPORT_CHANGED_EVENT).toBe("decision_support_changed");
  });
});
