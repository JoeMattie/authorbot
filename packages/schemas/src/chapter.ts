import { z } from "zod";
import {
  actorRefSchema,
  nodeIdOf,
  slugSchema,
  timestampSchema,
  uuidv7Schema,
} from "./primitives.js";

/** Chapter lifecycle states (contract section 4, design section 9.3). */
export const CHAPTER_STATUSES = [
  "draft",
  "proposed",
  "published",
  "archived",
] as const;
export const chapterStatusSchema = z.enum(CHAPTER_STATUSES);
export type ChapterStatus = z.infer<typeof chapterStatusSchema>;

/**
 * Chapter frontmatter - `authorbot.chapter/v1` (design section 8.3,
 * contract section 4).
 */
export const chapterFrontmatterSchema = z.strictObject({
  schema: z.literal("authorbot.chapter/v1"),
  id: uuidv7Schema,
  slug: slugSchema,
  title: z.string().min(1),
  order: z.number(),
  status: chapterStatusSchema,
  revision: z.number().int().min(1),
  published_at: timestampSchema.optional(),
  authors: z
    .array(
      z.strictObject({
        actor: actorRefSchema,
        /** Display label captured when the actor is an agent token. */
        name: z.string().min(1).optional(),
      }),
    )
    .min(1),
  summary: z.string().optional(),
  timeline_refs: z.array(nodeIdOf("event")).optional(),
  character_refs: z.array(nodeIdOf("character")).optional(),
});
export type ChapterFrontmatter = z.infer<typeof chapterFrontmatterSchema>;
