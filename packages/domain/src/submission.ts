import { z } from "zod";
import { type WorkItemType, uuidv7Schema } from "@authorbot/schemas";
import { ALLOWED, denied, type Decision } from "./decision.js";
import { bodySchema, utf8ByteLength } from "./commands.js";
import { leaseTokenSchema } from "./lease-token.js";

/**
 * Submission command validation and the work-item-type -> submission-type
 * capability mapping (Phase 4 contract section 4, design section 12.5).
 * This module enforces shape, sizes, and cross-field rules only; Markdown
 * prose safety on `content` (no raw HTML, allowed URL schemes) stays with
 * `@authorbot/markdown` at the API layer, and lease-token verification is
 * the API's constant-time hash compare.
 */

/** Phase 4 submission types (contract sections 1, 4). */
export const SUBMISSION_TYPES = [
  "range_replacement",
  "block_replacement",
  "chapter_replacement",
] as const;
export const submissionTypeSchema = z.enum(SUBMISSION_TYPES);
export type SubmissionType = z.infer<typeof submissionTypeSchema>;

/** Task-bundle `submissionSchema` id per type (design section 15.3). */
export const SUBMISSION_SCHEMA_IDS: Readonly<Record<SubmissionType, string>> =
  Object.freeze({
    range_replacement: "authorbot.submission/range-replacement/v1",
    block_replacement: "authorbot.submission/block-replacement/v1",
    chapter_replacement: "authorbot.submission/chapter-replacement/v1",
  });

/**
 * Which submission type a work-item type requires (contract section 4:
 * range -> range_replacement, block -> block_replacement, chapter ->
 * chapter_replacement). `null` means the type is claimable but has no
 * submission flow in Phase 4 (`write_chapter`/`planning`, contract
 * section 1). Resolved ambiguity: `resolve_conflict` items carry both texts
 * and are resolved by submitting the merged chapter, so they take
 * `chapter_replacement`.
 */
export const WORK_ITEM_SUBMISSION_TYPES: Readonly<
  Record<WorkItemType, SubmissionType | null>
> = Object.freeze({
  revise_range: "range_replacement",
  revise_block: "block_replacement",
  revise_chapter: "chapter_replacement",
  resolve_conflict: "chapter_replacement",
  write_chapter: null,
  planning: null,
});

/** The submission type a work-item type requires, or null when none exists yet. */
export function requiredSubmissionType(type: WorkItemType): SubmissionType | null {
  return WORK_ITEM_SUBMISSION_TYPES[type];
}

export type SubmissionTypeDenialReason =
  | "submission-type-mismatch"
  | "submission-not-supported";

/**
 * The "type matches work-item type" step of the contract section 4
 * verification order. `write_chapter`/`planning` deny with
 * `submission-not-supported` (deferred flow) so the API can surface an
 * honest problem type instead of a generic mismatch.
 */
export function checkSubmissionTypeMatches(
  workItemType: WorkItemType,
  submissionType: SubmissionType,
): Decision<SubmissionTypeDenialReason> {
  const required = WORK_ITEM_SUBMISSION_TYPES[workItemType];
  if (required === null) {
    return denied(
      "submission-not-supported",
      `work items of type "${workItemType}" have no submission flow in Phase 4`,
    );
  }
  if (required !== submissionType) {
    return denied(
      "submission-type-mismatch",
      `work items of type "${workItemType}" require a "${required}" submission`,
    );
  }
  return ALLOWED;
}

/** Content cap (contract section 4): <= 512 KiB, measured in UTF-8 bytes. */
export const MAX_SUBMISSION_CONTENT_BYTES = 512 * 1024;

/** `sha256:` + 64 lowercase hex chars (task-bundle `contentHash` shape, section 15.3). */
export const CONTENT_HASH_REGEX = /^sha256:[0-9a-f]{64}$/;
export const contentHashSchema = z
  .string()
  .regex(CONTENT_HASH_REGEX, "must be 'sha256:' followed by 64 lowercase hex characters");

/**
 * Replacement content: CRLF folded to LF (matching chapter storage) but NOT
 * trimmed - leading/trailing whitespace is meaningful in a range
 * replacement. Emptiness is a per-type rule handled in the command schema:
 * an empty `range_replacement` is a deletion and legal; block and chapter
 * replacements must be non-empty.
 */
const submissionContentSchema = z
  .string()
  .transform((value) => value.replace(/\r\n/g, "\n"))
  .refine(
    (value) => utf8ByteLength(value) <= MAX_SUBMISSION_CONTENT_BYTES,
    `content must be at most ${MAX_SUBMISSION_CONTENT_BYTES} bytes of UTF-8`,
  );

const submitWorkBase = {
  workItemId: uuidv7Schema,
  leaseId: uuidv7Schema,
  leaseToken: leaseTokenSchema,
  baseRevision: z.number().int().min(1),
  baseContentHash: contentHashSchema,
  content: submissionContentSchema,
  /**
   * `summary`/`notes` are unpinned by the contract; this package reuses the
   * annotation body rule (normalized, non-empty, <= 32 KiB UTF-8).
   */
  summary: bodySchema.optional(),
  notes: bodySchema.optional(),
} as const;

/**
 * `POST /work-items/{id}/submissions` (contract section 4): the HTTP body
 * `{ leaseId, leaseToken, type, baseRevision, baseContentHash, content,
 * summary?, notes? }` merged with the route's `workItemId`. The
 * `Idempotency-Key` header, lease/holder/token verification, work-item
 * state, and base-matches-bundle checks are separate ordered steps
 * (`checkLeaseActive`, `transitionWorkItemPhase4`,
 * `checkSubmissionTypeMatches`, `checkSubmissionBase`).
 */
export const submitWorkCommandSchema = z
  .strictObject({ ...submitWorkBase, type: submissionTypeSchema })
  .superRefine((command, ctx) => {
    if (command.type !== "range_replacement" && command.content.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message: `content must not be empty for a ${command.type}`,
      });
    }
  });
export type SubmitWorkCommand = z.infer<typeof submitWorkCommandSchema>;

export type SubmissionBaseDenialReason =
  | "base-revision-mismatch"
  | "base-hash-mismatch";

/**
 * The "baseRevision + baseContentHash match the lease's bundle" step
 * (contract section 4). Revision is checked before hash so the commoner
 * staleness cause surfaces first. Hash comparison here is not secret
 * material (both values are content hashes the client already holds), so a
 * plain compare is correct - constant-time treatment is for lease tokens.
 */
export function checkSubmissionBase(
  bundle: { readonly baseRevision: number; readonly baseContentHash: string },
  submission: { readonly baseRevision: number; readonly baseContentHash: string },
): Decision<SubmissionBaseDenialReason> {
  if (submission.baseRevision !== bundle.baseRevision) {
    return denied(
      "base-revision-mismatch",
      `submission is against revision ${submission.baseRevision} but the lease was issued for revision ${bundle.baseRevision}`,
    );
  }
  if (submission.baseContentHash !== bundle.baseContentHash) {
    return denied(
      "base-hash-mismatch",
      "submission base content hash does not match the lease's task bundle",
    );
  }
  return ALLOWED;
}
