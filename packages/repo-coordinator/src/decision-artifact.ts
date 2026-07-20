/**
 * Byte-stable rendering and parsing of decision artifacts
 * `.authorbot/decisions/<id>.yml` (`authorbot.decision/v1`, Phase 0 contract
 * §4; Phase 3 contract §4).
 *
 * Aggregate metrics only, never voter identities (design §26.1): the artifact
 * carries the metric snapshot stored on the decision row; nothing here ever
 * touches vote rows. Metrics keys are emitted sorted (code-point order) so the
 * same snapshot always produces the same bytes regardless of JSON key order.
 *
 * `support_changed` encoding (design §11.3): the `authorbot.decision/v1`
 * schema has no boolean flag, but its `result` vocabulary includes
 * `support_changed`. A decision whose `supportChanged` projection flag is set
 * renders `result: support_changed`; when support returns, the re-render
 * restores the stored result — only the `result` line changes between the two
 * renders. The inverse mapping is lossless: support can only change on a
 * decision that created a work item, and the stored result of such a decision
 * is `create_work_item` for rule crossings (`rule_version >= 1`) and
 * `overridden` for force-creates (`rule_version: 0`, Phase 3 contract §4).
 *
 * `rule_version: 0` (force-create, contract §4) is validated directly by the
 * canonical `@authorbot/schemas.decisionSchema`, which admits `rule_version`
 * as any non-negative integer.
 */
import { parse, stringify } from "yaml";
import {
  decisionSchema,
  type Decision,
  type DecisionResult,
} from "@authorbot/schemas";
import { YAML_OPTIONS, type RenderedFile } from "./render.js";

/** `.authorbot/decisions/<id>.yml` (Phase 0 contract §4). */
export function decisionFilePath(decisionId: string): string {
  return `.authorbot/decisions/${decisionId}.yml`;
}

export interface DecisionArtifactInput {
  /** Decision UUIDv7. */
  id: string;
  sourceAnnotationId: string;
  /** Rule name, e.g. `suggestion_to_work_item`. */
  rule: string;
  /** Rule version; `0` marks a maintainer force-create (Phase 3 contract §4). */
  ruleVersion: number;
  /** Aggregate metric snapshot at crossing — never per-voter data (§26.1). */
  metrics: Record<string, number>;
  /**
   * The *stored* decision result. Must not be `support_changed` — that value
   * is derived from the `supportChanged` flag at render time so the original
   * result survives the flag being cleared again (design §11.3 "preserve the
   * original threshold-crossing snapshot").
   */
  result: DecisionResult;
  /** Current support flag (design §11.3). Requires `workItemId` when true. */
  supportChanged: boolean;
  workItemId?: string | null;
  /** RFC 3339 UTC timestamp of the decision (its creation instant). */
  effectiveAt: string;
  overrideReason?: string | null;
}

/**
 * Validate a decision artifact object against the canonical schema, which
 * admits `rule_version: 0` (maintainer force-create, contract §4).
 */
function validateDecisionObject(doc: Record<string, unknown>): Decision {
  return decisionSchema.parse(doc);
}

/** Sort metric keys (code-point order) for byte-stable emission. */
function sortedMetrics(metrics: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(metrics).sort()) {
    const value = metrics[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Render `.authorbot/decisions/<id>.yml`. Byte-stable. */
export function renderDecisionArtifact(input: DecisionArtifactInput): RenderedFile {
  if (input.result === "support_changed") {
    throw new Error(
      `decision ${input.id}: pass the stored result plus the supportChanged flag; ` +
        `"support_changed" is derived at render time`,
    );
  }
  if (input.supportChanged && (input.workItemId === null || input.workItemId === undefined)) {
    throw new Error(
      `decision ${input.id}: supportChanged is only meaningful on a decision that created a work item`,
    );
  }
  const doc: Record<string, unknown> = {
    schema: "authorbot.decision/v1",
    id: input.id,
    source_annotation_id: input.sourceAnnotationId,
    rule: input.rule,
    rule_version: input.ruleVersion,
    metrics: sortedMetrics(input.metrics),
    result: input.supportChanged ? "support_changed" : input.result,
    ...(input.workItemId === null || input.workItemId === undefined
      ? {}
      : { work_item_id: input.workItemId }),
    effective_at: input.effectiveAt,
    ...(input.overrideReason === null || input.overrideReason === undefined
      ? {}
      : { override_reason: input.overrideReason }),
  };
  validateDecisionObject(doc);
  return {
    path: decisionFilePath(input.id),
    content: stringify(doc, YAML_OPTIONS),
  };
}

export interface ParsedDecisionArtifact {
  /** The validated artifact (`rule_version` may be 0 for force-creates). */
  artifact: Decision;
  /**
   * Projection-side stored result (the artifact's `support_changed` result
   * decoded back to the original result — see module docs).
   */
  result: DecisionResult;
  /** Projection-side `supportChanged` flag. */
  supportChanged: boolean;
}

/**
 * Parse `.authorbot/decisions/<id>.yml` for projection rebuild (Phase 3
 * contract §4 rebuildability). Throws on malformed artifacts.
 */
export function parseDecisionArtifact(content: string): ParsedDecisionArtifact {
  let raw: unknown;
  try {
    raw = parse(content);
  } catch (error) {
    throw new Error(
      `decision artifact: unparseable YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("decision artifact: document is not a mapping");
  }
  const artifact = validateDecisionObject(raw as Record<string, unknown>);
  if (artifact.result !== "support_changed") {
    return { artifact, result: artifact.result, supportChanged: false };
  }
  if (artifact.work_item_id === undefined) {
    throw new Error(
      `decision artifact ${artifact.id}: result support_changed without work_item_id`,
    );
  }
  return {
    artifact,
    // Lossless inverse of the render-time encoding (see module docs).
    result: artifact.rule_version === 0 ? "overridden" : "create_work_item",
    supportChanged: true,
  };
}
