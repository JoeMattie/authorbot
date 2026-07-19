import { z } from "zod";
import { slugSchema, uuidv7Schema } from "./primitives.js";

/**
 * Book config `book.yml` — `authorbot.book/v1` (design section 8.2).
 * Optional sections default at load time; the schema does not inject defaults.
 */
export const bookConfigSchema = z.strictObject({
  schema: z.literal("authorbot.book/v1"),
  id: uuidv7Schema,
  title: z.string().min(1),
  slug: slugSchema,
  /** BCP 47-style language tag, e.g. `en` or `en-US`. */
  language: z
    .string()
    .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/, "must be a language tag like en-US"),
  license: z.string().min(1).optional(),
  repository: z
    .strictObject({
      default_branch: z.string().min(1).optional(),
    })
    .optional(),
  content: z
    .strictObject({
      chapters_glob: z.string().min(1).optional(),
      raw_html: z.boolean().optional(),
    })
    .optional(),
  planning: z
    .strictObject({
      /** Method-neutral label (design section 1.2), e.g. `custom`, `snowflake`. */
      method: z.string().min(1).optional(),
      outline: z.string().min(1).optional(),
      timeline: z.string().min(1).optional(),
      characters_glob: z.string().min(1).optional(),
    })
    .optional(),
  publication: z
    .strictObject({
      chapter_url: z.string().min(1).optional(),
      show_revision: z.boolean().optional(),
      show_attribution: z.boolean().optional(),
      show_public_annotations: z.boolean().optional(),
    })
    .optional(),
});
export type BookConfig = z.infer<typeof bookConfigSchema>;
