import { describe, expect, it } from "vitest";
import type { DeclarativeRule, RuleCondition } from "@authorbot/schemas";
import {
  EMPTY_VOTE_METRICS,
  RULE_OPERATORS,
  evaluate,
  type RuleOperator,
} from "../src/index.js";

function rule(
  when: { all: RuleCondition[] } | { any: RuleCondition[] },
): DeclarativeRule {
  return {
    version: 1,
    when,
    action: { type: "create_work_item", work_type: "revise_range" },
  };
}

function allOf(...conditions: RuleCondition[]): DeclarativeRule {
  return rule({ all: conditions });
}

function anyOf(...conditions: RuleCondition[]): DeclarativeRule {
  return rule({ any: conditions });
}

const metricsWith = (overrides: Partial<Record<string, number>>) => ({
  ...EMPTY_VOTE_METRICS,
  ...overrides,
});

describe("evaluate: operators and boundaries", () => {
  // Every operator against below / equal / above the threshold value.
  const cases: Record<RuleOperator, [below: boolean, equal: boolean, above: boolean]> = {
    gte: [false, true, true],
    lte: [true, true, false],
    gt: [false, false, true],
    lt: [true, false, false],
    eq: [false, true, false],
  };

  for (const operator of RULE_OPERATORS) {
    const [below, equal, above] = cases[operator];
    for (const [label, actual, expected] of [
      ["below (2 vs 3)", 2, below],
      ["equal (3 vs 3)", 3, equal],
      ["above (4 vs 3)", 4, above],
    ] as const) {
      it(`${operator} ${label} → ${expected}`, () => {
        const result = evaluate(
          allOf({ metric: "approvals", operator, value: 3 }),
          metricsWith({ approvals: actual }),
        );
        expect(result.satisfied).toBe(expected);
        if (expected) {
          expect(result.failures).toEqual([]);
        } else {
          expect(result.failures).toHaveLength(1);
          expect(result.failures[0]).toMatchObject({
            metric: "approvals",
            operator,
            value: 3,
            actual,
            reason: "condition-not-met",
          });
        }
      });
    }
  }

  it("eq is exact (no tolerance)", () => {
    const condition: RuleCondition = { metric: "net_score", operator: "eq", value: 0 };
    expect(evaluate(allOf(condition), metricsWith({ net_score: 0 })).satisfied).toBe(true);
    expect(evaluate(allOf(condition), metricsWith({ net_score: -1 })).satisfied).toBe(false);
    expect(evaluate(allOf(condition), metricsWith({ net_score: 1 })).satisfied).toBe(false);
  });

  it("comparisons handle zero and negative values", () => {
    expect(
      evaluate(
        allOf({ metric: "net_score", operator: "gte", value: -2 }),
        metricsWith({ net_score: -1 }),
      ).satisfied,
    ).toBe(true);
    expect(
      evaluate(
        allOf({ metric: "net_score", operator: "lt", value: 0 }),
        metricsWith({ net_score: -1 }),
      ).satisfied,
    ).toBe(true);
  });
});

describe("evaluate: all / any groups", () => {
  const a: RuleCondition = { metric: "approvals", operator: "gte", value: 3 };
  const b: RuleCondition = { metric: "human_approvals", operator: "gte", value: 1 };

  it("all: satisfied only when every condition holds", () => {
    expect(
      evaluate(allOf(a, b), metricsWith({ approvals: 3, human_approvals: 1 })).satisfied,
    ).toBe(true);
    const partial = evaluate(allOf(a, b), metricsWith({ approvals: 3, human_approvals: 0 }));
    expect(partial.satisfied).toBe(false);
    expect(partial.failures).toHaveLength(1);
    expect(partial.failures[0]).toMatchObject({ metric: "human_approvals" });
  });

  it("all: lists every unmet condition", () => {
    const result = evaluate(allOf(a, b), EMPTY_VOTE_METRICS);
    expect(result.satisfied).toBe(false);
    expect(result.failures.map((f) => f.metric)).toEqual(["approvals", "human_approvals"]);
  });

  it("any: one holding condition satisfies", () => {
    const result = evaluate(anyOf(a, b), metricsWith({ approvals: 0, human_approvals: 1 }));
    expect(result.satisfied).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("any: none holding lists every condition", () => {
    const result = evaluate(anyOf(a, b), EMPTY_VOTE_METRICS);
    expect(result.satisfied).toBe(false);
    expect(result.failures.map((f) => f.reason)).toEqual([
      "condition-not-met",
      "condition-not-met",
    ]);
  });
});

describe("evaluate: fail closed", () => {
  it("unknown metric → unsatisfied with unknown-metric failure, no actual", () => {
    const result = evaluate(
      allOf({ metric: "proposal_age", operator: "gte", value: 1 }),
      EMPTY_VOTE_METRICS,
    );
    expect(result.satisfied).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      metric: "proposal_age",
      reason: "unknown-metric",
    });
    expect(result.failures[0]).not.toHaveProperty("actual");
  });

  it("unknown operator (incl. schema-shaped neq) → unsatisfied", () => {
    for (const operator of ["neq", "between", ">="] as const) {
      const result = evaluate(
        allOf({ metric: "approvals", operator, value: 0 } as unknown as RuleCondition),
        metricsWith({ approvals: 5 }),
      );
      expect(result.satisfied).toBe(false);
      expect(result.failures[0]).toMatchObject({ reason: "unknown-operator", operator });
    }
  });

  it("known metric missing from a partial record → missing-metric", () => {
    const result = evaluate(
      allOf({ metric: "net_score", operator: "gte", value: 0 }),
      { approvals: 3 },
    );
    expect(result.satisfied).toBe(false);
    expect(result.failures[0]).toMatchObject({ metric: "net_score", reason: "missing-metric" });
  });

  it("non-finite metric value → missing-metric", () => {
    const result = evaluate(
      allOf({ metric: "approvals", operator: "gte", value: 0 }),
      { approvals: Number.NaN },
    );
    expect(result.satisfied).toBe(false);
    expect(result.failures[0]).toMatchObject({ reason: "missing-metric" });
  });

  it("a structural failure poisons an any group even when a sibling passes", () => {
    const result = evaluate(
      anyOf(
        { metric: "approvals", operator: "gte", value: 1 },
        { metric: "maintainer_veto", operator: "eq", value: 0 },
      ),
      metricsWith({ approvals: 5 }),
    );
    expect(result.satisfied).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ reason: "unknown-metric" });
  });

  it("a structural failure in an all group reports only structural failures", () => {
    const result = evaluate(
      allOf(
        { metric: "approvals", operator: "gte", value: 99 },
        { metric: "weighted_score", operator: "gte", value: 1 },
      ),
      metricsWith({ approvals: 0 }),
    );
    expect(result.satisfied).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ metric: "weighted_score", reason: "unknown-metric" });
  });
});
