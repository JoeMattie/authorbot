/**
 * Byte-stable rendering of `book.yml` - `authorbot.book/v1` (Phase 6 contract
 * §3.6: "editing the same `book.yml` that lives in Git … Settings changes are
 * commits: diffable, revertable, audited").
 *
 * Two properties matter here and nowhere else in this package:
 *
 * 1. **Byte stability.** The same config always produces the same bytes, so a
 *    replayed outbox row is a no-op commit rather than a churned file. Key
 *    order is fixed to the schema's declaration order (not insertion order,
 *    which a JSON round trip through D1 would otherwise dictate), YAML options
 *    are the pinned `YAML_OPTIONS`, and the file ends with exactly one newline.
 *
 * 2. **Minimal diffs.** Absent optional sections stay absent. A book that never
 *    set `planning` must not acquire an empty `planning: {}` because settings
 *    were edited once - the diff a maintainer reviews should contain only what
 *    they changed.
 *
 * Every config is validated against `bookConfigSchema` before serialization, so
 * an invalid document can never reach the book repository. That check is the
 * last line of defence, not the first: the API validates on the way in too.
 */
import { parse as parseYaml, parseDocument, stringify } from "yaml";
import { bookConfigSchema, type BookConfig } from "@authorbot/schemas";
import { YAML_OPTIONS, type RenderedFile } from "./render.js";

/** Repo-relative path of the book config (design §8.2). */
export const BOOK_CONFIG_PATH = "book.yml";

/**
 * Top-level key order. Fixed here rather than derived from the input so two
 * configs that differ only in key order render identically.
 */
const KEY_ORDER = [
  "schema",
  "id",
  "title",
  "slug",
  "language",
  "license",
  "repository",
  "content",
  "planning",
  "publication",
  "governance",
] as const;

/** Nested key order, section by section - same reasoning as {@link KEY_ORDER}. */
const NESTED_KEY_ORDER: Record<string, readonly string[]> = {
  repository: ["default_branch"],
  content: ["chapters_glob", "raw_html"],
  planning: ["method", "outline", "timeline", "characters_glob"],
  publication: [
    "chapter_url",
    "api_url",
    "show_revision",
    "show_attribution",
    "show_public_annotations",
  ],
  governance: ["rules"],
};

/** Rule key order (the `authorbot.instance/v1` declarative rule shape). */
const RULE_KEY_ORDER = ["version", "trigger", "when", "action"] as const;
const CONDITION_KEY_ORDER = ["metric", "operator", "value"] as const;
const ACTION_KEY_ORDER = ["type", "work_type"] as const;

function reorder(value: unknown, order: readonly string[]): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of order) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  // Anything the order list does not name is appended in its existing order
  // rather than dropped: silently discarding a key would turn a rendering
  // detail into data loss.
  for (const key of Object.keys(source)) {
    if (!(key in out) && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function orderRule(rule: unknown): unknown {
  const ordered = reorder(rule, RULE_KEY_ORDER) as Record<string, unknown>;
  const when = ordered["when"] as Record<string, unknown> | undefined;
  if (when !== undefined) {
    const group = Array.isArray(when["all"]) ? "all" : "any";
    const conditions = when[group];
    if (Array.isArray(conditions)) {
      ordered["when"] = {
        [group]: conditions.map((condition) => reorder(condition, CONDITION_KEY_ORDER)),
      };
    }
  }
  if (ordered["action"] !== undefined) {
    ordered["action"] = reorder(ordered["action"], ACTION_KEY_ORDER);
  }
  return ordered;
}

/**
 * Normalize a validated config into the exact object that gets serialized.
 * Exported for tests and for the API's byte-comparison short circuit (a PATCH
 * that changes nothing must not queue a commit).
 */
export function orderBookConfig(config: BookConfig): Record<string, unknown> {
  const ordered = reorder(config, KEY_ORDER) as Record<string, unknown>;
  for (const [section, order] of Object.entries(NESTED_KEY_ORDER)) {
    if (ordered[section] !== undefined) {
      ordered[section] = reorder(ordered[section], order);
    }
  }
  const governance = ordered["governance"] as Record<string, unknown> | undefined;
  const rules = governance?.["rules"] as Record<string, unknown> | undefined;
  if (governance !== undefined && rules !== undefined) {
    // Rule names sorted: the map's iteration order is whatever JSON round trip
    // produced it, which is not a property of the book.
    const orderedRules: Record<string, unknown> = {};
    for (const name of Object.keys(rules).sort()) {
      orderedRules[name] = orderRule(rules[name]);
    }
    ordered["governance"] = { ...governance, rules: orderedRules };
  }
  return ordered;
}

/**
 * Apply only `changed` dotted paths onto the `book.yml` that is actually at the
 * branch head, editing the YAML *document* rather than re-serializing a config.
 *
 * A settings PATCH is a read-modify-write of the `book_configs` projection, and
 * that projection can be stale (it freezes while a project is diverged, and
 * `projectBookConfig` keeps the previous row on an `invalid` outcome). Rendering
 * the whole file from that copy therefore reverted anything the author had
 * committed directly to Git in the meantime - including the three fields
 * `IMMUTABLE_FIELDS` documents as never editable, so a title edit could silently
 * re-enable `content.raw_html` or repoint `repository.default_branch`. Writing
 * only the paths the maintainer actually edited makes that impossible: a key
 * nobody touched is never part of the commit.
 *
 * It also keeps the author's own comments and key order, which a
 * `parse → plain object → stringify` round trip cannot (§3.6: "Settings changes
 * are commits: diffable" - a whole-file rewrite buries the one changed line).
 *
 * `head` is the file at the branch head, or `null` when the repository has no
 * `book.yml` yet, in which case there is nothing to preserve and the config is
 * rendered in full.
 */
export function mergeBookConfigArtifact(
  head: string | null,
  config: unknown,
  changed: readonly string[],
): RenderedFile {
  const parsed = bookConfigSchema.parse(config);
  if (head === null || head.trim() === "") {
    return renderBookConfigArtifact(parsed);
  }

  const doc = parseDocument(head);
  if (doc.errors.length > 0) {
    throw new Error(
      `book.yml at the branch head is not valid YAML: ${doc.errors.map((e) => e.message).join("; ")}`,
    );
  }

  const ordered = orderBookConfig(parsed);
  for (const path of changed) {
    const segments = path.split(".");
    const value = readOrderedPath(ordered, segments);
    if (value === undefined) {
      doc.deleteIn(segments);
      // An emptied section is removed rather than left as `publication: {}`.
      if (segments.length > 1) {
        const parent = doc.getIn(segments.slice(0, -1));
        if (isEmptyMap(parent)) doc.deleteIn(segments.slice(0, -1));
      }
      continue;
    }
    doc.setIn(segments, doc.createNode(value));
  }

  const content = doc.toString(YAML_OPTIONS);
  const merged = content.endsWith("\n") ? content : `${content}\n`;

  // The bytes about to be committed are the ones validated, not the payload
  // they were derived from: the head may have carried a key this deployment's
  // schema rejects, and committing that unread would be the same blind
  // overwrite in reverse.
  const check = bookConfigSchema.safeParse(parseYaml(merged));
  if (!check.success) {
    throw new Error(
      `merging settings onto book.yml at the branch head would produce an invalid ` +
        `authorbot.book/v1 document: ${check.error.issues
          .map((issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`)
          .join("; ")}`,
    );
  }
  return { path: BOOK_CONFIG_PATH, content: merged };
}

function readOrderedPath(ordered: Record<string, unknown>, segments: readonly string[]): unknown {
  let cursor: unknown = ordered;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function isEmptyMap(node: unknown): boolean {
  return (
    node !== null &&
    typeof node === "object" &&
    "items" in node &&
    Array.isArray((node as { items: unknown[] }).items) &&
    (node as { items: unknown[] }).items.length === 0
  );
}

/**
 * Render `book.yml`. Throws (via Zod) if `config` is not a valid
 * `authorbot.book/v1` document.
 */
export function renderBookConfigArtifact(config: unknown): RenderedFile {
  const parsed = bookConfigSchema.parse(config);
  const body = stringify(orderBookConfig(parsed), YAML_OPTIONS);
  return {
    path: BOOK_CONFIG_PATH,
    content: body.endsWith("\n") ? body : `${body}\n`,
  };
}
