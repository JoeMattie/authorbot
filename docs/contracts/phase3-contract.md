# Phase 3 implementation contract - votes, rules, and work generation

Subordinate to `AUTHORBOT_PROJECT_DESIGN.md` (§11, §13, §15.5, §23 Phase 3)
and additive to the Phase 0-2b contracts. Exit criterion (design §23):
concurrent qualifying votes create one and only one work item.

## 1. Scope

**In:** votes with one-current-vote semantics; the declarative rule engine
(`packages/rule-engine`); sticky decision records with `support_changed`
tracking and maintainer overrides; idempotent work-item generation with
durable Git artifacts; work-queue read API; SSE event feed; island additions
(vote controls, decision badges, a work-queue page).

**Out (deferred):** claims/leases/submissions (Phase 4 - work items stop at
`ready`), weighted votes, arbitrary custom metrics, vote-event export beyond
aggregates (§26.1: aggregate-only), notifications.

## 2. Votes

- `PUT /v1/projects/{p}/annotations/{id}/vote` body `{ value:
  approve|reject|abstain }`; `DELETE` clears. Suggestions only (comments →
  422). Requires `votes:write` - added to the **contributor** role bundle;
  agents vote only when their membership grants it (design §11.2).
- Tables: `votes` (unique `(annotation_id, actor_id)`, upsert on change) and
  append-only `vote_events`. Aggregates are computed in SQL, never cached
  denormalized in Phase 3.
- Metrics vocabulary (design §11.1 subset): `approvals`, `rejections`,
  `abstentions`, `net_score`, `distinct_voters`, `human_approvals`,
  `agent_approvals`. Actor type comes from `actors.type`.
- Vote tallies are readable wherever the annotation is readable (public books
  show counts to signed-out readers); per-voter identity is member-only.

## 3. Rule engine

- `packages/rule-engine`: pure evaluation of the declarative shape in design
  §11.1 / the `authorbot.instance/v1` schema - `when.all[]` of `{ metric,
  operator: gte|lte|gt|lt|eq, value }` → `action { type: create_work_item,
  work_type }`. No user-supplied code, ever.
- Rules come from config: `RULES_JSON` env (validated against the instance
  schema) defaulting to design §25: approvals ≥ 3, net ≥ 2, human_approvals
  ≥ 1 → `create_work_item`. `work_type` resolves by annotation scope:
  range → `revise_range`, block → `revise_block`, chapter → `revise_chapter`.
- Evaluation triggers on `vote_changed`, inside the same serialized command
  that recorded the vote.

## 4. Decisions and work items (design §11.3-11.4, §13)

- Threshold crossing creates, **in one DB batch**: the decision row
  (rule + version, aggregate metrics snapshot, result), the work-item row
  (`ready`, base = current chapter revision, target snapshot of the
  annotation selector incl. quote), the annotation transition
  `open → work_item_created`, audit events, and outbox rows for both Git
  artifacts. Uniqueness on `(source_annotation_id, action_type,
  rule_version)` makes concurrent crossings collapse to exactly one -
  losers of the race treat unique-violation as already-done, not error.
- **Sticky**: later vote changes never delete the decision or work item; if
  the aggregate stops satisfying the rule, the decision is marked
  `support_changed` (and unmarked if support returns) with events emitted.
- Maintainer overrides, each requiring a `reason` and recorded as decisions
  with `override_reason`: reject an open suggestion, cancel a `ready` work
  item, reopen a rejected suggestion, force-create a work item bypassing the
  rule (same uniqueness key, `rule_version: 0`).

  Phase 11 supersedes the force-create part only: promotion now accepts any
  open comment or suggestion and requires no reason. Reject, reopen, and cancel
  retain this Phase 3 reason requirement.
- Git artifacts via the Phase 2 outbox: `.authorbot/decisions/<id>.yml`
  (aggregate metrics only - no per-voter data, §26.1) and
  `.authorbot/work-items/<id>.md` per design §13: frontmatter per Phase 0
  contract §4, body sections Context (annotation body), Original text (the
  quoted target between `authorbot:original` delimiters), Requested change,
  Acceptance criteria (template: preserve POV, change only the selected
  span, keep continuity facts), Submission contract naming the base
  revision. Projection rebuild restores decisions and work items from these
  artifacts (rebuildability).

## 5. Events (design §15.5)

- `GET /v1/projects/{p}/events` - SSE stream from a cursor-ordered
  `events` table (monotonic id): `annotation_created`, `vote_aggregate`,
  `decision_created`, `decision_support_changed`, `work_item_created`,
  `operation_completed`. `Last-Event-ID` (or `?after=`) resumes; 15s
  heartbeat comments; authenticated project members only. Clients must
  refetch authoritative resources after reconnect (documented).
- Same rows are pollable via `GET /v1/projects/{p}/events?after=<id>&poll=1`
  returning JSON (simple-agent fallback, §26.1). On public books, anonymous
  callers and signed-in non-members admitted by an open/approval-gated policy
  receive only explicitly public collaboration subtypes, and the cursor
  advances across filtered member-only rows. `resolve_conflict` Work creation
  and Work cancellation remain private even though they reuse Phase 3 event
  names. A public `operation_completed` row is visible only for unambiguously
  public annotation/reply outbox kinds; decision, Work, chapter, submission,
  settings, and later private operations remain member-only. Public rows are
  serialized through a per-type field projection, so additive internal payload
  fields remain private until explicitly reviewed. Only current project members
  may open SSE.

## 6. UI additions (islands, same rules as Phase 2b)

- Suggestion cards: approve/reject/abstain segmented control with live
  tallies (SSE-updated, poll fallback), visible to all, enabled only with
  `votes:write`; a "Queued as work item" badge once a decision exists, with
  `support_changed` shown honestly.
- New `/work/` static page (emitted only when `api_url` configured): island
  listing ready work items (type, target chapter, support summary, base
  revision) read-only in Phase 3.
- All Phase 2b rules hold: plain-text rendering, keyboard-complete,
  44px targets, script-free without `api_url`.

## 7. Exit criteria

1. **Concurrency hammer**: N parallel qualifying votes (and repeated rule
   re-evaluations) yield exactly one decision and one work item - asserted
   at the DB and in Git (one decision artifact, one work-item artifact).
2. Vote uniqueness: re-voting updates in place; `vote_events` appends; 
   tallies correct across actor types (human vs agent metric split).
3. Sticky semantics: crossing then dropping below threshold →
   `support_changed` set, work item still `ready`; support returning clears
   the flag; events emitted for each.
4. Overrides: all four, maintainer-only and audited; cancel before integration
   works; force-create respects the uniqueness key. Phase 11 makes only
   force-create reason-optional.
5. Rebuild: fresh DB + projection rebuild restores decisions and work items
   from `.authorbot/` with statuses intact.
6. SSE: a client receives vote/decision/work-item events live, resumes from
   `Last-Event-ID` without loss; poll fallback returns the same rows.
7. Playwright: three dev actors vote a suggestion over threshold → badge
   appears; `/work/` lists the item; signed-out reader sees tallies but no
   controls.
8. Workspace green; every prior phase's suites and regressions intact;
   OpenAPI synced.
