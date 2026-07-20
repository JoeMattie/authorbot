import { describe, expect, it } from "vitest";
import {
  PHASE4_WORK_ITEM_STATUSES,
  WORK_ITEM_STATUSES,
  WORK_ITEM_TRANSITIONS,
  WORK_ITEM_TRIGGERS,
  WORK_ITEM_TRIGGER_EDGES,
  applyWorkItemTrigger,
  canTransitionWorkItem,
  isWorkItemTerminal,
  transitionWorkItemPhase4,
  type WorkItemStatus,
  type WorkItemTrigger,
} from "../src/index.js";

/** The full design section 9.5 graph, spelled out independently of the impl. */
const DESIGN_EDGES: ReadonlyArray<[WorkItemStatus, WorkItemStatus]> = [
  ["ready", "leased"],
  ["ready", "cancelled"],
  ["leased", "ready"],
  ["leased", "submitted"],
  ["leased", "cancelled"],
  ["submitted", "applying"],
  ["submitted", "failed"],
  ["applying", "completed"],
  ["applying", "conflict"],
  ["conflict", "ready"],
];

const hasDesignEdge = (from: WorkItemStatus, to: WorkItemStatus): boolean =>
  DESIGN_EDGES.some(([f, t]) => f === from && t === to);

/** Design section 9.5 labels, spelled out independently of the impl. */
const DESIGN_LABELLED_EDGES: ReadonlyArray<
  [WorkItemTrigger, WorkItemStatus, WorkItemStatus]
> = [
  ["claim", "ready", "leased"],
  ["expire", "leased", "ready"], // expiry back-edge
  ["release", "leased", "ready"], // release back-edge
  ["submit", "leased", "submitted"],
  ["validation_passed", "submitted", "applying"],
  ["validation_failed", "submitted", "failed"],
  ["apply_succeeded", "applying", "completed"],
  ["apply_conflicted", "applying", "conflict"],
  ["conflict_resolution_prepared", "conflict", "ready"],
  ["cancel", "ready", "cancelled"],
  ["cancel", "leased", "cancelled"],
];

describe("transitionWorkItemPhase4 (full design section 9.5, gate lifted)", () => {
  it("Phase 4 statuses are all eight statuses", () => {
    expect([...PHASE4_WORK_ITEM_STATUSES]).toEqual([...WORK_ITEM_STATUSES]);
  });

  // Exhaustive: every ordered pair; allowed iff it is a design edge.
  for (const from of WORK_ITEM_STATUSES) {
    for (const to of WORK_ITEM_STATUSES) {
      const legal = hasDesignEdge(from, to);
      it(`${from} -> ${to} is ${legal ? "allowed" : "illegal-transition"}`, () => {
        const decision = transitionWorkItemPhase4(from, to);
        expect(decision.allowed).toBe(legal);
        if (!decision.allowed) {
          expect(decision.reason).toBe("illegal-transition");
          expect(decision.message).toContain(from);
          expect(decision.message).toContain(to);
        }
      });
    }
  }

  it("never disagrees with the phase-agnostic graph", () => {
    for (const from of WORK_ITEM_STATUSES) {
      for (const to of WORK_ITEM_STATUSES) {
        expect(transitionWorkItemPhase4(from, to).allowed).toBe(canTransitionWorkItem(from, to));
      }
    }
  });
});

describe("work-item triggers (labelled design section 9.5 edges)", () => {
  it("trigger edges are exactly the design's labelled arrows", () => {
    const declared = WORK_ITEM_TRIGGERS.flatMap((trigger) =>
      WORK_ITEM_TRIGGER_EDGES[trigger].map(
        ([from, to]) => `${trigger}:${from}->${to}`,
      ),
    );
    const expected = DESIGN_LABELLED_EDGES.map(
      ([trigger, from, to]) => `${trigger}:${from}->${to}`,
    );
    expect(declared.sort()).toEqual(expected.sort());
  });

  it("every trigger edge is a graph edge, and every graph edge has a trigger", () => {
    const triggered = new Set(
      WORK_ITEM_TRIGGERS.flatMap((trigger) =>
        WORK_ITEM_TRIGGER_EDGES[trigger].map(([from, to]) => `${from}->${to}`),
      ),
    );
    for (const edge of triggered) {
      const [from, to] = edge.split("->") as [WorkItemStatus, WorkItemStatus];
      expect(canTransitionWorkItem(from, to)).toBe(true);
    }
    for (const [from, to] of DESIGN_EDGES) {
      expect(triggered.has(`${from}->${to}`)).toBe(true);
    }
  });

  // Exhaustive: every trigger x status pair is deterministic.
  for (const trigger of WORK_ITEM_TRIGGERS) {
    for (const status of WORK_ITEM_STATUSES) {
      const match = DESIGN_LABELLED_EDGES.find(([t, f]) => t === trigger && f === status);
      const expected = match?.[2];
      it(`${trigger} on ${status} ${expected ? `-> ${expected}` : "is illegal"}`, () => {
        const result = applyWorkItemTrigger(status, trigger);
        if (expected === undefined) {
          expect(result).toMatchObject({ allowed: false, reason: "illegal-transition" });
          if (!result.allowed) {
            expect(result.message).toContain(trigger);
            expect(result.message).toContain(status);
          }
        } else {
          expect(result).toEqual({ allowed: true, next: expected });
        }
      });
    }
  }
});

describe("isWorkItemTerminal", () => {
  for (const status of WORK_ITEM_STATUSES) {
    const terminal = WORK_ITEM_TRANSITIONS[status].length === 0;
    it(`${status} is ${terminal ? "terminal" : "not terminal"}`, () => {
      expect(isWorkItemTerminal(status)).toBe(terminal);
      expect(terminal).toBe(
        status === "completed" || status === "failed" || status === "cancelled",
      );
    });
  }
});
