import { z } from "zod";
import { rulesMapSchema } from "./instance.js";
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
      /**
       * Collaboration API base URL (Phase 2b contract §1); enables the
       * annotation islands at build time. `authorbot build --api-url`
       * overrides.
       */
      api_url: z.string().min(1).optional(),
      show_revision: z.boolean().optional(),
      show_attribution: z.boolean().optional(),
      show_public_annotations: z.boolean().optional(),
    })
    .optional(),
  /**
   * Governance rules (Phase 6 contract section 3.6, amending Phase 3 section
   * 3). Rules live here — versioned, diffable, and reviewable alongside the
   * prose they govern, and therefore editable from the Settings view. The
   * `RULES_JSON` environment variable remains a *bootstrap default* for a book
   * that has not set them; once `governance.rules` exists it wins outright.
   *
   * Absent and `{}` are deliberately different: absent means "not configured,
   * fall back to the environment/design default", while an explicit empty map
   * is rejected below because a book with zero rules would silently never
   * promote anything.
   */
  governance: z
    .strictObject({
      rules: rulesMapSchema
        .refine(
          (rules) => Object.keys(rules).length > 0,
          "governance.rules must define at least one rule (omit the section to use the default)",
        )
        .optional(),
    })
    .optional(),
});
export type BookConfig = z.infer<typeof bookConfigSchema>;
