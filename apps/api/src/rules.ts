/**
 * Rule configuration (Phase 3 contract §3): rules come from the `RULES_JSON`
 * env — a JSON object in the exact shape of the `authorbot.instance/v1`
 * `rules` section (`{ "<rule_name>": { version, when, action } }`) — and are
 * validated against that schema **at boot**: an invalid value throws from
 * `createApi`, never degrades to the default at runtime. Absent/empty
 * `RULES_JSON` selects the design §25 default (approvals ≥ 3, net ≥ 2,
 * human_approvals ≥ 1 → create_work_item).
 */
import { z } from "zod";
import {
  DEFAULT_RULE_NAME,
  DEFAULT_SUGGESTION_TO_WORK_ITEM_RULE,
  declarativeRuleSchema,
  type DeclarativeRule,
} from "@authorbot/rule-engine";

export interface RuleEntry {
  /** Rule name (the key in the config mapping) — recorded on decisions. */
  readonly name: string;
  readonly rule: DeclarativeRule;
}

/** The `rules` mapping shape from `authorbot.instance/v1` (schemas package). */
const rulesConfigSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9_]*$/), declarativeRuleSchema)
  .refine((rules) => Object.keys(rules).length > 0, "RULES_JSON must define at least one rule");

/**
 * Parse and validate `RULES_JSON` (boot-time; throws on any invalid input).
 * Returns the configured rule entries, or the §25 default when unset.
 */
export function parseRuleEntries(rulesJson: string | undefined): RuleEntry[] {
  if (rulesJson === undefined || rulesJson.trim().length === 0) {
    return [{ name: DEFAULT_RULE_NAME, rule: DEFAULT_SUGGESTION_TO_WORK_ITEM_RULE }];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rulesJson);
  } catch {
    throw new Error("RULES_JSON is not valid JSON");
  }
  const parsed = rulesConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`RULES_JSON failed authorbot.instance/v1 rules validation: ${issues}`);
  }
  return Object.entries(parsed.data).map(([name, rule]) => ({ name, rule }));
}
