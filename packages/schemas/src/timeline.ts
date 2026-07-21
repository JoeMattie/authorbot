import { z } from "zod";
import { nodeIdOf, uuidv7Schema } from "./primitives.js";

export const timelineEventSchema = z.strictObject({
  id: nodeIdOf("event"),
  sort_key: z.number(),
  display_time: z.string().min(1),
  title: z.string().min(1),
  participants: z.array(nodeIdOf("character")).optional(),
  locations: z.array(nodeIdOf("location")).optional(),
  chapter_refs: z.array(uuidv7Schema).optional(),
  facts: z.array(z.string().min(1)).optional(),
});
export type TimelineEvent = z.infer<typeof timelineEventSchema>;

/**
 * Timeline `story/timeline.yml` - `authorbot.timeline/v1`
 * (design section 8.6, contract section 4).
 */
export const timelineSchema = z.strictObject({
  schema: z.literal("authorbot.timeline/v1"),
  calendar: z
    .strictObject({
      /** e.g. `absolute`, `relative`, or a custom calendar label. */
      type: z.string().min(1),
      epoch_label: z.string().min(1).optional(),
    })
    .optional(),
  events: z.array(timelineEventSchema),
});
export type Timeline = z.infer<typeof timelineSchema>;
