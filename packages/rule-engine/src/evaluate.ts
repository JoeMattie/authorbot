import type { DeclarativeRule, RuleCondition } from "@authorbot/schemas";
import { METRIC_NAMES, type MetricName } from "./metrics.js";

/**
 * Declarative rule evaluation (Phase 3 contract section 3). Rules are data —
 * no user-supplied code, templates, or expressions are ever evaluated. The
 * rule shape is `authorbot.instance/v1` (`@authorbot/schemas`
 * `declarativeRuleSchema`); this module decides whether a metric record
 * satisfies it.
 *
 * Fail-closed policy: a condition naming a metric outside the closed Phase 3
 * vocabulary, a metric absent from the supplied record, or an operator
 * outside the contract's five (`gte|lte|gt|lt|eq`) makes the whole rule
 * unsatisfied — even inside an `any` group whose other conditions pass. A
 * misconfigured rule must never create work items. Note: the instance schema
 * admits `neq` as config shape; the Phase 3 contract does not list it, so
 * evaluation rejects it (fail closed) until a later phase admits it.
 */

/** Operators the Phase 3 contract defines (contract section 3). */
export const RULE_OPERATORS = ["gte", "lte", "gt", "lt", "eq"] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

const OPERATOR_SET: ReadonlySet<string> = new Set(RULE_OPERATORS);
const METRIC_NAME_SET: ReadonlySet<string> = new Set(METRIC_NAMES);

export type ConditionFailureReason =
  | "condition-not-met"
  | "unknown-metric"
  | "missing-metric"
  | "unknown-operator";

/** One unsatisfied (or unevaluable) condition, with the observed value when known. */
export interface ConditionFailure {
  readonly metric: string;
  readonly operator: string;
  readonly value: number;
  /** The metric's actual value; absent when the metric is unknown/missing. */
  readonly actual?: number;
  readonly reason: ConditionFailureReason;
  readonly message: string;
}

export interface EvaluationResult {
  readonly satisfied: boolean;
  /** Empty exactly when `satisfied` is true. */
  readonly failures: readonly ConditionFailure[];
}

function compare(actual: number, operator: RuleOperator, value: number): boolean {
  switch (operator) {
    case "gte":
      return actual >= value;
    case "lte":
      return actual <= value;
    case "gt":
      return actual > value;
    case "lt":
      return actual < value;
    case "eq":
      return actual === value;
  }
}

/** Structural (fail-closed) problem with a condition, or undefined if evaluable. */
function structuralFailure(
  condition: RuleCondition,
  metrics: Readonly<Partial<Record<string, number>>>,
): ConditionFailure | undefined {
  const { metric, operator, value } = condition;
  if (!METRIC_NAME_SET.has(metric)) {
    return {
      metric,
      operator,
      value,
      reason: "unknown-metric",
      message: `metric "${metric}" is not in the Phase 3 vocabulary (${METRIC_NAMES.join(", ")})`,
    };
  }
  if (!OPERATOR_SET.has(operator)) {
    return {
      metric,
      operator,
      value,
      reason: "unknown-operator",
      message: `operator "${operator}" is not supported (${RULE_OPERATORS.join(", ")})`,
    };
  }
  const actual = metrics[metric];
  if (typeof actual !== "number" || !Number.isFinite(actual)) {
    return {
      metric,
      operator,
      value,
      reason: "missing-metric",
      message: `metric "${metric}" is absent from the supplied metric record`,
    };
  }
  return undefined;
}

function notMet(condition: RuleCondition, actual: number): ConditionFailure {
  return {
    metric: condition.metric,
    operator: condition.operator,
    value: condition.value,
    actual,
    reason: "condition-not-met",
    message: `${condition.metric} = ${actual} does not satisfy ${condition.operator} ${condition.value}`,
  };
}

/**
 * Evaluate a rule against a metric record (typically the output of
 * `computeVoteMetrics`; a partial record is tolerated and fails closed via
 * `missing-metric`).
 *
 * - `when.all`: satisfied iff every condition holds; failures list the
 *   conditions that do not.
 * - `when.any`: satisfied iff at least one condition holds; when none does,
 *   failures list every condition.
 * - Any structural problem (unknown metric/operator, missing metric) anywhere
 *   in the group ⇒ unsatisfied, with only the structural failures reported.
 */
export function evaluate(
  rule: DeclarativeRule,
  metrics: Readonly<Partial<Record<string, number>>>,
): EvaluationResult {
  const isAll = "all" in rule.when;
  const conditions: readonly RuleCondition[] = isAll
    ? (rule.when as { all: RuleCondition[] }).all
    : (rule.when as { any: RuleCondition[] }).any;

  const structural = conditions
    .map((condition) => structuralFailure(condition, metrics))
    .filter((failure): failure is ConditionFailure => failure !== undefined);
  if (structural.length > 0) {
    return { satisfied: false, failures: structural };
  }

  const unmet: ConditionFailure[] = [];
  let anyMet = false;
  for (const condition of conditions) {
    // Safe: structural pass proved metric presence and operator membership.
    const actual = metrics[condition.metric as MetricName] as number;
    if (compare(actual, condition.operator as RuleOperator, condition.value)) {
      anyMet = true;
    } else {
      unmet.push(notMet(condition, actual));
    }
  }

  if (isAll) {
    return { satisfied: unmet.length === 0, failures: unmet };
  }
  return anyMet ? { satisfied: true, failures: [] } : { satisfied: false, failures: unmet };
}
