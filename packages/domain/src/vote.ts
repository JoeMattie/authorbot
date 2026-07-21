import { z } from "zod";
import { uuidv7Schema, type AnnotationKind } from "@authorbot/schemas";
import { ALLOWED, denied, type Decision } from "./decision.js";

/**
 * Vote commands (Phase 3 contract section 2):
 * `PUT /v1/projects/{p}/annotations/{id}/vote` with `{ value }`, `DELETE`
 * clears. One current vote per actor is a DB uniqueness concern (upsert);
 * this module pins the command shapes and the suggestion-only rule.
 */

/** Vote values (contract section 2; mirrors `authorbot.instance/v1` `votes.values`). */
export const VOTE_VALUES = ["approve", "reject", "abstain"] as const;
export const voteValueSchema = z.enum(VOTE_VALUES);
export type VoteValue = z.infer<typeof voteValueSchema>;

/** `PUT .../annotations/{annotationId}/vote` - route param + body merged. */
export const castVoteCommandSchema = z.strictObject({
  annotationId: uuidv7Schema,
  value: voteValueSchema,
});
export type CastVoteCommand = z.infer<typeof castVoteCommandSchema>;

/** `DELETE .../annotations/{annotationId}/vote` - the command is the route param. */
export const clearVoteCommandSchema = z.strictObject({
  annotationId: uuidv7Schema,
});
export type ClearVoteCommand = z.infer<typeof clearVoteCommandSchema>;

export type VoteDenialReason = "not-a-suggestion";

/**
 * Suggestion-only guard (contract section 2: votes on comments → 422). Votes
 * stay legal after `open` - sticky decisions require tracking vote changes on
 * `work_item_created` annotations (contract section 4) - so annotation status
 * is deliberately not checked here; `votes:write` scope enforcement is the
 * API layer's (`requireScope`).
 */
export function authorizeVote(input: {
  annotationKind: AnnotationKind;
}): Decision<VoteDenialReason> {
  if (input.annotationKind !== "suggestion") {
    return denied(
      "not-a-suggestion",
      "votes apply to suggestions only; comments cannot be voted on",
    );
  }
  return ALLOWED;
}
