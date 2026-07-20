export {
  EMPTY_VOTE_METRICS,
  METRIC_NAMES,
  VOTE_VALUES,
  VOTER_ACTOR_TYPES,
  computeVoteMetrics,
} from "./metrics.js";
export type {
  MetricName,
  VoteMetrics,
  VoteTuple,
  VoteValue,
  VoterActorType,
} from "./metrics.js";

export { RULE_OPERATORS, evaluate } from "./evaluate.js";
export type {
  ConditionFailure,
  ConditionFailureReason,
  EvaluationResult,
  RuleOperator,
} from "./evaluate.js";

export {
  DEFAULT_RULE_NAME,
  DEFAULT_SUGGESTION_TO_WORK_ITEM_RULE,
  WORK_TYPE_BY_SCOPE,
  workTypeForScope,
} from "./default-rule.js";
export type { AnnotationScope, RevisionWorkType } from "./default-rule.js";

// Rule shape re-exports so consumers need not depend on schemas separately.
export {
  declarativeRuleSchema,
  ruleActionSchema,
  ruleConditionSchema,
  ruleWhenSchema,
} from "@authorbot/schemas";
export type {
  DeclarativeRule,
  RuleAction,
  RuleCondition,
  RuleWhen,
} from "@authorbot/schemas";
