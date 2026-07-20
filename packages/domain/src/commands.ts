import { z } from "zod";
import {
  annotationKindSchema,
  blockTargetSchema,
  rangeTargetSchema,
  uuidv7Schema,
} from "@authorbot/schemas";
import { scopeSchema } from "./scopes.js";

/**
 * Command validators (Phase 2 contract section 4). A command is the API
 * payload plus its route parameters merged by the API layer (e.g. the
 * `chapterId` from the URL joins the annotation payload), so validation of a
 * whole logical command lives in one place. Markdown safety of bodies (raw
 * HTML, URL schemes) stays with `@authorbot/markdown` at the API layer; this
 * package enforces shape, sizes, and cross-field rules only.
 */

/** UTF-8 byte length without relying on host globals (pure, worker-safe). */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** Body limit (contract section 4): Markdown <= 32 KiB, measured in UTF-8 bytes. */
export const MAX_BODY_BYTES = 32 * 1024;

/**
 * Canonical body form: CRLF folded to LF, leading/trailing whitespace
 * trimmed. This is exactly the normalization the artifact renderer applies
 * (repo-coordinator render.ts) and the repo reader re-applies on read, so
 * normalizing once at intake keeps the DB row, the committed artifact, and a
 * rebuilt projection byte-identical (a projection rebuild must not change
 * annotation/reply bodies served by the API).
 */
export function normalizeBody(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

export const bodySchema = z
  .string()
  .transform(normalizeBody)
  .refine((value) => value.length > 0, "body must not be empty")
  .refine(
    (value) => utf8ByteLength(value) <= MAX_BODY_BYTES,
    `body must be at most ${MAX_BODY_BYTES} bytes of UTF-8`,
  );

/** Range target with the contract's ordering rule: `textPosition.end > start`. */
export const orderedRangeTargetSchema = rangeTargetSchema.refine(
  (target) => target.textPosition.end > target.textPosition.start,
  { path: ["textPosition", "end"], message: "textPosition.end must be greater than textPosition.start" },
);

const createAnnotationBase = {
  chapterId: uuidv7Schema,
  kind: annotationKindSchema,
  chapterRevision: z.number().int().min(1),
  body: bodySchema,
} as const;

/**
 * `POST .../chapters/{chapterId}/annotations` (contract section 4).
 * `target` is required for `range` (blockId + textPosition + textQuote) and
 * `block` (blockId only) scopes and forbidden for `chapter` scope. Whether
 * the chapter/revision/block actually exist is the API's projection check.
 */
export const createAnnotationCommandSchema = z.discriminatedUnion("scope", [
  z.strictObject({
    ...createAnnotationBase,
    scope: z.literal("range"),
    target: orderedRangeTargetSchema,
  }),
  z.strictObject({
    ...createAnnotationBase,
    scope: z.literal("block"),
    target: blockTargetSchema,
  }),
  z.strictObject({
    ...createAnnotationBase,
    scope: z.literal("chapter"),
  }),
]);
export type CreateAnnotationCommand = z.infer<typeof createAnnotationCommandSchema>;

/**
 * `POST .../annotations/{annotationId}/replies`. The contract pins no reply
 * payload; this package pins `{ body, parentReplyId? }` with the same 32 KiB
 * body rule as annotations.
 */
export const createReplyCommandSchema = z.strictObject({
  annotationId: uuidv7Schema,
  parentReplyId: uuidv7Schema.optional(),
  body: bodySchema,
});
export type CreateReplyCommand = z.infer<typeof createReplyCommandSchema>;

/** Token display-name bound (not contract-pinned; chosen for UI sanity). */
export const MAX_TOKEN_NAME_LENGTH = 100;

/**
 * `POST .../agent-tokens` (contract section 3): name, scopes ⊆ known scopes
 * (non-empty, no duplicates), expiry <= 90 days (default 30).
 */
export const mintAgentTokenCommandSchema = z.strictObject({
  name: z
    .string()
    .min(1, "name must not be empty")
    .max(MAX_TOKEN_NAME_LENGTH, `name must be at most ${MAX_TOKEN_NAME_LENGTH} characters`),
  scopes: z
    .array(scopeSchema)
    .min(1, "at least one scope is required")
    .refine(
      (scopes) => new Set(scopes).size === scopes.length,
      "scopes must not contain duplicates",
    ),
  expiresInDays: z.number().int().min(1).max(90).default(30),
});
export type MintAgentTokenCommand = z.infer<typeof mintAgentTokenCommandSchema>;
export type MintAgentTokenCommandInput = z.input<typeof mintAgentTokenCommandSchema>;

/**
 * `POST .../annotations/{annotationId}/withdraw`. The HTTP body is empty;
 * the command is the route parameter. Authorization (author-or-maintainer)
 * is `authorizeAnnotationWithdraw` in annotation-state.
 */
export const withdrawAnnotationCommandSchema = z.strictObject({
  annotationId: uuidv7Schema,
});
export type WithdrawAnnotationCommand = z.infer<typeof withdrawAnnotationCommandSchema>;
