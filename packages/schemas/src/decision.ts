import { z } from "zod";
import { timestampSchema, uuidv7Schema } from "./primitives.js";

/** Decision results (contract section 4). */
export const DECISION_RESULTS = [
  "create_work_item",
  "rejected",
  "support_changed",
  "overridden",
] as const;
export const decisionResultSchema = z.enum(DECISION_RESULTS);
export type DecisionResult = z.infer<typeof decisionResultSchema>;

/**
 * Decision record `.authorbot/decisions/<id>.yml` - `authorbot.decision/v1`
 * (contract section 4). `effective_at` is required; only `work_item_id` and
 * `override_reason` are optional per the contract wording.
 */
export const decisionSchema = z.strictObject({
  schema: z.literal("authorbot.decision/v1"),
  id: uuidv7Schema,
  source_annotation_id: uuidv7Schema,
  /** Present when this decision promotes one reply, not the whole annotation. */
  source_reply_id: uuidv7Schema.optional(),
  rule: z.string().min(1),
  // `rule_version: 0` is reserved for maintainer force-create decisions
  // (contract §4); rule crossings use versions >= 1.
  rule_version: z.number().int().min(0),
  /** Aggregate metric snapshot, e.g. `{ approvals: 3, net_score: 2 }`. */
  metrics: z.record(z.string(), z.number()),
  result: decisionResultSchema,
  work_item_id: uuidv7Schema.optional(),
  effective_at: timestampSchema,
  override_reason: z.string().min(1).optional(),
});
export type Decision = z.infer<typeof decisionSchema>;
