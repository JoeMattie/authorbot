import { z } from "zod";
import { isoDurationSchema } from "./primitives.js";
import { workItemTypeSchema } from "./work-item.js";

/**
 * Declarative rule shape (design section 11.1). Rules are data; no
 * expressions or code are ever evaluated from configuration.
 */

/** Snake_case metric name, e.g. `approvals`, `net_score`, `human_approvals`.
 * The design keeps the metric list "small and explicit" but does not pin it,
 * so the schema constrains the shape rather than an enum. */
export const ruleMetricNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "must be a snake_case metric name");

export const ruleConditionSchema = z.strictObject({
  metric: ruleMetricNameSchema,
  operator: z.enum(["gte", "gt", "lte", "lt", "eq", "neq"]),
  value: z.number(),
});
export type RuleCondition = z.infer<typeof ruleConditionSchema>;

/** Condition group: exactly one of `all` / `any` (design shows `all`). */
export const ruleWhenSchema = z.union([
  z.strictObject({ all: z.array(ruleConditionSchema).min(1) }),
  z.strictObject({ any: z.array(ruleConditionSchema).min(1) }),
]);
export type RuleWhen = z.infer<typeof ruleWhenSchema>;

export const ruleActionSchema = z.strictObject({
  type: z.literal("create_work_item"),
  work_type: workItemTypeSchema,
});
export type RuleAction = z.infer<typeof ruleActionSchema>;

export const declarativeRuleSchema = z.strictObject({
  version: z.number().int().min(1),
  /** `vote_changed` is the only trigger defined for v0.1 (design 11.1). */
  trigger: z.enum(["vote_changed"]).optional(),
  when: ruleWhenSchema,
  action: ruleActionSchema,
});
export type DeclarativeRule = z.infer<typeof declarativeRuleSchema>;

/**
 * Instance (deployment) config — `authorbot.instance/v1` (design section 25).
 * Every section is optional: the file overrides defaults, and defaults are
 * applied by the loader, not by this schema. Secrets never belong here.
 */
export const instanceConfigSchema = z.strictObject({
  schema: z.literal("authorbot.instance/v1"),
  project: z
    .strictObject({
      book_config_path: z.string().min(1).optional(),
      default_branch: z.string().min(1).optional(),
    })
    .optional(),
  access: z
    .strictObject({
      public_read: z.boolean().optional(),
      public_annotations: z.boolean().optional(),
      writes_require_membership: z.boolean().optional(),
    })
    .optional(),
  annotations: z
    .strictObject({
      context_characters: z.number().int().min(0).optional(),
      /** v0.1 restriction: range selections stay in one block (design 8.4). */
      range_scope: z.enum(["single_block"]).optional(),
      allow_range_comments: z.boolean().optional(),
      allow_chapter_comments: z.boolean().optional(),
    })
    .optional(),
  votes: z
    .strictObject({
      values: z.array(z.enum(["approve", "reject", "abstain"])).min(1).optional(),
      /** Vote export mode (design sections 25 and 26). */
      export: z.enum(["aggregate", "named", "pseudonymous"]).optional(),
    })
    .optional(),
  rules: z
    .record(z.string().regex(/^[a-z][a-z0-9_]*$/), declarativeRuleSchema)
    .optional(),
  leases: z
    .strictObject({
      duration: isoDurationSchema.optional(),
      renewal_prompt_before: isoDurationSchema.optional(),
      renewal_duration: isoDurationSchema.optional(),
      maximum_total_duration: isoDurationSchema.optional(),
    })
    .optional(),
  publishing: z
    .strictObject({
      collaboration_data: z.enum(["dynamic", "static"]).optional(),
      static_snapshot_on_release: z.boolean().optional(),
    })
    .optional(),
});
export type InstanceConfig = z.infer<typeof instanceConfigSchema>;
