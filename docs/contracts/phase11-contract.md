# Phase 11 implementation contract - editorial revision workflow

Subordinate to `AUTHORBOT_PROJECT_DESIGN.md` and additive to the Phase 0-10
contracts. Where this contract changes an earlier interaction, the change is
explicit below. The work is organized into seven ordered slices. Every
implementation increment must be independently deployable; slice 3 is
deliberately split into the 3A expand, 3B backfill, and 3C retire releases
defined in section 4.5.

## 1. Scope and sequence

1. **Turn feedback into Work.** A maintainer can promote any open comment or
   suggestion with one button. Promotion creates the existing scope-derived
   work item and never asks for a reason or confirmation. Rejecting a
   suggestion remains a separate, reason-required action.
2. **Unify browser state.** A single framework-free client store owns API
   actions, optimistic state, event reconciliation, shared page status, and
   chapter-navigation activity counts.
3. **Delegate editorial actions safely.** Agent tokens get explicit,
   deny-by-default permissions for the same editorial work a human can do,
   including comments, suggested edits, replies, votes, Work, and current
   chapter actions. Later slices extend the same model to revisions and
   history. Identity and project administration remain human-only.
4. **Review whole-chapter revisions.** Approved chapter work accepts a full
   chapter replacement as a proposed revision. It does not change published
   prose until a maintainer reviews the diff and approves it. Rejection keeps
   the current chapter byte-identical and may return the item to Work.
5. **Edit the manuscript in place.** Editors and maintainers get an explicit
   Edit action on a chapter. The manuscript becomes a focused rich-text editing
   surface in its reading position, not a textarea appended below the chapter.
   Submit creates the same reviewable whole-chapter revision from slice 4.
6. **Chapter-wide threads.** The existing chapter annotation scope becomes the
   Discussion surface, including replies and promotion to Work. It reuses the
   annotation, reply, identity, moderation, and projection machinery rather
   than introducing a second comment system.
7. **Walk chapter history.** Authorized editors and maintainers can move
   backward from the current chapter to its original version in an inline,
   diff-augmented time-machine view. Restoring an old version creates a
   reviewable proposal rather than changing published prose directly.

Slices 3-7 may add schema or migration work, but each slice must upgrade an
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
- Suggestion rejection and work cancellation remain reason-required. Slice 1
  does not add comment reject or vote controls; slice 3 adds explicitly
  permissioned, kind-scoped comment voting without changing the promotion rule.
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
2. Publisher tests prove one activation sends `{}`, range- and block-scoped
   comments expose promotion, rejection still requires a reason, and
   non-maintainers see no promotion control.
3. After a 201 response, comment and suggestion cards immediately show the
   settled view and `Accepted` badge.
4. Previous and Next traverse the full ordered set, update the position, focus
   the card, scroll the target, and handle zero, one, first, and last states.
5. The affected package tests, typecheck, build, formatting checks, and
   OpenAPI synchronization pass.

## 3. Slice 2 - shared browser state

Slice 2 ships in two independently releasable increments without weakening the
exit criteria below:

- **2A, authoritative read and badges:** introduce the project-scoped vanilla
  store for session and chapter projections, return the batched activity
  aggregate, and render the chapter activity badges from authoritative reads.
- **2B, optimistic workflows:** move mutation actions into the store, add
  optimistic transitions and rollback, reconcile the event feed, and perform
  authoritative refetches after reconnects or ambiguous failures.

The chapter activity release is slice 2A. Slice 2B completes the shared-state
contract with mutation, rollback, event, reconnect, and lease-recovery tests
covering the full slice 2 exit criteria.

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
  A browser may persist non-secret claim metadata and an in-progress draft.
  After a refresh it restores the capability through
  `POST .../lease/recover`, which is bound to the exact authenticated
  credential that claimed the still-live lease, atomically rotates the token
  hash, and returns the replacement plaintext once. A different login for the
  same actor cannot recover or replay it because current scope and credential
  binding are checked before idempotency lookup. Recovery never extends the
  lease, compare-and-swaps its observed timing snapshot against concurrent
  renewal, and idempotent replays redact the token.
- Convert the chapter rail first, then account/Work/editor/review surfaces. A
  compatibility adapter keeps each conversion independently releasable.

### 3.1 Chapter-navigation activity badges

- Every chapter row exposes a compact activity summary for open suggestions,
  anchored block/range comments, whole-chapter comments, open replies, and
  non-terminal work items. Work terminality comes from the domain lifecycle,
  not a second UI-maintained status list.
- The server derives all chapter counts in a bounded, batched read and returns
  them with the chapter list. The browser must not issue one annotations or Work
  request per chapter. Counts respect the caller's read permissions and never
  reveal the existence of feedback or Work the caller cannot read.
- This slice shows activity only to authenticated collaborators. Anonymous
  readers stay quiet even when public annotations are visible. Any future
  public rollup must use a separate published-only endpoint so the authenticated
  chapter list never leaks draft or archived metadata.
- An annotation contributes to an open-feedback count only when
  `annotation.status === "open"`. Feedback promoted to Work leaves its open
  feedback category and enters the non-terminal-Work count without being
  counted in both categories.
- A reply counts as open only while its own status and its authorized parent
  feedback are both `open`. Pending-Git and withdrawn replies do not count;
  replies under promoted, accepted, resolved, rejected, withdrawn, superseded,
  orphaned, or needs-reanchor parents do not count. Nested replies count
  individually. A caller who cannot read the parent kind receives no category
  field for those replies, rather than a misleading zero.
- Each visual badge has an accessible category and count. The chapter row also
  exposes one concise screen-reader summary, such as “2 open suggestions, 1
  block comment, 3 replies, 1 active work item.” Color and icon shape are never
  the only category cues, and an all-zero row stays quiet.
- In slice 2B, the store updates affected counts optimistically after create,
  withdraw, reply, promote, claim, submit, review, and other lifecycle actions.
  It reconciles from the mutation response and event feed, then refetches the
  server aggregate after reconnects or ambiguous failures.

### 3.2 Full slice 2 exit criteria (2A and 2B)

1. One paginated chapter-list read returns all authorized activity counts with
   a constant number of database queries, independent of chapter count.
2. API tests pin category definitions, permission filtering, lifecycle
   transitions, and zero-count behavior.
3. Publisher tests cover the compact and accessible breakdown at desktop and
   mobile widths, including pluralization and hidden unauthorized categories.
4. Store tests prove optimistic increments, decrements, category transfers,
   rollback, event reconciliation, and authoritative refetch.

## 4. Slice 3 - granular agent editorial permissions

### 4.1 Authorization model and boundary

The current implementation has eight domain scopes plus an API-only
`votes:write` extension. `annotations:write` covers creating comments and
suggestions, replying, withdrawing, and some maintainer transitions;
`work:claim` also gates promotion and cancellation; votes reject comments; and
the token-creation UI does not offer voting at all. Agent actors start as
editors but can later receive a maintainer membership, which makes any dormant
control-plane scope on the token dangerous. This slice replaces those coupled
behaviors rather than adding more special cases to them.

Human sessions continue to receive the editorial bundle associated with their
project role. An agent-token request must pass both independent checks:

1. the exact capability is named on that token; and
2. the agent actor's current project role admits that capability.

An absent capability always denies. A broad read or write capability never
implicitly grants a capability added in a later release. Raising an agent's
role can raise its ceiling, but it does not add capabilities to an existing
token. Granting the role or changing token capabilities requires a human
maintainer session and is audited.

This slice covers human-equivalent **editorial** actions, not authority
escalation. Agent-token credentials are unconditionally refused by token,
membership, settings, repository-integration, access-policy, freeze, pause,
deployment, and other project-control routes, even if a legacy row contains a
similarly named scope. `tokens:manage` and `members:manage` remain separate
human control-plane permissions and are not mintable agent-token capabilities.

### 4.2 Capability matrix

“Suggested edit” in this table means the existing `suggestion` annotation. A
whole-chapter revision proposal is a separate object whose capabilities arrive
with slice 4.

| Editorial action | Canonical token capability | Human role floor | Additional rule |
| --- | --- | --- | --- |
| Read chapter prose and metadata | `chapters:read` | reader | Does not imply feedback, Work, or revision reads. |
| Read comments and their replies | `comments:read` | reader | Mixed annotation reads omit comments without this capability. |
| Read suggested edits, diffs, and their replies | `suggestions:read` | reader | Mixed annotation reads omit suggestions without this capability. |
| Create a block, range, or whole-chapter comment | `comments:write` | contributor | Also requires `chapters:read` and the current chapter revision. |
| Create a block, range, or whole-chapter suggested edit | `suggestions:write` | contributor | Also requires `chapters:read` and the current chapter revision. |
| Reply to a readable comment or suggested edit | `replies:write` | contributor | Parent-kind read capability is also required. |
| Vote on an open comment | `comments:vote` | contributor | Comment tallies do not satisfy the default suggestion-to-Work rule. |
| Vote on an open suggested edit | `suggestions:vote` | contributor | Keeps the existing one-current-vote and aggregate-only rules. |
| Withdraw the token actor's own feedback or reply | `feedback:withdraw-own` | contributor | Never permits withdrawing another actor's content. |
| Approve or reject queued feedback; reject, reopen, or withdraw another actor's feedback | `feedback:moderate` | maintainer | Reason requirements and audit records remain action-specific. |
| Read Work and lease state | `work:read` | editor | Lease secrets remain visible only to their holder. |
| Promote an open comment or suggestion to Work | `work:promote` | maintainer | Reuses atomic, reasonless, idempotent promotion. |
| Claim, renew, or release Work | `work:claim` | editor | Existing type capability and lease checks remain mandatory. |
| Submit work held under a valid lease | `work:submit` | editor | Keeps lease-holder, base-revision, validation, and conflict checks. |
| Cancel an eligible work item | `work:cancel` | maintainer | Keeps the existing state-machine check and required audit reason. |
| Create or revise a draft chapter through the current chapter-submission API | `chapters:write` | editor | Published-chapter revisions move to proposals in slice 4. |
| Publish or unpublish a chapter | `chapters:publish` | maintainer | Remains a distinct, high-impact grant with ordinary deploy safeguards. |

The settings UI may offer named presets such as Critic, Reviewer, Drafter, and
Work contributor. Slice 4 may add Revision reviewer after its endpoints ship.
Presets only select visible capabilities from the applicable table; they are
not stored roles and cannot hide an implied grant.

### 4.3 API and agent contract

- Replace umbrella authorization at every editorial endpoint with the smallest
  capability from the matrix. `annotations:write`, `annotations:read`,
  `votes:write`, and `submissions:write` become compatibility aliases only;
  new tokens and API responses use canonical capabilities.
- Comment votes use the existing vote resource, current-vote uniqueness,
  aggregate schema, agent/human attribution, idempotency, rate limits, and
  audit trail. The default suggestion rule remains suggestion-only. A comment
  vote cannot create Work unless a future, explicitly kind-scoped rule says so.
- Mixed annotation reads are filtered server-side before pagination and never
  serialize a disallowed kind or its replies. Creating a reply checks both
  `replies:write` and read access to the parent kind.
- `GET /v1/me` returns the credential's canonical granted capabilities, its
  current role ceiling, its effective capabilities, and any legacy
  compatibility mode separately. For a legacy row it also returns a
  source-tagged `legacyEffectiveActions` list naming every preserved action
  that is not represented by a canonical grant. Token-list responses expose
  the same distinction without exposing the credential.
- Add a human-session-only, maintainer-only token-permission update endpoint.
  Its request replaces the complete capability set, requires idempotency, takes
  effect on the token's next request, and audits the before/after set. It never
  returns or rotates the token secret.
- The OpenAPI document, collaborator skill, role guides, API reference,
  examples, and troubleshooting table name each capability and show the exact
  endpoint/body for reading and creating suggested edits, voting on comments
  and suggestions, replying, promoting, working and submitting a lease, and
  creating, revising, publishing, or unpublishing a chapter. Slice 4 adds
  revision-proposal capabilities and documentation only when those endpoints
  exist; slice 7 does the same for history.

### 4.4 Settings and product behavior

- “Create agent token” groups plain-language checkboxes under Read, Discuss,
  Work, and Chapters. Every mutating and review capability starts disabled
  until a maintainer explicitly selects it or applies a visible preset. The UI
  exposes only capabilities backed by endpoints in the deployed release;
  Revisions and History groups arrive with slices 4 and 7.
- Before creation or update, show an exact “This token can” summary and call out
  moderation, promotion, cancellation, chapter publication, and, once shipped,
  revision approval as high-impact grants. There is no one-click hidden “all
  human powers” default.
- Active-token rows show granted capabilities, effective capabilities, and
  capabilities currently inactive because of the role ceiling. A maintainer
  can edit capabilities without rotating the secret, or revoke it immediately.
- Browser action visibility consumes the same effective-capability model as
  the agent API. Hiding a button is usability only; every route independently
  enforces the capability.

### 4.5 Upgrade and migration

No book-format migration is required. The D1 change follows expand/backfill/
retire across releases because author CI applies a migration before deploying
its matching Worker. A migration must never leave the still-running prior
Worker unable to understand active token rows.

1. **Expand release.** Add a nullable `capabilities_v2` column and a
   `capability_mode` column defaulting to `legacy` on `agent_tokens`. The old
   Worker ignores both. The matching new Worker reads canonical capabilities
   for `canonical` rows and translates legacy `scopes` for `legacy` rows.
   Human role bundles are derived canonically from the role; their stored
   legacy scopes are not rewritten. New tokens use canonical mode. Explicitly
   editing an old token shows the compatibility change and converts that token
   to canonical mode. Canonical writes also maintain a conservative legacy
   shadow containing only grants whose old meaning cannot exceed the canonical
   set. A prior Worker during deployment or rollback may deny a newly-granular
   action, but it must never grant a broader one.
2. **Backfill release.** Only after the dual-read Worker is deployed, an
   idempotent migration fills null `capabilities_v2` values from legacy scopes
   but leaves those rows in legacy mode and leaves their ordinary legacy scopes
   intact. The deployed expand Worker can serve before, during, and after this
   migration. The migration removes control-plane and unknown names from the
   legacy column as an intentional security reduction and records an audit
   event. Revoked and expired tokens remain revoked or expired.
3. **Retire releases.** Legacy-mode endpoint semantics remain until the
   maintainer explicitly converts a token or a documented major-version
   contract window permits their removal. After all supported rows are
   canonical, stop the legacy read fallback while continuing the shadow write
   for one release. A later contract migration may remove the old column or
   shadow only after the already-deployed Worker no longer reads it. There is
   no same-release rewrite-and-drop shortcut.

Legacy translation preserves only authority a capability actually exercised:
`annotations:read` becomes `comments:read` + `suggestions:read`;
`annotations:write` becomes `comments:write` + `suggestions:write` +
`replies:write` + `feedback:withdraw-own`; `votes:write` becomes
`suggestions:vote`; and `submissions:write` becomes `work:submit` +
`chapters:write` + `chapters:publish`, still capped by the applicable role.
Existing chapter and Work read/claim capabilities keep their names.
Translation does not synthesize a prerequisite read capability that was absent
on the old token. While a row remains in legacy mode, create, reply, and
withdraw endpoints preserve the old `annotations:write` dependency behavior,
annotation moderation preserves its old maintainer-role behavior, and Work
promotion/cancellation preserve the old maintainer + `work:claim` behavior for
that row only. Canonical rows must name every exact capability and prerequisite.
API responses, the token UI, and audit events expose legacy mode plainly so
compatibility is never mistaken for a canonical grant.

Do not add new comment-vote, promotion, cancellation, moderation,
revision-read/review, or history capabilities as canonical grants from a
legacy umbrella. Source-tagged legacy effective actions may preserve only the
promotion, cancellation, and moderation behavior the old token already had;
those disappear when a maintainer converts the token unless explicitly
selected. Every genuinely new high-impact grant requires a maintainer to opt
in after upgrade.
`tokens:manage`, `members:manage`, and unknown names are excluded from
`capabilities_v2`, the sanitized legacy row, and the conservative shadow, and
produce an operator-visible audit event. The compatibility window may accept
ordinary legacy editorial names on requests, but responses use canonical names
and stripped control-plane authority can never reactivate.

### 4.6 Security and test acceptance

1. An exhaustive credential x role x capability x endpoint matrix proves each
   editorial action succeeds only with both the exact token capability and role
   floor. Adjacent capabilities must return 403 and leave database, Git,
   outbox, event, idempotency, and audit state unchanged except for the safe
   denial audit policy.
2. Every control-plane route rejects bearer tokens before its ordinary scope
   check. Tests include a maintainer-role agent and a legacy token row containing
   `tokens:manage` and `members:manage`.
3. Comment and suggestion vote tests cover cast/change/clear, self and other
   actors, concurrent writes, human/agent tally separation, comment rule
   isolation, event reconciliation, and rebuild behavior.
4. Suggested-edit and reply tests cover kind-specific reads, pagination without
   existence leaks, current-revision validation, unsafe content, withdrawal
   ownership, moderation, rate limits, and Git projection.
5. Work and chapter tests cover promotion, claim/recover/renew/release, leased submit,
   draft create/revise, publish/unpublish, stale bases, conflicts, replayed
   idempotency keys, agent pause, project freeze, and revocation during an
   in-flight action.
6. Migration tests start with every legacy scope combination and exercise the
   old Worker before the expand deploy, the dual-read Worker before and after
   backfill, rollback to the expand Worker, and final legacy retirement. They
   prove no token gains comment voting, moderation, Work control, chapter
   publication, later-slice capabilities, or administration beyond authority
   it held before translation. Legacy-only endpoint behavior remains isolated
   to legacy-mode rows. A token revoked or expired before any step stays so.
7. UI tests cover keyboard and screen-reader labels, presets, exact permission
   summaries, scope editing, role-capped grants, one-time token display, and
   optimistic action rollback. For legacy rows, every preserved compatibility
   action appears in both the API's source-tagged list and the exact “This token
   can” summary. OpenAPI synchronization and collaborator-skill examples run in
   CI.

## 5. Slice 4 - proposed chapter revisions and diff review

- Add `revisions:read` at the editor role floor, `revisions:write` at the editor
  floor, and `revisions:review` at the maintainer floor. Agent tokens can hold
  any of them independently, subject to their role ceiling. None is inferred
  from a legacy scope, and the Settings Revisions group appears only in the
  release that registers these routes.
- Reuse `revise_chapter`, `chapter_replacement`, leases, base revision/hash,
  operation tracking, and the conservative conflict policy.
- Split submission receipt from application for review-required revisions. A
  successful submission creates an immutable proposed-revision record holding
  base identity, proposed content, author, work item, and summary. It does not
  write the chapter.
- Maintainers see a readable chapter diff with unchanged context, additions,
  deletions, author, base/current revision, and any conflict warning.
- Generate a standard unified patch from the immutable before/after snapshots
  with `diff`, and lazy-load Diff2Html core for browser rendering. Use a
  side-by-side view on wide screens and line-by-line output at narrow widths,
  omit file-list and syntax-highlighting chrome, cap expensive comparisons,
  and retain an accessible plain-text before/after fallback. Treat proposal
  content as hostile input and pin escaping/XSS behavior with regression tests.
- Approve applies the proposal through the existing validated Git write path,
  updates attribution and linked artifacts atomically, and triggers the normal
  deployment path. Reject records the maintainer decision without changing the
  chapter. Every decision is idempotent and audited.
- A proposal whose base moved is never silently applied. It must either pass
  the existing deterministic rebase rules or become an explicit conflict.
- Authorization tests cover each revision capability independently for human
  sessions and canonical and legacy-mode agent tokens. Diff reads cannot expose
  a proposal without `revisions:read`, submission requires
  `revisions:write` plus the applicable lease or direct-edit authority, and
  approve/reject requires `revisions:review`.

## 6. Slice 5 - permission-gated in-place chapter editing

- Show Edit only to editor and maintainer roles that also hold the required
  `revisions:write` capability. The API remains the authorization boundary.
- Use Milkdown Crepe as the in-place Markdown editing surface. Load its editor
  code and styles only after Edit is activated so ordinary chapter reading does
  not pay the editor bundle cost. Configure its supported schema and output so
  submitted content round-trips through Authorbot's safe canonical Markdown
  path without introducing raw HTML or browser-only document state.
- Use the same Milkdown-backed manuscript surface for collaboration when an
  authenticated reader activates Notes. An Authorbot-owned Milkdown plugin
  maps durable block and range anchors to ProseMirror decorations and selection
  state; Milkdown's block and tooltip providers supply the block-note affordance
  and anchored composer. Annotation bodies, votes, replies, and status remain
  API/store state and are never serialized into chapter Markdown.
- Keep anonymous reading on the static published HTML and lazy-load the
  Milkdown collaboration/editor bundle only when Notes or Edit is activated.
  Do not introduce Yjs or a second real-time authority: Authorbot's shared
  project store and event reconciliation remain canonical.
- Edit mode replaces the rendered manuscript body in place and preserves a
  clean reading-width layout. It supports ordinary prose structure and
  round-trips to safe canonical Markdown without raw HTML.
- Cancel restores the untouched reading view. Submit captures the current
  chapter revision/hash and creates a proposed whole-chapter revision through
  slice 4. It never publishes directly.
- Editors use `Submit for review`. A maintainer who holds both
  `revisions:write` and `revisions:review` also gets `Apply changes`: one
  activation creates the immutable proposal and its approval record inside the
  same serialized command, then sends it through the identical validation,
  Git, attribution, and deployment path. It requires no second self-review
  click and never bypasses the durable diff or audit history. Applying a draft
  keeps it a draft; applying an edit to published prose triggers the ordinary
  rebuild and deploy.
- Extend the same Milkdown, proposal, diff, attribution, and review workflow to
  the repository-backed Outline, Timeline, and Character pages. These are
  canonical Markdown/YAML repository artifacts, never browser-only CMS state.
  Editors submit changes for review; a maintainer with write and review
  authority may use the same atomic `Apply changes` path. Each proposal names
  every affected file and is applied as one validated Git commit or not at all.
- The editor clearly reports saving, review pending, stale base, rejection,
  approval, and deployment states. Draft text survives recoverable errors and
  navigation warnings prevent accidental loss.

## 7. Slice 6 - chapter-wide discussion threads

- Replace the static Discussion placeholder with chapter-scoped comment
  creation and the existing nested reply tree.
- Threads obey the same identity, visibility, plain-text safety, pending-Git,
  withdrawal, moderation, and rebuild rules as anchored annotations.
- A chapter thread can be promoted to `revise_chapter` by the one-click action
  from slice 1. Promoted threads use the same settled `Accepted` presentation.
- Thread list reads are paginated or batched so a chapter cannot create an
  unbounded Worker subrequest fan-out.

## 8. Slice 7 - inline chapter history

- Add `history:read` at the editor role floor and expose it in Settings only
  with this slice. Ordinary reader sessions and tokens cannot access raw
  chapter history: it may contain unpublished drafts or prose deliberately
  removed from a later version. Proposal text remains behind `revisions:read`
  and is not folded into the history dataset.
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
  the slice 4 review workflow; it never rewinds Git or publishes directly.
- Reuse the slice 4 diff representation and the slice 2 store. Fetch bounded,
  paginated history metadata and one selected snapshot/diff at a time rather
  than making one repository request per version in a Worker invocation.
- Motion is decorative, respects `prefers-reduced-motion`, and has a complete
  keyboard and screen-reader equivalent. The static manuscript remains usable
  if history loading fails.
- Authorization tests prove a reader cannot infer or fetch withdrawn,
  unpublished, or removed historical text. Editors without `history:read` are
  also denied, and history access alone never grants proposal review.

## 9. Release discipline

Each independently deployable increment lands through its own reviewed pull
request, includes any required book-format migration and upgrade guidance, and
cuts a release only after CI and the release smoke checks pass. Slice 3A and 3B
must be separate releases in that order. Slice 3C waits for its documented
rollback and major-version contract window and cannot be folded into either
earlier release. Slice 6 starts after slices 1-5 are shipped, and slice 7 builds
on the shipped store and revision-review model.
