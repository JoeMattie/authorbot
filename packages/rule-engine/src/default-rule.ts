import {
  declarativeRuleSchema,
  type DeclarativeRule,
  type WorkItemType,
} from "@authorbot/schemas";

/**
 * The default governance rule: the design section 25 block (approvals ≥ 3,
 * net_score ≥ 2, human_approvals ≥ 1) **plus** the Phase 6 contract section
 * 3.6 amendment `human_maintainer_approvals >= 1` — nothing becomes work on
 * the author's book without the author agreeing to it.
 *
 * `book.yml`'s `governance.rules` overrides it, `RULES_JSON` overrides it as a
 * bootstrap default; this is what an otherwise unconfigured instance runs.
 */

/** Rule key in the instance config `rules` map (design sections 11.1 / 25). */
export const DEFAULT_RULE_NAME = "suggestion_to_work_item";

/**
 * `trigger` is omitted (the schema leaves it optional); `vote_changed` is the
 * only trigger defined for v0.1, and the contract fixes evaluation to it.
 * Parsed through the instance schema at module load so this constant can never
 * drift from the declared shape.
 *
 * **`version: 2`, not 1.** Adding the human-maintainer clause is a rule change,
 * and Phase 3's decision uniqueness key is
 * `(source_annotation_id, action_type, rule_version)` — leaving the version at
 * 1 would make the old and new rules indistinguishable in the decision record,
 * so a decision could not be read back to the rule that produced it. Bumping is
 * safe for books that already crossed under version 1: their decision rows
 * remain, and the vote path refuses to create a second work item while ANY
 * `create_work_item` decision exists for the annotation, whatever its version.
 */
export const DEFAULT_SUGGESTION_TO_WORK_ITEM_RULE: DeclarativeRule = Object.freeze(
  declarativeRuleSchema.parse({
    version: 2,
    when: {
      all: [
        { metric: "approvals", operator: "gte", value: 3 },
        { metric: "net_score", operator: "gte", value: 2 },
        { metric: "human_approvals", operator: "gte", value: 1 },
        { metric: "human_maintainer_approvals", operator: "gte", value: 1 },
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
