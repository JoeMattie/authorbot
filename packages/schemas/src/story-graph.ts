import { z } from "zod";
import { chapterStatusSchema } from "./chapter.js";
import { nodeIdSchema, uuidv7Schema } from "./primitives.js";

/** Story graph node types (contract section 4). */
export const STORY_NODE_TYPES = [
  "premise",
  "arc",
  "part",
  "chapter",
  "scene",
  "beat",
  "custom",
] as const;
export type StoryNodeType = (typeof STORY_NODE_TYPES)[number];

const nodeCommonFields = {
  id: nodeIdSchema,
  title: z.string().min(1).optional(),
  summary: z.string().optional(),
  parent: nodeIdSchema.optional(),
  order: z.number(),
  /** Free-form template tags, e.g. for beat-sheet views (design section 8.5). */
  tags: z.array(z.string().min(1)).optional(),
} as const;

/** `type: chapter` nodes carry the chapter's UUID (contract section 4). */
export const storyGraphChapterNodeSchema = z.strictObject({
  ...nodeCommonFields,
  type: z.literal("chapter"),
  chapter_id: uuidv7Schema,
  status: chapterStatusSchema.optional(),
});
export type StoryGraphChapterNode = z.infer<typeof storyGraphChapterNodeSchema>;

/** All non-chapter node types; scene-style fields are optional. */
export const storyGraphStoryNodeSchema = z.strictObject({
  ...nodeCommonFields,
  type: z.enum(["premise", "arc", "part", "scene", "beat", "custom"]),
  goal: z.string().optional(),
  conflict: z.string().optional(),
  outcome: z.string().optional(),
});
export type StoryGraphStoryNode = z.infer<typeof storyGraphStoryNodeSchema>;

export const storyGraphNodeSchema = z.discriminatedUnion("type", [
  storyGraphChapterNodeSchema,
  storyGraphStoryNodeSchema,
]);
export type StoryGraphNode = z.infer<typeof storyGraphNodeSchema>;

export const storyGraphLinkSchema = z.strictObject({
  from: nodeIdSchema,
  to: nodeIdSchema,
  type: z.string().min(1),
});
export type StoryGraphLink = z.infer<typeof storyGraphLinkSchema>;

/**
 * Story graph `story/outline.yml` - `authorbot.story-graph/v1`
 * (design section 8.5, contract section 4).
 */
export const storyGraphSchema = z.strictObject({
  schema: z.literal("authorbot.story-graph/v1"),
  nodes: z.array(storyGraphNodeSchema),
  links: z.array(storyGraphLinkSchema).optional(),
});
export type StoryGraph = z.infer<typeof storyGraphSchema>;
