/**
 * Rule configuration. **Amended by Phase 6 contract §3.6**: governance rules
 * live in `book.yml` under `governance.rules`, "so they are versioned,
 * diffable, and reviewable alongside the prose they govern - and therefore
 * editable [in Settings]. The environment variable remains as a bootstrap
 * default for a book that has not set them."
 *
 * The resulting precedence, highest first:
 *
 * 1. `book.yml` `governance.rules` - the book's own governance.
 * 2. `RULES_JSON` - a JSON object in the exact shape of the
 *    `authorbot.instance/v1` `rules` section, validated against that schema
 *    **at boot**: an invalid value throws from `createApi`, never degrades to
 *    the default at runtime.
 * 3. The built-in default rule (design §25 plus the §3.6 human-maintainer
 *    clause).
 *
 * Levels 2 and 3 are resolved once at boot; level 1 is resolved per request,
 * because a maintainer editing the rule must see it take effect on the next
 * vote rather than on the next deploy.
 *
 * Governance never degrades silently. A stored config that cannot be read as
 * rules throws rather than falling back - falling back would quietly *weaken*
 * a book's governance, which is precisely the failure this system must not
 * have.
 */
import { z } from "zod";
import { bookConfigSchema } from "@authorbot/schemas";
import {
  DEFAULT_RULE_NAME,
  DEFAULT_SUGGESTION_TO_WORK_ITEM_RULE,
  declarativeRuleSchema,
  type DeclarativeRule,
} from "@authorbot/rule-engine";

export interface RuleEntry {
  /** Rule name (the key in the config mapping) - recorded on decisions. */
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

/**
 * The rules a book config declares, or `null` when it declares none.
 *
 * `null` is the "not configured, fall back" signal and is returned only for an
 * absent `governance` section or an absent `governance.rules`. An explicit
 * empty map cannot occur - `bookConfigSchema` rejects it - so there is no way
 * for a book to end up governed by zero rules by accident.
 *
 * Throws if `config` is not a valid `authorbot.book/v1` document. The caller
 * has always validated it before storing, so this is defence in depth against
 * a corrupted projection row, and it is deliberately loud.
 */
export function ruleEntriesFromBookConfig(config: unknown): RuleEntry[] | null {
  const parsed = bookConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(
      `stored book config failed authorbot.book/v1 validation: ${formatIssues(parsed.error.issues)}`,
    );
  }
  const rules = parsed.data.governance?.rules;
  if (rules === undefined) {
    return null;
  }
  return Object.entries(rules).map(([name, rule]) => ({ name, rule }));
}

/**
 * Effective rules for a request: the book's own `governance.rules` when it has
 * them, otherwise the boot-time entries (`RULES_JSON`, else the default).
 *
 * `bookConfig` is `null` when the project has no projected `book.yml` at all -
 * a book created before Phase 6, or one whose projection has not run yet.
 * Those books keep working on the bootstrap default exactly as they did, which
 * is the compatibility requirement §3.6 states.
 */
export function resolveRuleEntries(
  bookConfig: unknown | null,
  bootstrap: readonly RuleEntry[],
): RuleEntry[] {
  if (bookConfig === null || bookConfig === undefined) {
    return [...bootstrap];
  }
  return ruleEntriesFromBookConfig(bookConfig) ?? [...bootstrap];
}

function formatIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}
