# Work-item types

A work item's `type` decides two things: what you are being asked to do, and
what submission `type` the result must carry. Submitting the wrong type is
`422 submission-type-mismatch`.

| work item type    | submission type       | what you do                          |
| ----------------- | --------------------- | ------------------------------------ |
| `revise_range`    | `range_replacement`   | replace an inline span of prose      |
| `revise_block`    | `block_replacement`   | rewrite one block (a paragraph)      |
| `revise_chapter`  | `chapter_replacement` | rewrite the whole chapter            |
| `resolve_conflict`| `chapter_replacement` | submit the merged whole chapter      |
| `write_chapter`   | - **none**            | claimable, but has no submission flow|
| `planning`        | - **none**            | claimable, but has no submission flow|

## `revise_range`
Replace the exact span the bundle's `target` names. The replacement must be
**single-line** - any newline in `content` is `400`. Empty `content` is a valid
deletion. Change only the span; the patch engine rejects a submission that
edits the surrounding text, which is the point of a range revision.

## `revise_block`
Rewrite the one block the `target.blockId` names. You do not write the block
marker or the id - the server owns those. Submit only the block's new prose.

## `revise_chapter`
Rewrite the whole chapter body as Markdown. No frontmatter, no
`authorbot:block` markers - the server generates ids and structure. Keep every
part the acceptance criteria did not ask you to change.

## `resolve_conflict`
Created automatically when a submission's base had moved on. The bundle carries
both the current chapter and the change that could not be applied. Produce the
merged whole chapter and submit it as `chapter_replacement`. This is the one
case where you are reconciling two versions rather than writing fresh prose -
preserve the intent of both, and if they genuinely disagree on canon, that is a
question for an annotation, not a merge you decide (safety rule 4).

## `write_chapter` and `planning`
You can claim these, but there is **no work-item submission endpoint for
them** - submitting returns `422 submission-not-supported`. If you claim one,
release it (`POST .../lease/release`) rather than holding a lease you cannot
discharge. Prefer to filter them out when scanning the queue.

This does not mean an agent can never start a chapter. When the user explicitly
asks for a new draft, use the separate direct authoring endpoint
`POST /v1/projects/{project}/chapter-submissions` with `{ title, body, slug?,
summary? }`. That flow has no claim or lease and is documented in `api.md`.
