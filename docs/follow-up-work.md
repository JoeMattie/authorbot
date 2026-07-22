# Follow-up work

This is the live queue for product and repository improvements that should not
be hidden inside an unrelated stabilization pull request. The Phase 11
implementation contract remains the ordered plan for slices 3 through 7. Items
below say where they fit when that is already clear and preserve open design
questions when it is not.

## Repository hygiene

### Delete merged branches

There is no product or release reason to retain ordinary merged pull-request
branches. Tags preserve releases, Git preserves merged commits, and an old
branch can be recreated from its final commit if it is ever needed.

- Keep `main`, active pull-request branches, and any explicitly documented
  long-running integration branch.
- Enable GitHub's automatic deletion of same-repository head branches after a
  pull request merges.
- Make the release and `authorbot upgrade` closeout paths verify that the remote
  branch was deleted and prune the matching local tracking branch when it is
  safe to do so.
- Never delete an unmerged branch, a branch owned by another active agent, or a
  fork branch the repository does not own.
- Audit the current remote branch list once, identify merged heads, and remove
  them in a dedicated repository-maintenance change.

This is independent of the Phase 11 product slices and can be done after the
current pull request without waiting for later features.

## Work history and attribution

### Keep completed Work visible

The Work page should not make completed items disappear. Keep the active queue
first, then provide a bounded, paginated Completed section. Each completed stub
should show at least:

- the work type and source note or suggestion;
- the affected chapter;
- who submitted the completed work, using the human display name or agent token
  name rather than an internal actor id;
- when it completed;
- the resulting chapter revision or commit; and
- links to the settled source card and the revision or diff when those surfaces
  are available.

If a later maintainer approval is distinct from submission, show both
`Completed by` and `Approved by`. Do not credit voters, commenters, claimants
who released the lease, or the merge bot as prose contributors.

The initial release may render compact stubs from existing Work, submission,
operation, and attribution records. It must not load the complete Work history
or make one repository request per item. The richer diff link should fold into
Phase 11 slice 4, and historical browsing can reuse slice 7.

## Chapter notes presentation

These refinements apply to anchored comments and suggestions. Chapter-wide
Discussion remains a separate surface at the bottom of the chapter and is not
part of the Notes list.

### Sidebar content and stable order

- Remove `Signed in as ...` from the Notes sidebar. Account identity already
  belongs in the shared account control.
- Sort once by manuscript occurrence and never reorder because an item was
  clicked, focused, expanded, voted on, or updated.
- Put whole-chapter notes first. Follow them with anchored notes in block order
  and selector offset order. Use creation time and stable id only as tie
  breakers for the same target.
- Keep Discussion below the manuscript and outside this ordering model.

### Collapse and expansion

- A note is a single-line summary while its manuscript target is outside the
  viewport.
- Expand it when its target enters the reading viewport or when the reader
  explicitly activates the note.
- An explicitly activated note stays expanded until the reader closes it or
  activates another note. Expansion changes presentation only, never list
  order.
- Preserve the existing behavior that activating an anchored suggestion brings
  its target into view.

### Block-note affordance

- Hovering the `Note on this block` icon outlines the exact manuscript block
  that will receive the note and shows a concise tooltip.
- Keyboard focus on the icon produces the same outline and tooltip. The icon
  has an accessible name and the tooltip is exposed as its description rather
  than existing only as visual hover text.
- The outline must not move the manuscript or change line wrapping. It clears
  on pointer exit, blur, cancellation, or after the note composer closes.
- Touch users receive the same target confirmation when they activate the
  affordance, before writing or submitting the note.

### Overflow

The desktop Notes rail should use the available viewport height. It gets its
own vertical scrolling only when the ordered notes or one expanded card cannot
fit. Short lists should not show a redundant nested scrollbar. Previous and
Next note controls remain reachable while the note list scrolls.

### Mobile inline notes

At mobile widths, do not use a side panel or drawer for anchored notes. Mount
each note as a full-width block immediately after its containing manuscript
block, with full line breaks around it. Whole-chapter notes appear before the
first manuscript block. Multiple notes on one block retain their stable order.
Discussion remains after the chapter.

This is a focused presentation follow-up to Phase 11 slices 1 and 2. The
chapter-wide Discussion separation also becomes an acceptance condition for
slice 6.

## Chapter summaries and the outline

### Permissioned summary updates

Contributors and agents need a supported way to propose a new chapter summary.
The summary is Git-backed chapter metadata, so it must not become an untracked
database field or a browser-only override.

Fold the authorization work into Phase 11 slice 3 and the review path into
slices 4 and 5:

- define an explicit canonical capability for proposing chapter metadata
  changes rather than inheriting it from a broad legacy scope;
- require chapter id, current revision or content hash, proposed summary, an
  idempotency key, and attribution;
- represent a contributor or agent change as a reviewable metadata proposal;
- let a maintainer approve or reject it through the same diff and audit model
  as a prose revision; and
- commit an approved summary to the chapter frontmatter, then rebuild the site
  normally.

Maintainers may eventually get a direct edit shortcut, but the durable result
must use the same validated Git path and attribution record.

### Generated chapter summaries on the Outline page

Generate a clearly labeled `Chapter summaries` section on the published
Outline page from current chapter frontmatter at build time. Keep it separate
from the curated outline Markdown and never rewrite that author-maintained file
as a side effect of changing a chapter summary.

- Use canonical chapter order.
- Show unpublished chapters only to authenticated collaborators who may read
  them; the public Outline includes published chapters only.
- Removing a summary removes that chapter's generated entry on the next build.
- The generated section is published navigation derived from canonical chapter
  metadata, not a second canonical planning document.
- The curated Outline itself remains directly editable through the Slice 5
  Milkdown proposal and maintainer-apply workflow.

## Chapter contributor display

Show contributors in addition to the chapter author on both the chapter page
and the chapter index.

- Derive contributors from accepted chapter prose and metadata attribution,
  not from comments, votes, rejected proposals, or lease claims alone.
- Use a human display name or agent token name and never expose an internal
  actor UUID as the primary label.
- Deduplicate repeated contributions by the same credited identity.
- On a chapter page, show the complete contributor list with links to the
  applicable accepted revisions when available.
- On the index, keep the row compact by showing a bounded list and a remaining
  count.
- Preserve the distinction between the chapter's author, a revision
  contributor, and a maintainer who approved the revision.

The attribution model belongs with Phase 11 slice 4. Slice 7 can add the links
from each contributor to the historical revisions they changed.

## Proposed order

1. Finish and ship the current shared-state work.
2. Clean up merged branches and enable automatic future cleanup.
3. Ship the Notes presentation refinements without coupling them to new
   revision schemas.
4. Continue Phase 11 slice 3 permissions.
5. Add summary proposals, completed Work attribution, contributor display, and
   diff links alongside slices 4 and 5.
6. Add the generated Chapter summaries section without rewriting curated
   outline content.
7. Carry the Discussion separation into slice 6 and historical contributor
   links into slice 7.
