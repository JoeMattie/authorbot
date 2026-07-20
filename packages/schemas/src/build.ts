import { z } from "zod";
import { chapterStatusSchema } from "./chapter.js";
import {
  commitShaSchema,
  slugSchema,
  timestampSchema,
  uuidv7Schema,
} from "./primitives.js";

/**
 * One chapter as recorded in the build manifest (Phase 1 contract section 3,
 * design section 17.2).
 */
export const buildManifestChapterSchema = z.strictObject({
  id: uuidv7Schema,
  slug: slugSchema,
  revision: z.number().int().min(1),
  title: z.string().min(1),
  status: chapterStatusSchema,
});
export type BuildManifestChapter = z.infer<typeof buildManifestChapterSchema>;

/**
 * Build manifest `authorbot-build.json` — `authorbot.build/v1` (Phase 1
 * contract section 3). `commit` is null when the build ran outside a git
 * work tree; `chapters` lists every chapter included in the build.
 */
export const buildManifestSchema = z.strictObject({
  schema: z.literal("authorbot.build/v1"),
  commit: commitShaSchema.nullable(),
  built_at: timestampSchema,
  publisher_version: z.string().min(1),
  base_url: z.string().min(1).optional(),
  chapters: z.array(buildManifestChapterSchema),
});
export type BuildManifest = z.infer<typeof buildManifestSchema>;
