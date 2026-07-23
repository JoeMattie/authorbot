import { z } from "zod";
import { uuidv7Schema, type AnnotationKind } from "@authorbot/schemas";
import { ALLOWED, type Decision } from "./decision.js";

/**
 * Vote commands (Phase 3 contract section 2):
 * `PUT /v1/projects/{p}/annotations/{id}/vote` with `{ value }`, `DELETE`
 * clears. One current vote per actor is a DB uniqueness concern (upsert);
 * this module pins the command shapes and kind support.
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

export type VoteDenialReason = never;

/**
 * Both comments and suggestions use the same one-current-vote resource. The
 * API applies the exact kind capability and keeps comment tallies out of the
 * suggestion-to-Work rule. Status is deliberately checked by that serialized
 * API command because suggestion votes remain legal after a sticky crossing.
 */
export function authorizeVote(input: {
  annotationKind: AnnotationKind;
}): Decision<VoteDenialReason> {
  void input;
  return ALLOWED;
}
