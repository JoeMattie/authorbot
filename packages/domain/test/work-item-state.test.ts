import { describe, expect, it } from "vitest";
import {
  PHASE3_WORK_ITEM_STATUSES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TRANSITIONS,
  canTransitionWorkItem,
  isPhase3WorkItemStatus,
  transitionWorkItem,
  type WorkItemStatus,
} from "../src/index.js";

/** The full design section 9.5 graph, spelled out independently of the impl. */
const DESIGN_EDGES: ReadonlyArray<[WorkItemStatus, WorkItemStatus]> = [
  ["ready", "leased"],
  ["ready", "cancelled"],
  ["leased", "ready"],
  ["leased", "submitted"],
  ["leased", "cancelled"],
  ["submitted", "ready"],
  ["submitted", "applying"],
  ["submitted", "failed"],
  ["applying", "completed"],
  ["applying", "conflict"],
  ["conflict", "ready"],
];

const hasDesignEdge = (from: WorkItemStatus, to: WorkItemStatus): boolean =>
  DESIGN_EDGES.some(([f, t]) => f === from && t === to);

describe("work-item state machine (design section 9.5)", () => {
  it("declares every status from the schemas package", () => {
    expect(Object.keys(WORK_ITEM_TRANSITIONS).sort()).toEqual([...WORK_ITEM_STATUSES].sort());
  });

  it("completed, failed, and cancelled are terminal", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      expect(WORK_ITEM_TRANSITIONS[status]).toEqual([]);
    }
  });

  // Exhaustive: the full graph matches design section 9.5 edge-for-edge.
  for (const from of WORK_ITEM_STATUSES) {
    for (const to of WORK_ITEM_STATUSES) {
      const legal = hasDesignEdge(from, to);
      it(`graph: ${from} -> ${to} is ${legal ? "an edge" : "not an edge"}`, () => {
        expect(canTransitionWorkItem(from, to)).toBe(legal);
      });
    }
  }
});

describe("transitionWorkItem (Phase 3 gate: work items stop at ready)", () => {
  it("Phase 3 statuses are exactly ready and cancelled", () => {
    expect([...PHASE3_WORK_ITEM_STATUSES]).toEqual(["ready", "cancelled"]);
    for (const status of WORK_ITEM_STATUSES) {
      expect(isPhase3WorkItemStatus(status)).toBe(status === "ready" || status === "cancelled");
    }
  });

  it("ready -> cancelled is the only executable transition", () => {
    expect(transitionWorkItem("ready", "cancelled")).toEqual({ allowed: true });
  });

  // Exhaustive: every ordered pair, distinguishing the two denial reasons.
  for (const from of WORK_ITEM_STATUSES) {
    for (const to of WORK_ITEM_STATUSES) {
      const inGraph = hasDesignEdge(from, to);
      const enabled = inGraph && from === "ready" && to === "cancelled";
      const expected = enabled
        ? "allowed"
        : inGraph
          ? "phase-not-enabled"
          : "illegal-transition";
      it(`${from} -> ${to} is ${expected}`, () => {
        const decision = transitionWorkItem(from, to);
        expect(decision.allowed).toBe(enabled);
        if (!decision.allowed) {
          expect(decision.reason).toBe(expected);
          expect(decision.message).toContain(from);
          expect(decision.message).toContain(to);
        }
      });
    }
  }

  it("gated denials say Phase 4, so callers can surface honest errors", () => {
    const decision = transitionWorkItem("ready", "leased");
    expect(decision).toMatchObject({ allowed: false, reason: "phase-not-enabled" });
    if (!decision.allowed) {
      expect(decision.message).toContain("Phase 4");
    }
  });
});
