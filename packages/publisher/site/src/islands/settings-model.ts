/**
 * Pure logic behind `<authorbot-settings>` (Phase 6 contract §3.6).
 *
 * No DOM, no network: this module is the part of book settings that can be
 * reasoned about - and unit-tested - on its own. Two jobs.
 *
 * **1. The minimal patch.** `PATCH .../settings` is a read-modify-write of
 * `book.yml` that lands as a commit, and the API distinguishes `null` (clear
 * this optional field) from absent (leave it alone). So the view must send
 * exactly the fields the maintainer actually changed: an untouched save has to
 * be a no-op rather than an empty commit, and a guarded field must count as
 * "changed" only when its value really differs - otherwise re-saving a form
 * would demand confirmation for a slug nobody touched.
 *
 * **2. Author-facing governance.** The contract asks for the vote rule "in
 * author-facing terms ('how many approvals before a suggestion becomes work?'),
 * with each requirement explained rather than merely rendered". A settings view
 * that prints `human_maintainer_approvals >= 1` has rendered the rule and
 * explained nothing. The translation lives here so the wording is testable
 * without a browser.
 *
 * The `maintainer_approvals` / `human_maintainer_approvals` distinction gets
 * the longest explanation deliberately: Phase 7 lets an author grant maintainer
 * role to their own agent tokens, so a plain `maintainer_approvals` clause can
 * be satisfied by an agent the author owns. Counting only humans is the thing
 * that stops a book manufacturing its own consensus, and an author deciding
 * whether to keep the clause cannot make that call without being told.
 */
import type { SettingsDocument, SettingsPatch } from "./api.js";

// ---------------------------------------------------------------------------
// Rule shapes
// ---------------------------------------------------------------------------

/** One condition of a rule's `when` group (`packages/schemas` `ruleConditionSchema`). */
export interface RuleCondition {
  metric: string;
  operator: string;
  value: number;
}

/** A rule's condition group: exactly one of `all` / `any`. */
export type RuleWhen = { all: RuleCondition[] } | { any: RuleCondition[] };

/** What a rule does when it fires. */
export interface RuleAction {
  type: string;
  work_type: string;
}

/**
 * A rule as the *client* holds it - deliberately WITHOUT `version`.
 *
 * `GET .../settings` returns the effective rules, which DO carry a version
 * (they come from `book.yml` or the deployment bootstrap). The PATCH schema is
 * strict and rejects a client-supplied version outright, so the version is
 * dropped at the boundary (`snapshotOf`) rather than remembered and filtered
 * later: a value that must never be sent is safest never to hold.
 */
export interface EditableRule {
  trigger?: string;
  when: RuleWhen;
  action: RuleAction;
}

/** The metric whose presence the contract makes a labelled, removable choice. */
export const HUMAN_MAINTAINER_METRIC = "human_maintainer_approvals";

// ---------------------------------------------------------------------------
// Snapshot + patch
// ---------------------------------------------------------------------------

/** Publication display flags: `null` means "not set - use the default". */
export interface PublicationFlags {
  show_revision: boolean | null;
  show_attribution: boolean | null;
  show_public_annotations: boolean | null;
}

/**
 * Everything the form binds to, flattened. Guarded fields live here beside the
 * editable ones because "did this change?" is the same question for both; what
 * differs is what the API does about the answer.
 *
 * Never-editable fields (`id`, `repository.default_branch`, `content.*`,
 * `publication.api_url`) are absent by construction. The form cannot offer a
 * control for a value it does not hold.
 */
export interface SettingsSnapshot {
  title: string;
  language: string;
  license: string | null;
  slug: string;
  chapterUrl: string | null;
  publication: PublicationFlags;
  rules: Record<string, EditableRule>;
}

function cloneRule(rule: unknown): EditableRule {
  const source = (rule ?? {}) as Record<string, unknown>;
  const when = source["when"];
  const action = (source["action"] ?? {}) as Record<string, unknown>;
  const trigger = source["trigger"];
  return {
    // `version` is intentionally not copied (see EditableRule).
    ...(typeof trigger === "string" ? { trigger } : {}),
    when: normalizeWhen(when),
    action: {
      type: typeof action["type"] === "string" ? (action["type"] as string) : "create_work_item",
      work_type: typeof action["work_type"] === "string" ? (action["work_type"] as string) : "",
    },
  };
}

function normalizeWhen(when: unknown): RuleWhen {
  const group = (when ?? {}) as Record<string, unknown>;
  const any = group["any"];
  if (Array.isArray(any)) {
    return { any: any.map(cloneCondition) };
  }
  const all = group["all"];
  return { all: Array.isArray(all) ? all.map(cloneCondition) : [] };
}

function cloneCondition(condition: unknown): RuleCondition {
  const source = (condition ?? {}) as Record<string, unknown>;
  return {
    metric: typeof source["metric"] === "string" ? (source["metric"] as string) : "",
    operator: typeof source["operator"] === "string" ? (source["operator"] as string) : "gte",
    value: typeof source["value"] === "number" ? (source["value"] as number) : 0,
  };
}

/** The conditions of a rule, whichever group it uses. */
export function conditionsOf(rule: EditableRule): RuleCondition[] {
  return "any" in rule.when ? rule.when.any : rule.when.all;
}

/** `"all"` (every clause must hold) or `"any"` (one is enough). */
export function groupOf(rule: EditableRule): "all" | "any" {
  return "any" in rule.when ? "any" : "all";
}

/** Replace a rule's conditions, keeping its group kind. */
export function withConditions(rule: EditableRule, conditions: RuleCondition[]): EditableRule {
  return {
    ...rule,
    when: groupOf(rule) === "any" ? { any: conditions } : { all: conditions },
  };
}

/** The GET document as the form's starting state. */
export function snapshotOf(doc: SettingsDocument): SettingsSnapshot {
  const rules: Record<string, EditableRule> = {};
  for (const [name, rule] of Object.entries(doc.governance?.rules ?? {})) {
    rules[name] = cloneRule(rule);
  }
  const guardedSlug = doc.guarded?.["slug"]?.value;
  const guardedChapterUrl = doc.guarded?.["publication.chapter_url"]?.value;
  return {
    title: doc.settings.title,
    language: doc.settings.language,
    license: doc.settings.license,
    slug: typeof guardedSlug === "string" ? guardedSlug : "",
    chapterUrl: guardedChapterUrl ?? null,
    publication: {
      show_revision: doc.settings.publication.show_revision,
      show_attribution: doc.settings.publication.show_attribution,
      show_public_annotations: doc.settings.publication.show_public_annotations,
    },
    rules,
  };
}

/** Deep clone of a snapshot, so the edited copy never aliases the original. */
export function cloneSnapshot(snapshot: SettingsSnapshot): SettingsSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as SettingsSnapshot;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The minimal patch: only fields whose value actually differs.
 *
 * Consequences worth stating. A save with no edits produces `{}`, which the
 * view refuses to send at all - no empty settings commit in `git log`. A
 * guarded field appears only on a real change, so the confirmation step fires
 * when something breaks and never merely because a form was re-submitted.
 * `null` is a value here, not an absence: clearing the licence sends
 * `license: null`, while leaving it alone omits the key entirely.
 */
export function buildPatch(original: SettingsSnapshot, edited: SettingsSnapshot): SettingsPatch {
  const patch: SettingsPatch = {};
  if (edited.title !== original.title) patch.title = edited.title;
  if (edited.language !== original.language) patch.language = edited.language;
  if (edited.license !== original.license) patch.license = edited.license;
  if (edited.slug !== original.slug) patch.slug = edited.slug;

  const publication: NonNullable<SettingsPatch["publication"]> = {};
  if (edited.chapterUrl !== original.chapterUrl) publication.chapter_url = edited.chapterUrl;
  for (const key of ["show_revision", "show_attribution", "show_public_annotations"] as const) {
    if (edited.publication[key] !== original.publication[key]) {
      publication[key] = edited.publication[key];
    }
  }
  if (Object.keys(publication).length > 0) patch.publication = publication;

  if (!same(original.rules, edited.rules)) {
    // The rule map REPLACES the stored one wholesale (that is what makes a rule
    // deletable), so the whole edited map goes - versionless, by construction.
    patch.governance = { rules: edited.rules };
  }
  return patch;
}

/** Whether a patch would change anything at all (`confirm` alone does not). */
export function patchIsEmpty(patch: SettingsPatch): boolean {
  return Object.keys(patch).filter((key) => key !== "confirm").length === 0;
}

// ---------------------------------------------------------------------------
// Author-facing governance language
// ---------------------------------------------------------------------------

/** The contract's framing for the governance section, verbatim. */
export const GOVERNANCE_HEADING = "How many approvals before a suggestion becomes work?";

/**
 * "at least 3", "exactly 1" - the quantity half of a clause, so each metric
 * only has to supply the thing being counted.
 */
export function countPhrase(operator: string, value: number): string {
  switch (operator) {
    case "gte":
      return `at least ${value}`;
    case "gt":
      return `more than ${value}`;
    case "lte":
      return `at most ${value}`;
    case "lt":
      return `fewer than ${value}`;
    case "eq":
      return `exactly ${value}`;
    case "neq":
      return `any number other than ${value}`;
    default:
      // An operator outside the vocabulary is described honestly rather than
      // guessed at: the API refuses it on save, and inventing a reading here
      // would tell the author their rule means something it does not.
      return `${operator} ${value}`;
  }
}

interface MetricLanguage {
  /** The clause, given the quantity phrase ("at least 3"). */
  phrase: (count: string) => string;
  /** WHY this requirement exists / what it does not cover. */
  explain: string;
}

/**
 * Every metric in the closed vocabulary, in plain language. Complete on
 * purpose: a metric with no entry would fall back to printing its identifier,
 * which is exactly the "rendered, not explained" failure the contract names.
 */
const METRIC_LANGUAGE: Readonly<Record<string, MetricLanguage>> = Object.freeze({
  approvals: {
    phrase: (count) => `${count} people approve it`,
    explain: "Counts every approval, whoever casts it - readers, collaborators, agents, you.",
  },
  rejections: {
    phrase: (count) => `${count} people reject it`,
    explain: "Counts every rejection, whoever casts it.",
  },
  abstentions: {
    phrase: (count) => `${count} people abstain`,
    explain: "Counts votes cast as 'abstain' - read as taking part without taking a side.",
  },
  net_score: {
    phrase: (count) => `approvals minus rejections is ${count}`,
    explain:
      "The balance of opinion rather than the raw count: one rejection cancels one approval, so a divided suggestion does not pass on volume alone.",
  },
  distinct_voters: {
    phrase: (count) => `${count} different people have voted`,
    explain:
      "Counts how many people took part at all, whichever way they voted - a way to require that a change has been seen, not just liked.",
  },
  human_approvals: {
    phrase: (count) => `${count} people - not agents - approve it`,
    explain: "Approvals from agent accounts do not count towards this requirement.",
  },
  agent_approvals: {
    phrase: (count) => `${count} agents approve it`,
    explain: "Counts approvals cast by agent accounts only.",
  },
  maintainer_approvals: {
    phrase: (count) => `${count} maintainers approve it`,
    explain:
      "Counts approvals from anyone holding the maintainer role - and an agent token you own can hold that role, so this requirement can be met without a person ever reading the change. If that is not what you want, require a human maintainer's approval instead.",
  },
  [HUMAN_MAINTAINER_METRIC]: {
    phrase: (count) =>
      count === "at least 1"
        ? "you (or another human maintainer) approve it"
        : `${count} human maintainers approve it`,
    explain:
      "This is the requirement that keeps your book yours: nothing becomes work on it without a human maintainer agreeing. It is deliberately narrower than 'a maintainer approves it', because you can grant maintainer role to your own agent tokens - so a plain maintainer requirement could be satisfied by an agent you own, which is consensus you manufactured rather than consensus you got. Counting only humans closes that. You can remove it: on a genuinely collaborative project you may not want a personal veto on every change, and that is your call.",
  },
});

/** One clause of a rule, translated. */
export interface ClauseLanguage {
  condition: RuleCondition;
  /** e.g. "at least 3 people approve it". */
  text: string;
  /** Why the requirement exists, in the author's terms. */
  explain: string;
  /** True for the human-maintainer clause, which the view labels specially. */
  isHumanMaintainer: boolean;
}

/** One clause in plain language. */
export function describeCondition(condition: RuleCondition): ClauseLanguage {
  const language = METRIC_LANGUAGE[condition.metric];
  const count = countPhrase(condition.operator, condition.value);
  return {
    condition,
    text:
      language === undefined
        ? // Unknown metric: say so instead of inventing a meaning. The API
          // refuses it on save, so this is a state the author needs to see.
          `an unrecognised requirement (${condition.metric}) is ${count}`
        : language.phrase(count),
    explain:
      language === undefined
        ? "This book's rule names a measurement this version of Authorbot does not know how to evaluate, so it will never be satisfied."
        : language.explain,
    isHumanMaintainer: condition.metric === HUMAN_MAINTAINER_METRIC,
  };
}

/** A whole rule, translated. */
export interface RuleLanguage {
  /** The rule's name, prettified for display. */
  label: string;
  /** "When all of these are true" / "When any of these is true". */
  lead: string;
  clauses: ClauseLanguage[];
  /** What happens when the rule is satisfied. */
  outcome: string;
}

const WORK_TYPE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  revise_range: "revise the selected passage",
  revise_block: "revise that paragraph",
  revise_chapter: "revise the chapter",
  resolve_conflict: "resolve a conflict",
});

/** `promote_suggestion` → `Promote suggestion`. */
export function prettyName(name: string): string {
  const words = name.replace(/_/g, " ").trim();
  return words.length === 0 ? name : `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}`;
}

export function describeRule(name: string, rule: EditableRule): RuleLanguage {
  const clauses = conditionsOf(rule).map(describeCondition);
  const work = WORK_TYPE_WORDS[rule.action.work_type];
  return {
    label: prettyName(name),
    lead:
      groupOf(rule) === "any"
        ? "A suggestion becomes work as soon as any one of these is true:"
        : clauses.length === 1
          ? "A suggestion becomes work when:"
          : "A suggestion becomes work only when all of these are true:",
    clauses,
    outcome:
      work === undefined
        ? "Then it joins the work queue as a task someone (or an agent) can pick up."
        : `Then it joins the work queue as a task to ${work}.`,
  };
}

/** Whether the human-maintainer-approval requirement is currently in force. */
export function hasHumanMaintainerClause(rule: EditableRule): boolean {
  return conditionsOf(rule).some((condition) => condition.metric === HUMAN_MAINTAINER_METRIC);
}

/** The contract's label for the add/remove choice. */
export const HUMAN_MAINTAINER_LABEL = "Require a human maintainer's approval";

/**
 * Add or remove the human-maintainer clause - the contract makes it both
 * editable and removable, so both directions are a supported edit rather than
 * a special case the view has to hand-roll.
 */
export function withHumanMaintainerClause(rule: EditableRule, required: boolean): EditableRule {
  const conditions = conditionsOf(rule).filter(
    (condition) => condition.metric !== HUMAN_MAINTAINER_METRIC,
  );
  if (!required) {
    return withConditions(rule, conditions);
  }
  const existing = conditionsOf(rule).find(
    (condition) => condition.metric === HUMAN_MAINTAINER_METRIC,
  );
  return withConditions(rule, [
    ...conditions,
    existing ?? { metric: HUMAN_MAINTAINER_METRIC, operator: "gte", value: 1 },
  ]);
}

/** The wording for a book still running the deployment's bootstrap rules. */
export const BOOTSTRAP_NOTICE =
  "This book has not adopted its own rules yet - it is running the defaults this Authorbot deployment was started with. Saving here adopts them as your book's own rules, written into book.yml and committed like any other change.";

export const BOOK_SOURCE_NOTICE =
  "These are your book's own rules, stored in book.yml and versioned with the prose they govern.";

/** The sentence explaining where the effective rules come from. */
export function sourceNotice(source: string): string {
  return source === "bootstrap" ? BOOTSTRAP_NOTICE : BOOK_SOURCE_NOTICE;
}

// ---------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------

/**
 * Plain-language summaries for the identifiers an author is most likely to
 * pick. Short on purpose: this is orientation, not legal advice.
 *
 * Anything not listed gets NO summary - the raw identifier is shown alone.
 * Guessing at an unrecognised licence would be worse than silence: an author
 * choosing how their book may be reused deserves either a summary that is
 * right or none at all.
 */
const LICENSE_SUMMARIES: Readonly<Record<string, string>> = Object.freeze({
  "cc-by-4.0":
    "Anyone may share and adapt your book, including commercially, as long as they credit you.",
  "cc-by-sa-4.0":
    "Anyone may share and adapt your book, including commercially, as long as they credit you and release their version under this same licence.",
  "cc-by-nc-4.0":
    "Anyone may share and adapt your book for non-commercial purposes, as long as they credit you.",
  "cc-by-nd-4.0":
    "Anyone may share your book as it is, including commercially, as long as they credit you - but adaptations may not be published.",
  "cc-by-nc-sa-4.0":
    "Anyone may share and adapt your book for non-commercial purposes, as long as they credit you and release their version under this same licence.",
  "cc0-1.0":
    "You give up your rights as far as the law allows: anyone may use the book for anything, and no credit is required.",
  mit: "Anyone may use, change and redistribute the text, including commercially, as long as the licence notice travels with it.",
  "apache-2.0":
    "Anyone may use, change and redistribute the text, including commercially, with an explicit patent grant and a requirement to note what they changed.",
  "all rights reserved":
    "You keep every right: nobody may republish or adapt your book without asking you first.",
  proprietary:
    "You keep every right: nobody may republish or adapt your book without asking you first.",
});

/**
 * A one-sentence summary of a licence identifier, or `null` when it is not one
 * we recognise. Callers show the identifier itself in that case.
 */
export function licenseSummary(identifier: string | null): string | null {
  if (identifier === null) return null;
  return LICENSE_SUMMARIES[identifier.trim().toLowerCase()] ?? null;
}

/** Licences offered as suggestions in the form's datalist. */
export const SUGGESTED_LICENSES: readonly string[] = Object.freeze([
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
  "CC-BY-NC-4.0",
  "CC0-1.0",
  "All rights reserved",
]);
