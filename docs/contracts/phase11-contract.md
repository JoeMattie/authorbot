# Phase 11 implementation contract - editorial revision workflow

Subordinate to `AUTHORBOT_PROJECT_DESIGN.md` and additive to the Phase 0-10
contracts. Where this contract changes an earlier interaction, the change is
explicit below. The work ships in six independently releasable slices, in the
order listed here.

## 1. Scope and sequence

1. **Turn feedback into Work.** A maintainer can promote any open comment or
   suggestion with one button. Promotion creates the existing scope-derived
   work item and never asks for a reason or confirmation. Rejecting a
   suggestion remains a separate, reason-required action.
2. **Unify browser state.** A single framework-free client store owns API
   actions, optimistic state, event reconciliation, and shared page status.
3. **Review whole-chapter revisions.** Approved chapter work accepts a full
   chapter replacement as a proposed revision. It does not change published
   prose until a maintainer reviews the diff and approves it. Rejection keeps
   the current chapter byte-identical and may return the item to Work.
4. **Edit the manuscript in place.** Editors and maintainers get an explicit
   Edit action on a chapter. The manuscript becomes a focused rich-text editing
   surface in its reading position, not a textarea appended below the chapter.
   Submit creates the same reviewable whole-chapter revision from slice 3.
5. **Chapter-wide threads.** The existing chapter annotation scope becomes the
   Discussion surface, including replies and promotion to Work. It reuses the
   annotation, reply, identity, moderation, and projection machinery rather
   than introducing a second comment system.
6. **Walk chapter history.** Readers with access to revision history can move
   backward from the current chapter to its original version in an inline,
   diff-augmented time-machine view. Restoring an old version creates a
   reviewable proposal rather than changing published prose directly.

Slices 3-5 may add schema or migration work, but each slice must upgrade an
existing book safely and remain deployable on its own.

## 2. Slice 1 - one-click promotion and note navigation

### 2.1 Promotion contract

- Offer `Promote to work` only to a maintainer and only for an `open` comment
  or suggestion whose Git mirror is settled.
- Activating the button immediately POSTs the existing
  `/annotations/{id}/force-create-work-item` command. The body is `{}`. The
  API may continue accepting an optional legacy `reason`, but promotion never
  requires one.
- Authorization is maintainer-only. The credential must still carry the
  existing work scope. Work type continues to derive from annotation scope:
  range to `revise_range`, block to `revise_block`, and chapter to
  `revise_chapter`.
- Promotion remains atomic and idempotent across rule crossings and concurrent
  maintainer requests: one decision, one work item, one annotation transition,
  and one Git operation. A second creation attempt returns the existing 409
  conflict behavior.
- The audit trail records actor, action, target, decision, work item, time, and
  correlation id. A reason is not fabricated. Legacy callers that send a
  reason retain it in the decision artifact.
- Suggestion rejection and work cancellation remain reason-required. Comments
  do not gain reject or vote controls.
- A promoted comment's work artifact says to address the note. It must not call
  the comment a suggestion or present its body as already-final prose.

This section supersedes the Phase 3 and Phase 6 requirement that force-create
always include a maintainer-authored reason. It does not change the reason
requirement for the other overrides.

### 2.2 Settled card

Once promotion succeeds, the card updates immediately without waiting for a
poll. The open controls collapse into a settled summary:

- the entire compact card uses a green accepted treatment and a visible
  `Accepted` badge identifies that the feedback was accepted into Work;
- a range suggestion keeps its compact before/after diff;
- a comment keeps its note text and target context;
- the `Queued as work item` message, vote tally, override explanation,
  maintainer counts, promotion, rejection, reply, and withdraw controls are
  absent from the settled card; and
- the card remains selectable so its manuscript target can be located.

The canonical annotation status remains `work_item_created`. `Accepted` is UI
copy for acceptance into the work queue, not a claim that the prose revision
has already landed.

### 2.3 Previous and next navigation

The chapter rail and mobile drawer share Previous and Next note buttons plus a
current-position indicator. Navigation follows the deterministic visible-card
order, moves focus to the card, marks it active, and scrolls its manuscript
target into view. The buttons are disabled at their respective ends and expose
descriptive accessible names.

### 2.4 Slice 1 exit criteria

1. API and domain tests cover reasonless promotion of both comments and
   suggestions, maintainer and scope enforcement, optional legacy reasons,
   atomic uniqueness, and correct work type for all scopes.
2. Publisher tests prove one activation sends `{}`, rejection still requires a
   reason, and non-maintainers see no promotion control.
3. After a 201 response, comment and suggestion cards immediately show the
   settled view and `Accepted` badge.
4. Previous and Next traverse the full ordered set, update the position, focus
   the card, scroll the target, and handle zero, one, first, and last states.
5. The affected package tests, typecheck, build, formatting checks, and
   OpenAPI synchronization pass.

## 3. Slice 2 - shared browser state

- Use a project-scoped store built with `zustand/vanilla`. The site remains
  framework-free; custom elements become small view adapters that subscribe to
  selected state instead of each owning an API client, polling loop, and copy
  of the same entities.
- Normalize session, project, chapter metadata, annotations, replies, Work,
  revision proposals, operations, and connection state. API mutations are
  named store actions and retain existing idempotency keys.
- Apply optimistic transitions for collaboration and workflow state, with the
  prior value retained for rollback. Reconcile every action from its response
  and the existing event feed, then refetch authoritative resources after a
  reconnect or ambiguous failure.
- Static manuscript prose remains the last published build. An in-progress edit
  may render as a local preview, and an approved revision may announce that a
  newer build is landing, but the store must not relabel unapproved or
  undeployed prose as published truth.
- Keep lease tokens and other credentials in memory only. Do not place them in
  persisted Zustand middleware, browser storage, logs, or serialized state.
- Convert the chapter rail first, then account/Work/editor/review surfaces. A
  compatibility adapter keeps each conversion independently releasable.

## 4. Slice 3 - proposed chapter revisions and diff review

- Reuse `revise_chapter`, `chapter_replacement`, leases, base revision/hash,
  operation tracking, and the conservative conflict policy.
- Split submission receipt from application for review-required revisions. A
  successful submission creates an immutable proposed-revision record holding
  base identity, proposed content, author, work item, and summary. It does not
  write the chapter.
- Maintainers see a readable chapter diff with unchanged context, additions,
  deletions, author, base/current revision, and any conflict warning.
- Approve applies the proposal through the existing validated Git write path,
  updates attribution and linked artifacts atomically, and triggers the normal
  deployment path. Reject records the maintainer decision without changing the
  chapter. Every decision is idempotent and audited.
- A proposal whose base moved is never silently applied. It must either pass
  the existing deterministic rebase rules or become an explicit conflict.

## 5. Slice 4 - permission-gated in-place chapter editing

- Show Edit only to editor and maintainer roles that also hold the required
  submission scope. The API remains the authorization boundary.
- Edit mode replaces the rendered manuscript body in place and preserves a
  clean reading-width layout. It supports ordinary prose structure and
  round-trips to safe canonical Markdown without raw HTML.
- Cancel restores the untouched reading view. Submit captures the current
  chapter revision/hash and creates a proposed whole-chapter revision through
  slice 3. It never publishes directly.
- The editor clearly reports saving, review pending, stale base, rejection,
  approval, and deployment states. Draft text survives recoverable errors and
  navigation warnings prevent accidental loss.

## 6. Slice 5 - chapter-wide discussion threads

- Replace the static Discussion placeholder with chapter-scoped comment
  creation and the existing nested reply tree.
- Threads obey the same identity, visibility, plain-text safety, pending-Git,
  withdrawal, moderation, and rebuild rules as anchored annotations.
- A chapter thread can be promoted to `revise_chapter` by the one-click action
  from slice 1. Promoted threads use the same settled `Accepted` presentation.
- Thread list reads are paginated or batched so a chapter cannot create an
  unbounded Worker subrequest fan-out.

## 7. Slice 6 - inline chapter history

- Add a chapter-history entry point beside the reading controls. Opening it
  keeps the manuscript in place and layers a spatial revision timeline around
  it, with a stacked, time-machine-style sense of moving backward through the
  chapter rather than navigating to a raw commit log.
- Previous and Next revision controls walk from the current chapter to revision
  1 and back. A directly selectable revision list remains visible so the
  interface never requires repeated animation or blind stepping.
- Each stop shows revision number, commit, time, author attribution,
  publication state, and a readable inline diff against either the adjacent
  revision or the current version. Unchanged context stays available around
  additions and deletions.
- The current published version is always unmistakable. Browsing history is
  read-only. `Propose restoring this version` creates a new proposal through
  the slice 3 review workflow; it never rewinds Git or publishes directly.
- Reuse the slice 3 diff representation and the slice 2 store. Fetch bounded,
  paginated history metadata and one selected snapshot/diff at a time rather
  than making one repository request per version in a Worker invocation.
- Motion is decorative, respects `prefers-reduced-motion`, and has a complete
  keyboard and screen-reader equivalent. The static manuscript remains usable
  if history loading fails.

## 8. Release discipline

Each slice lands through its own reviewed pull request, includes any required
book-format migration and upgrade guidance, and cuts a patch release only
after CI and the release smoke checks pass. Slice 5 starts after slices 1-4 are
shipped, and slice 6 builds on the shipped store and revision-review model.
