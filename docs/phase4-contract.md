# Phase 4 implementation contract — leases and submissions

Subordinate to `AUTHORBOT_PROJECT_DESIGN.md` (§9.5, §10.2–10.3, §12, §13,
§15.3, §23 Phase 4) and additive to Phase 0–3 contracts. Exit criteria
(design §23/§27): humans and agents complete the same task type through
documented interfaces; two simultaneous claims cannot both succeed; an
expired or stale lease cannot submit; an accepted edit updates all related
artifacts in one commit; a concurrent chapter change produces a clean
deterministic rebase or an explicit conflict — never a clobber.

## 1. Scope

**In:** lease lifecycle (claim/renew/release/lazy+swept expiration); the
§15.3 task bundle; submission types `range_replacement`, `block_replacement`,
`chapter_replacement`; patch application in `@authorbot/markdown`; the §12.6
conflict policy with conflict-resolution work items; minimal deterministic
re-anchoring of unaffected annotations; attribution records; lease/work-item
events; claim-and-edit UI in the islands; a runnable example agent script.

**Out (deferred):** GitHub App writes and PR mode (Phase 5), fuzzy re-anchor
(design §10.2 step 5 — bounded to steps 1–4, else `needs_reanchor`),
`write_chapter`/`planning` submission flows (work items claimable; submission
types above only), rich editor, notifications, rate limits (Phase 6).

## 2. Leases (design §12)

- Config per design §25 defaults: duration PT30M, renewal PT30M, max total
  PT4H, renewal prompt PT5M before expiry (UI concern). Env-overridable
  (`LEASE_*`), validated at boot.
- `leases` table: id, work_item_id, holder actor, token **hash** (SHA-256,
  constant-time compare), issued/expires/max_expires, renewal count,
  released_at, revoked_at. Exactly one active lease per work item —
  enforced by a partial unique index, not application hope.
- Claim `POST /work-items/{id}/claim`: serialized compare-and-set — item is
  `ready` (or its lease expired: expire it in the same batch), actor has
  `work:claim` + capability for the type; creates the lease (opaque 256-bit
  token, returned exactly once), transitions `ready → leased`, emits
  `work_item_leased`. Two simultaneous claims: exactly one 201; the loser
  gets 409 `lease-held` with holder-safe info (no token, holder display name
  only).
- Renew `POST .../lease/renew` (current token required; extends by renewal
  duration, capped at max total; renewing an expired lease → 409). Release
  `POST .../lease/release` (holder or maintainer) → `leased → ready`.
- Expiration is enforced **lazily on every lease-relevant command** and by an
  exported `sweepExpiredLeases(db, clock)` (dev server timer + tests;
  DO alarm wiring is Phase 5). Expiry → `leased → ready`, event emitted.

## 3. Task bundle (design §15.3)

Claim response exactly: `workItem { id, type, acceptanceCriteria[],
priority }`, `lease { id, token, expiresAt, maxExpiresAt, renewalPromptAt }`
(amended 2026-07-20: `renewalPromptAt` — `expiresAt` minus the configured
`LEASE_RENEWAL_PROMPT_BEFORE` — was omitted from the original contract, which
forced the §7 UI to hardcode the 5-minute default on a freshly claimed lease
and ignore a deployment's configured lead time until the first renewal, where
the renew response already carries the field. It is a derived timestamp, not
capability material.), `document
{ chapterId, revision, contentHash: "sha256:…", source }` (full chapter
Markdown at base revision), `target { blockId, exact, start, end }` (absent
for chapter scope), `context { annotationBody, chapterSummary, storyRefs[] }`,
`submissionSchema` id string. No secrets, no hidden instructions; the bundle
README note marks prose fields untrusted (design §19.6/§15.3).

## 4. Submissions (design §12.5)

`POST /work-items/{id}/submissions` body: `{ leaseId, leaseToken,
type, baseRevision, baseContentHash, content, summary?, notes? }` +
`Idempotency-Key`. Server verifies in order: lease exists/holder/token
hash/not expired/not released; work item `leased`; type matches work-item
type (range→range_replacement, block→block_replacement,
chapter→chapter_replacement); `baseRevision`+`baseContentHash` match the
lease's bundle; payload schema + Phase 0 prose safety on `content` (no raw
HTML, allowed schemes; ≤ 512 KiB). Failure → 4xx with stable problem types;
success → 202 `{ submissionId, operationId }`, `leased → submitted →
applying` in the command, then the pipeline below.

## 5. Application and conflict (design §12.6, §14.2)

- `@authorbot/markdown` gains the patch engine: `applyRangeReplacement`
  (only when the stored selector maps to one contiguous source span in the
  base block — Phase 0 §8.4 rule; normalized-offset → source-span mapping),
  `applyBlockReplacement` (replace block content, preserve its marker; new
  blocks in replacement content get fresh UUIDv7 markers),
  `applyChapterReplacement` (body swap; markers required on the result —
  reuse ids where blocks are textually identical, else new ids). All three:
  never alter text outside the declared target; property-tested.
- Current revision == baseRevision → validate result (chapter-level Phase 0
  checks) → outbox commit: chapter file (bumped `revision`), work item
  `done` disposition, annotation `accepted`, attribution entry, decision
  linkage — **one commit** with §14.3 trailers. `applying → completed`.
- Current revision ≠ base: resolve target against the new revision via
  design §10.2 steps 1–4 (blockId → position+quote → quote+context in block
  → quote+context in chapter). Unique match AND no overlap with the changed
  regions → rebase (recompute span) and apply against current revision.
  Ambiguous/overlapping/absent → `applying → conflict`, create a
  `resolve_conflict` work item (artifact per §13 carrying both texts),
  409-style problem recorded on the operation, submission `conflicted` —
  the newer chapter is NEVER overwritten.
- After a successful apply, re-anchor other annotations on that chapter
  (§10.3): blockId survives + exact quote still present → keep (bump
  anchored revision); else `needs_reanchor`. Deterministic only; each
  re-anchor result recorded with algorithm version.

## 6. Events, attribution, rebuild

- New events: `work_item_leased`, `lease_renewed`, `lease_released`,
  `lease_expired`, `submission_received`, `work_item_completed`,
  `work_item_conflict`. SSE + poll as Phase 3.
- Attribution: `.authorbot/attribution/<chapter-id>.yml` appends
  `{ revision, actor, work_item_id, commit }` in the same commit as the
  edit. Chapter frontmatter `authors` gains the actor if new (stable order).
- Leases are **operational-only** (never in Git, design §13). Submissions:
  DB rows; content retained until completed/conflict resolution + 7 days
  (documented; no purge job yet). Rebuild restores work-item/annotation
  statuses from artifacts as in Phase 3; active leases intentionally do not
  survive a fresh-DB rebuild (design §7.5) — documented.

## 7. UI and example agent

- `/work/` islands: Claim button (eligible users), lease countdown with
  renewal prompt at T-5m, release; a minimal edit view (task context,
  acceptance criteria, original text, textarea prefilled with the target,
  live remaining-lease indicator, submit → syncing → completed/conflict
  honestly surfaced). Keyboard-complete, 44px, plain-text rendering, all
  Phase 2b rules.
- `examples/agent-workflow.mjs`: zero-dependency Node script driving the
  documented API only (env: API base, agent token or dev-login; args:
  work-item id + replacement text): claim → print bundle → submit → poll
  operation → report commit. Used by an integration test (agent path) while
  Playwright covers the human path — same work-item type for both (§27.5).

## 8. Exit criteria

1. Simultaneous-claim test: N parallel claims → exactly one 201, one active
   lease row, others 409; repeatable ×5.
2. Stale-lease matrix: expired, released, revoked, wrong-token, and
   max-total-exceeded renewals all rejected; sweep + lazy expiry both
   return items to `ready` with events.
3. Full happy path (agent script) and human path (Playwright) complete the
   SAME range_replacement work item type end-to-end: one commit containing
   chapter bump + work-item done + annotation accepted + attribution;
   validated by the Phase 0 validator post-commit.
4. Conflict path: unrelated concurrent edit → deterministic rebase applies;
   overlapping edit → conflict work item + no chapter change; the hammer
   asserts the newer revision is byte-intact.
5. Patch engine property tests: replacements never touch text outside the
   target; block markers preserved/fresh per §5; round-trip validity.
6. Re-anchor: unaffected annotations keep anchors across a revision;
   overlapping ones flagged `needs_reanchor`; recorded with version.
7. Workspace green; every prior phase's suites, e2e, script-free and
   fixture regressions intact; OpenAPI synced (claim/renew/release/
   submissions implemented; Phase 5 markers remain).
