import { z } from "zod";
import { actorRefSchema, commitShaSchema, uuidv7Schema } from "./primitives.js";

export const attributionEntrySchema = z.strictObject({
  revision: z.number().int().min(1),
  actor: actorRefSchema,
  work_item_id: uuidv7Schema.optional(),
  commit: commitShaSchema.optional(),
});
export type AttributionEntry = z.infer<typeof attributionEntrySchema>;

/**
 * Attribution record `.authorbot/attribution/<chapter-id>.yml` -
 * `authorbot.attribution/v1` (contract section 4). At least one entry: the
 * file only exists once a chapter revision has an author to attribute.
 */
export const attributionSchema = z.strictObject({
  schema: z.literal("authorbot.attribution/v1"),
  chapter_id: uuidv7Schema,
  entries: z.array(attributionEntrySchema).min(1),
});
export type Attribution = z.infer<typeof attributionSchema>;
