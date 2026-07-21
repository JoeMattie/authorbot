import { z } from "zod";
import { timestampSchema, uuidv7Schema } from "./primitives.js";

/**
 * Release manifest `.authorbot/releases/<id>.yml` - `authorbot.release/v1`
 * (contract section 4). A release pins at least one chapter revision.
 */
export const releaseSchema = z.strictObject({
  schema: z.literal("authorbot.release/v1"),
  id: uuidv7Schema,
  created_at: timestampSchema,
  chapters: z
    .array(
      z.strictObject({
        chapter_id: uuidv7Schema,
        revision: z.number().int().min(1),
      }),
    )
    .min(1),
  notes: z.string().optional(),
});
export type Release = z.infer<typeof releaseSchema>;
