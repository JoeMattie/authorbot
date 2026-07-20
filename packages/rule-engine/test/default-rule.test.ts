import { describe, expect, it } from "vitest";
import { declarativeRuleSchema } from "@authorbot/schemas";
import {
  DEFAULT_RULE_NAME,
  DEFAULT_SUGGESTION_TO_WORK_ITEM_RULE,
  WORK_TYPE_BY_SCOPE,
  computeVoteMetrics,
  evaluate,
  workTypeForScope,
  type VoteTuple,
} from "../src/index.js";

const h = (value: VoteTuple["value"]): VoteTuple => ({ value, actorType: "human" });
const a = (value: VoteTuple["value"]): VoteTuple => ({ value, actorType: "agent" });

/**
 * Curated tally fixtures for the design section 25 default rule
 * (approvals ≥ 3, net_score ≥ 2, human_approvals ≥ 1).
 */
const TALLIES: ReadonlyArray<{
  name: string;
  votes: readonly VoteTuple[];
  satisfied: boolean;
  failingMetrics?: readonly string[];
}> = [
  {
    name: "exact boundary on every condition: 3 approvals (1 human), 1 rejection → net exactly 2",
    votes: [h("approve"), a("approve"), a("approve"), a("reject")],
    satisfied: true,
  },
  {
    name: "minimum satisfying tally: 3 approvals (1 human), no rejections → net 3",
    votes: [h("approve"), a("approve"), a("approve")],
    satisfied: true,
  },
  {
    name: "minimum passing with dissent: 4 approvals (1 human), 2 rejections → net 2",
    votes: [h("approve"), a("approve"), a("approve"), a("approve"), a("reject"), h("reject")],
    satisfied: true,
  },
  {
    name: "no votes at all",
    votes: [],
    satisfied: false,
    failingMetrics: ["approvals", "net_score", "human_approvals"],
  },
  {
    name: "agent-only consensus: 5 agent approvals, no human",
    votes: [a("approve"), a("approve"), a("approve"), a("approve"), a("approve")],
    satisfied: false,
    failingMetrics: ["human_approvals"],
  },
  {
    name: "too few approvals: 2 approvals incl. a human",
    votes: [h("approve"), a("approve")],
    satisfied: false,
    failingMetrics: ["approvals"],
  },
  {
    name: "net score dragged below 2: 3 approvals, 2 rejections",
    votes: [h("approve"), a("approve"), a("approve"), a("reject"), h("reject")],
    satisfied: false,
    failingMetrics: ["net_score"],
  },
  {
    name: "abstentions are neutral: 3 approvals (1 human) + 4 abstentions",
    votes: [h("approve"), a("approve"), a("approve"), h("abstain"), a("abstain"), a("abstain"), h("abstain")],
    satisfied: true,
  },
  {
    name: "system approvals do not satisfy the human requirement",
    votes: [
      { value: "approve", actorType: "system" },
      a("approve"),
      a("approve"),
    ],
    satisfied: false,
    failingMetrics: ["human_approvals"],
  },
  {
    name: "heavy rejection: 3 approvals (1 human), 5 rejections → net −2",
    votes: [h("approve"), a("approve"), a("approve"), h("reject"), h("reject"), a("reject"), a("reject"), a("reject")],
    satisfied: false,
    failingMetrics: ["net_score"],
  },
];

describe("design section 25 default rule", () => {
  it("is a valid authorbot.instance/v1 rule named suggestion_to_work_item", () => {
    expect(DEFAULT_RULE_NAME).toBe("suggestion_to_work_item");
    expect(() => declarativeRuleSchema.parse(DEFAULT_SUGGESTION_TO_WORK_ITEM_RULE)).not.toThrow();
    expect(DEFAULT_SUGGESTION_TO_WORK_ITEM_RULE).toMatchObject({
      version: 1,
      action: { type: "create_work_item", work_type: "revise_range" },
    });
    expect(Object.isFrozen(DEFAULT_SUGGESTION_TO_WORK_ITEM_RULE)).toBe(true);
  });

  for (const tally of TALLIES) {
    it(`${tally.name} → ${tally.satisfied ? "satisfied" : "not satisfied"}`, () => {
      const metrics = computeVoteMetrics(tally.votes);
      const result = evaluate(DEFAULT_SUGGESTION_TO_WORK_ITEM_RULE, metrics);
      expect(result.satisfied).toBe(tally.satisfied);
      if (tally.satisfied) {
        expect(result.failures).toEqual([]);
      } else {
        expect(result.failures.map((f) => f.metric).sort()).toEqual(
          [...(tally.failingMetrics ?? [])].sort(),
        );
        for (const failure of result.failures) {
          expect(failure.reason).toBe("condition-not-met");
        }
      }
    });
  }
});

describe("workTypeForScope (contract section 3 resolution)", () => {
  it("maps every annotation scope to its revise_* work type", () => {
    expect(workTypeForScope("range")).toBe("revise_range");
    expect(workTypeForScope("block")).toBe("revise_block");
    expect(workTypeForScope("chapter")).toBe("revise_chapter");
    expect(Object.keys(WORK_TYPE_BY_SCOPE).sort()).toEqual(["block", "chapter", "range"]);
  });
});
