import { z } from "zod";
import { nodeIdOf } from "./primitives.js";

/**
 * Character frontmatter `story/characters/*.md` - `authorbot.character/v1`
 * (contract section 4).
 */
export const characterSchema = z.strictObject({
  schema: z.literal("authorbot.character/v1"),
  id: nodeIdOf("character"),
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).optional(),
  summary: z.string().optional(),
  /** Free-form record status; the contract does not pin an enum. */
  status: z.string().min(1).optional(),
});
export type Character = z.infer<typeof characterSchema>;
