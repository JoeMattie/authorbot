import { z } from "zod";
import { actorRefSchema, timestampSchema, uuidv7Schema } from "./primitives.js";

/** Work item types (contract section 4). */
export const WORK_ITEM_TYPES = [
  "revise_range",
  "revise_block",
  "revise_chapter",
  "write_chapter",
  "resolve_conflict",
  "planning",
] as const;
export const workItemTypeSchema = z.enum(WORK_ITEM_TYPES);
export type WorkItemType = z.infer<typeof workItemTypeSchema>;

/** Work item states (contract section 4, design section 9.5). */
export const WORK_ITEM_STATUSES = [
  "ready",
  "leased",
  "submitted",
  "applying",
  "completed",
  "conflict",
  "failed",
  "cancelled",
] as const;
export const workItemStatusSchema = z.enum(WORK_ITEM_STATUSES);
export type WorkItemStatus = z.infer<typeof workItemStatusSchema>;

export const WORK_ITEM_PRIORITIES = ["low", "normal", "high"] as const;
export const workItemPrioritySchema = z.enum(WORK_ITEM_PRIORITIES);
export type WorkItemPriority = z.infer<typeof workItemPrioritySchema>;

/**
 * Work item frontmatter `.authorbot/work-items/<id>.md` —
 * `authorbot.work-item/v1` (design section 13, contract section 4).
 * Stable paths with status in frontmatter (contract ADR over design 8.1).
 * `source_annotation_id`, `chapter_id`, and `base_revision` are optional at
 * the schema level because `write_chapter` and `planning` items may lack
 * them; per-type reference requirements are validator concerns
 * (WORK_ITEM_REF_UNRESOLVED). Lease state never appears here (design 13).
 */
export const workItemSchema = z.strictObject({
  schema: z.literal("authorbot.work-item/v1"),
  id: uuidv7Schema,
  type: workItemTypeSchema,
  status: workItemStatusSchema,
  source_annotation_id: uuidv7Schema.optional(),
  chapter_id: uuidv7Schema.optional(),
  base_revision: z.number().int().min(1).optional(),
  priority: workItemPrioritySchema,
  created_by: actorRefSchema,
  created_at: timestampSchema,
});
export type WorkItem = z.infer<typeof workItemSchema>;
