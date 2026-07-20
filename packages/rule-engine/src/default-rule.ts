import {
  declarativeRuleSchema,
  type DeclarativeRule,
  type WorkItemType,
} from "@authorbot/schemas";

/**
 * The design section 25 default governance rule (Phase 3 contract section 3):
 * approvals ≥ 3, net_score ≥ 2, human_approvals ≥ 1 → create a work item.
 * `RULES_JSON` overrides it; this is what an unconfigured instance runs.
 */

/** Rule key in the instance config `rules` map (design sections 11.1 / 25). */
export const DEFAULT_RULE_NAME = "suggestion_to_work_item";

/**
 * Exactly the section 25 block. `trigger` is omitted there (the schema leaves
 * it optional); `vote_changed` is the only trigger defined for v0.1, and the
 * contract fixes evaluation to it. Parsed through the instance schema at
 * module load so this constant can never drift from the declared shape.
 */
export const DEFAULT_SUGGESTION_TO_WORK_ITEM_RULE: DeclarativeRule = Object.freeze(
  declarativeRuleSchema.parse({
    version: 1,
    when: {
      all: [
        { metric: "approvals", operator: "gte", value: 3 },
        { metric: "net_score", operator: "gte", value: 2 },
        { metric: "human_approvals", operator: "gte", value: 1 },
      ],
    },
    action: {
      type: "create_work_item",
      work_type: "revise_range",
    },
  }),
);

/** Annotation scopes (the `scope` discriminant of `authorbot.annotation/v1`). */
export type AnnotationScope = "range" | "block" | "chapter";

/** Work types a Phase 3 rule action can resolve to. */
export type RevisionWorkType = Extract<
  WorkItemType,
  "revise_range" | "revise_block" | "revise_chapter"
>;

/**
 * Contract section 3: the effective `work_type` resolves by annotation scope
 * (range → revise_range, block → revise_block, chapter → revise_chapter),
 * regardless of the `work_type` written in the rule action.
 */
export const WORK_TYPE_BY_SCOPE: Readonly<Record<AnnotationScope, RevisionWorkType>> =
  Object.freeze({
    range: "revise_range",
    block: "revise_block",
    chapter: "revise_chapter",
  });

export function workTypeForScope(scope: AnnotationScope): RevisionWorkType {
  return WORK_TYPE_BY_SCOPE[scope];
}
