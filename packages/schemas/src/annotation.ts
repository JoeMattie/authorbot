import { z } from "zod";
import { actorRefSchema, timestampSchema, uuidv7Schema } from "./primitives.js";

/** Annotation lifecycle states (contract section 4, design section 9.4). */
export const ANNOTATION_STATUSES = [
  "open",
  "work_item_created",
  "accepted",
  "resolved",
  "rejected",
  "withdrawn",
  "superseded",
  "orphaned",
  "needs_reanchor",
] as const;
export const annotationStatusSchema = z.enum(ANNOTATION_STATUSES);
export type AnnotationStatus = z.infer<typeof annotationStatusSchema>;

export const ANNOTATION_KINDS = ["comment", "suggestion"] as const;
export const annotationKindSchema = z.enum(ANNOTATION_KINDS);
export type AnnotationKind = z.infer<typeof annotationKindSchema>;

/**
 * Range target selector (design section 10.1). Selector field names are
 * camelCase exactly as in the design payload: `blockId`, `textPosition`,
 * `textQuote`. Positions are offsets into the normalized plain-text stream of
 * the block, not raw HTML offsets.
 */
export const textPositionSchema = z.strictObject({
  start: z.number().int().min(0),
  end: z.number().int().min(0),
});
export type TextPosition = z.infer<typeof textPositionSchema>;

/** Contract 2b §2.2: quote context is at most 32 characters each side. */
export const MAX_QUOTE_CONTEXT = 32;
/**
 * Server-side ceiling for `textQuote.exact` (a selection within a single
 * semantic block, so far below the 32 KiB body limit). Enforced here so an
 * attacker-chosen selector can never smuggle megabytes into the annotations
 * row and the committed `.authorbot/annotations/<id>/annotation.md` artifact.
 */
export const MAX_QUOTE_EXACT = 8 * 1024;

export const textQuoteSchema = z.strictObject({
  exact: z.string().min(1).max(MAX_QUOTE_EXACT),
  prefix: z.string().max(MAX_QUOTE_CONTEXT).optional(),
  suffix: z.string().max(MAX_QUOTE_CONTEXT).optional(),
});
export type TextQuote = z.infer<typeof textQuoteSchema>;

export const rangeTargetSchema = z.strictObject({
  blockId: uuidv7Schema,
  textPosition: textPositionSchema,
  textQuote: textQuoteSchema,
});
export type RangeTarget = z.infer<typeof rangeTargetSchema>;

export const blockTargetSchema = z.strictObject({
  blockId: uuidv7Schema,
});
export type BlockTarget = z.infer<typeof blockTargetSchema>;

const annotationBaseFields = {
  schema: z.literal("authorbot.annotation/v1"),
  id: uuidv7Schema,
  kind: annotationKindSchema,
  chapter_id: uuidv7Schema,
  chapter_revision: z.number().int().min(1),
  author: actorRefSchema,
  status: annotationStatusSchema,
  created_at: timestampSchema,
} as const;

/**
 * Annotation frontmatter `.authorbot/annotations/<id>/annotation.md` —
 * `authorbot.annotation/v1` (contract section 4). `target` is required for
 * `range` and `block` scopes and forbidden for `chapter` scope.
 */
export const annotationSchema = z.discriminatedUnion("scope", [
  z.strictObject({
    ...annotationBaseFields,
    scope: z.literal("range"),
    target: rangeTargetSchema,
  }),
  z.strictObject({
    ...annotationBaseFields,
    scope: z.literal("block"),
    target: blockTargetSchema,
  }),
  z.strictObject({
    ...annotationBaseFields,
    scope: z.literal("chapter"),
  }),
]);
export type Annotation = z.infer<typeof annotationSchema>;

/**
 * Reply frontmatter `.authorbot/annotations/<id>/replies/<reply-id>.md` —
 * `authorbot.reply/v1`. The contract pins only the schema ID; fields follow
 * the Reply entity of design section 9.1 (ID, annotation ID, optional parent
 * reply, author, timestamps). The reply body is the Markdown content itself.
 */
export const replySchema = z.strictObject({
  schema: z.literal("authorbot.reply/v1"),
  id: uuidv7Schema,
  annotation_id: uuidv7Schema,
  parent_reply_id: uuidv7Schema.optional(),
  author: actorRefSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema.optional(),
});
export type Reply = z.infer<typeof replySchema>;
