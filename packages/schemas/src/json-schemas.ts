import { z } from "zod";
import { annotationSchema, replySchema } from "./annotation.js";
import { attributionSchema } from "./attribution.js";
import { bookConfigSchema } from "./book.js";
import { buildManifestSchema } from "./build.js";
import { chapterFrontmatterSchema } from "./chapter.js";
import { characterSchema } from "./character.js";
import { decisionSchema } from "./decision.js";
import { instanceConfigSchema } from "./instance.js";
import { releaseSchema } from "./release.js";
import { storyGraphSchema } from "./story-graph.js";
import { timelineSchema } from "./timeline.js";
import { workItemSchema } from "./work-item.js";

/** All artifact schemas keyed by the JSON Schema output file basename. */
export const artifactSchemas = {
  book: bookConfigSchema,
  chapter: chapterFrontmatterSchema,
  "story-graph": storyGraphSchema,
  timeline: timelineSchema,
  character: characterSchema,
  annotation: annotationSchema,
  reply: replySchema,
  decision: decisionSchema,
  "work-item": workItemSchema,
  attribution: attributionSchema,
  release: releaseSchema,
  instance: instanceConfigSchema,
  build: buildManifestSchema,
} as const;
export type ArtifactName = keyof typeof artifactSchemas;

/** Schema discriminator IDs (contract section 4 table). */
export const SCHEMA_IDS: Record<ArtifactName, string> = {
  book: "authorbot.book/v1",
  chapter: "authorbot.chapter/v1",
  "story-graph": "authorbot.story-graph/v1",
  timeline: "authorbot.timeline/v1",
  character: "authorbot.character/v1",
  annotation: "authorbot.annotation/v1",
  reply: "authorbot.reply/v1",
  decision: "authorbot.decision/v1",
  "work-item": "authorbot.work-item/v1",
  attribution: "authorbot.attribution/v1",
  release: "authorbot.release/v1",
  instance: "authorbot.instance/v1",
  build: "authorbot.build/v1",
};

/**
 * Generate the draft 2020-12 JSON Schema document for every artifact, keyed
 * by output file basename (`<name>.schema.json`). `$id` is the artifact's
 * schema discriminator.
 */
export function buildJsonSchemas(): Record<ArtifactName, Record<string, unknown>> {
  const out = {} as Record<ArtifactName, Record<string, unknown>>;
  for (const name of Object.keys(artifactSchemas) as ArtifactName[]) {
    const generated = z.toJSONSchema(artifactSchemas[name], {
      target: "draft-2020-12",
    }) as Record<string, unknown>;
    out[name] = { $id: SCHEMA_IDS[name], ...generated };
  }
  return out;
}
