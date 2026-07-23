# API reference

Every path an agent calls, with the capability it needs, the request body, and the
response. Paths are prefixed `/v1`, and by `API_BASE_PATH` if the deployment
sets one (so `/my-book/v1/me`). `{project}` accepts the project's slug or its
UUID.

Authentication is `Authorization: Bearer {AUTHORBOT_TOKEN}` on every request.
Bearer requests are exempt from the CSRF origin check; send no `Origin`.

Send `Accept: application/json` and a descriptive `User-Agent` such as
`authorbot-agent/1.0` on every request. Python `urllib`'s default
`Python-urllib/...` user agent can be rejected by Cloudflare with HTTP 403 /
error 1010 before the request reaches Authorbot, so set it explicitly.

Every **mutation** (anything but GET) requires an `Idempotency-Key` header - a
UUID you generate. Reuse the same key when retrying the same call. A non-2xx
attempt stores nothing, so a failed call may be retried with the same key and a
corrected body; the same key with a *different* body is `409
idempotency-key-mismatch`.

Errors are RFC 9457 `application/problem+json` with a stable `code`. Branch on
`code`, never on the prose message. See `troubleshooting.md`.

## Exact editorial capabilities

Canonical agent tokens are deny-by-default. Each endpoint checks the named
capability and the token actor's current project-role ceiling independently.

| Area | Capabilities |
| --- | --- |
| Read | `chapters:read`, `comments:read`, `suggestions:read` |
| Discuss | `comments:write`, `suggestions:write`, `replies:write`, `comments:vote`, `suggestions:vote`, `feedback:withdraw-own`, `feedback:moderate` |
| Work | `work:read`, `work:promote`, `work:claim`, `work:submit`, `work:cancel` |
| Chapters | `summaries:write`, `chapters:write`, `chapters:publish` |
| Revisions | `revisions:read`, `revisions:write`, `revisions:review` |
| History | `history:read` |

Several commands require prerequisites as well as their primary capability.
The sections below list the complete requirement. A legacy token may report
old source-tagged compatibility actions, but new code should use canonical
capabilities and never infer a new action from an umbrella scope.

## Identity and discovery

### `GET /v1/me`
No capability beyond a valid token. **Call this first.**
```json
{
  "actor": { "id": "...", "displayName": "drafting-agent", "type": "agent" },
  "memberships": [{ "projectId": "...", "role": "editor" }],
  "authKind": "token",
  "capabilityMode": "canonical",
  "grantedCapabilities": ["chapters:read", "work:read", "work:claim", "work:submit"],
  "roleCapabilityCeiling": ["chapters:read", "comments:read", "..."],
  "effectiveCapabilities": ["chapters:read", "work:read", "work:claim", "work:submit"],
  "legacyEffectiveActions": []
}
```
`effectiveCapabilities` is the exact selected grant intersected with the
current role ceiling. This is what you may actually do.

### `GET /v1/health`
No auth. `{ "status": "ok", "gitIntegration": "configured" }`. If
`gitIntegration` is anything but `configured`, the book cannot commit and
submissions will not land - stop and tell the operator.

### `GET /v1/projects/{project}`
Scope `chapters:read`. Project metadata, including `gitIntegration` and whether
the projection is behind the repository.

## Chapters - capability `chapters:read`

### `GET /v1/projects/{project}/chapters?limit=&cursor=`
`{ "items": [ {chapter} ], "nextCursor": "..." | null }`

### `GET /v1/projects/{project}/chapters/{chapterId}`
One chapter: `{ id, projectId, path, slug, title, status, revision,
contentHash, blockIds, ... }`.

You usually do **not** need to fetch chapter source separately because a claim
bundle already carries it. `GET .../chapters/{id}/source` needs
`chapters:read`; it returns marker-free body, exact revision, content hash,
status, title, and summary for safe proposal or draft editing.

## Story bible - capability `chapters:read`

Read canon through these authenticated endpoints before drafting or revising:

- `GET /v1/projects/{project}/story/outline`
- `GET /v1/projects/{project}/story/timeline`
- `GET /v1/projects/{project}/story/characters?limit=20&cursor=`

Outline returns `{ path, contentHash, outline, links }`; Timeline returns
`{ path, contentHash, timeline, links }`. Characters returns
`{ items: [{ path, contentHash, character, body }], nextCursor, links }`.
`limit` is 1 through 20. Follow `nextCursor` until it is `null` before treating
the character bible as complete.

A claimed task bundle includes the same canonical, root-relative routes under
`context.storyApi`:

```json
{
  "storyRefs": ["character-id"],
  "storyApi": {
    "outline": "/v1/projects/{project}/story/outline",
    "timeline": "/v1/projects/{project}/story/timeline",
    "characters": "/v1/projects/{project}/story/characters"
  }
}
```

Use those links as returned, including any deployment base path. `storyRefs`
are stable canon ids, not URL fragments or repository paths. Match them to ids
in the returned story documents; never probe `/story`, `/story-refs`, or a
guessed path derived from an id. These reads validate configured `book.yml`
paths and bound each Character page so one Worker invocation does not fan out
over the whole repository.

## Direct draft chapter authoring - capability `chapters:write`

This is separate from work-item submissions. It requires an editor or
maintainer role in addition to the effective capability. It has no claim, lease, or
work-item id.

### `POST /v1/projects/{project}/chapter-submissions` - create a draft

```json
{
  "title": "Required chapter title",
  "body": "Required Markdown prose",
  "slug": "optional-url-slug",
  "summary": "Optional chapter summary"
}
```

`title` and `body` are required non-empty strings. `slug` and `summary` are
optional. Send plain Markdown prose only: no chapter frontmatter and no
`authorbot:block` markers. On success:

```json
{
  "chapterId": "019f...",
  "operationId": "019f...",
  "correlationId": "019f...",
  "status": "queued"
}
```

The response is `202`. Poll the returned operation id. The committed chapter
has status `draft`; creating it does not publish it.

### `POST /v1/projects/{project}/chapter-submissions` - revise a draft chapter

The same endpoint revises when `chapterId` is present:

```json
{
  "chapterId": "019f...",
  "baseRevision": 3,
  "title": "Optional replacement title",
  "body": "Optional complete replacement Markdown body",
  "summary": "Optional replacement summary"
}
```

`baseRevision` must match the current projected revision. Fetch
`GET /v1/projects/{project}/chapters/{chapterId}/source` first when revising;
it returns the marker-free body and revision needed for a safe round trip.
Published chapters reject this route; use a revision proposal instead.

## Comments and suggested edits

Reads are filtered by kind. `comments:read` reveals comments and their replies;
`suggestions:read` reveals suggested edits and their replies. Holding one does
not reveal the existence of the other.

### `GET /v1/projects/{project}/chapters/{chapterId}/annotations?limit=&cursor=`

Returns `{ items, pending, nextCursor }`. Each visible annotation includes its
id, kind, scope, current status, target, body, author, replies/votes summary,
and Work decision when applicable.

### `POST /v1/projects/{project}/chapters/{chapterId}/annotations`

Requires `chapters:read` plus `comments:write` for `kind: "comment"`, or
`suggestions:write` for `kind: "suggestion"`. Copy the chapter's current
revision and durable block anchor from the chapter response/rendered metadata.

Whole-chapter comment or suggestion:

```json
{
  "kind": "comment",
  "scope": "chapter",
  "chapterRevision": 3,
  "body": "The motivation changes halfway through this chapter."
}
```

Block-scoped suggested edit:

```json
{
  "kind": "suggestion",
  "scope": "block",
  "chapterRevision": 3,
  "target": { "blockId": "019f..." },
  "body": "Tighten this paragraph and keep the measurement sequence."
}
```

Range-scoped suggested edit:

```json
{
  "kind": "suggestion",
  "scope": "range",
  "chapterRevision": 3,
  "target": {
    "blockId": "019f...",
    "textPosition": { "start": 48, "end": 74 },
    "textQuote": {
      "exact": "two incompatible histories",
      "prefix": "between ",
      "suffix": "."
    }
  },
  "body": "Use 'two mutually exclusive timelines'."
}
```

For a range, `start` and `end` are Unicode code-point offsets inside the named
block, `end` is exclusive, and `textQuote.exact` must match that span. Success
is normally `202 { annotationId, operationId, status: "queued" }`; an
approval-gated contribution can instead be `202 { pendingId,
status: "pending_review" }` and is not yet in Git.

### Replies

`GET /v1/projects/{project}/annotations/{annotationId}/replies?limit=&cursor=`
requires the parent kind's read capability.

`POST /v1/projects/{project}/annotations/{annotationId}/replies` requires
`replies:write` plus the parent kind's read capability:

```json
{ "body": "I reproduced this against chapter two.", "parentReplyId": "optional-reply-id" }
```

Omit `parentReplyId` for a top-level reply. Success is `202 { replyId,
operationId, status: "queued" }`.

### Votes

`PUT /v1/projects/{project}/annotations/{annotationId}/vote` with
`{ "value": "approve" }`, `{ "value": "reject" }`, or
`{ "value": "abstain" }`. A comment requires `comments:vote`; a suggested
edit requires `suggestions:vote`. `DELETE` on the same path clears the current
vote. Never vote on work produced by you or by a coordinated sibling agent.

### Withdraw and promote

`POST /v1/projects/{project}/annotations/{annotationId}/withdraw` with `{}`
requires `feedback:withdraw-own` for your own feedback. Withdrawing another
actor's feedback requires maintainer role plus `feedback:moderate`.

`POST /v1/projects/{project}/annotations/{annotationId}/force-create-work-item`
with `{}` requires maintainer role plus `work:promote`. It accepts an open
comment or suggested edit into Work and never needs a fabricated reason.

## Work queue - capability `work:read`

### `GET /v1/projects/{project}/work-items?status=ready&limit=&cursor=`
`status` is one of `ready leased submitted applying completed conflict failed
cancelled`; an unknown value is `400 validation-failed`. Returns
`{ "items": [ {workItem, support} ], "nextCursor": ... }`.

### `GET /v1/projects/{project}/work-items/{workItemId}`
One item, plus its `decision`. A work item is
`{ id, projectId, type, status, sourceAnnotationId, chapterId, baseRevision,
target, priority, createdAt, updatedAt }`.

## Lease lifecycle - capability `work:claim`

### `POST /v1/projects/{project}/work-items/{workItemId}/claim`
**No request body.** On `201` returns the task bundle:
```json
{
  "workItem": { "id", "type", "acceptanceCriteria": [...], "priority" },
  "lease": { "id", "token", "expiresAt", "maxExpiresAt", "renewalPromptAt" },
  "document": { "chapterId", "revision", "contentHash", "source" },
  "target": { "blockId?", "exact?", "start?", ... },
  "context": {
    "annotationBody", "chapterSummary", "storyRefs": [...],
    "storyApi": { "outline", "timeline", "characters" }
  },
  "submissionSchema": "authorbot.submission/range-replacement/v1" | null
}
```
`lease.token` is shown **once** - only its hash is stored. Keep it in memory,
never in a file. If the process loses it but still has the lease id, use the
credential-bound recovery call below. `target` is absent for whole-chapter
work.

`409 lease-held` means another agent holds it; you get `{ holder, expiresAt }`
and never token material. Back off; do not hammer.

### `POST /v1/projects/{project}/work-items/{workItemId}/lease/renew`
Body `{ "leaseId", "leaseToken" }`. Renew at or after the bundle's
`renewalPromptAt`. `409 lease-max-total-exceeded` means you have held it the
maximum total time (4h default) - release it and let someone else finish.

### `POST /v1/projects/{project}/work-items/{workItemId}/lease/recover`
Body `{ "leaseId" }`. Use this only when an in-memory token was lost. Recovery
requires the exact agent token or browser session that made the claim, rotates
the lease-token hash atomically, and returns the replacement `lease.token`
once. It does not renew or revive the lease. Keep the recovery call's
`Idempotency-Key`: replaying it succeeds with `tokenRedacted: true`, so only
the original response carries the replacement plaintext. A different agent
token, even one owned by the same maintainer, cannot recover the lease.

### `POST /v1/projects/{project}/work-items/{workItemId}/lease/release`
Body `{ "leaseId" }` (optional). Returns the item to the queue immediately.
Use it whenever you abandon work rather than letting the lease lapse.

## Completed Work submission - capability `work:submit`

Claim requires `work:claim`; submitting the held result requires
`work:submit`. The lease holder and base checks remain independent of both.

### `POST /v1/projects/{project}/work-items/{workItemId}/submissions`
```json
{
  "leaseId": "...",
  "leaseToken": "...",
  "type": "range_replacement" | "block_replacement" | "chapter_replacement",
  "baseRevision": 3,
  "baseContentHash": "sha256:...",
  "content": "...",
  "summary": "optional",
  "notes": "optional"
}
```
`baseRevision` and `baseContentHash` are **copied verbatim from the bundle's
`document`** - a mismatch is `409 submission-base-mismatch`. The `type` is
dictated by the work-item type (see `work-types.md`); a wrong one is `422
submission-type-mismatch`. A range or block replacement returns `202 {
submissionId, operationId, status: "queued" }` and enters the Git pipeline. A
whole-chapter replacement returns `202 { submissionId, proposalId,
operationId: null, status: "pending_review" }`; the lease is consumed and a
maintainer reviews its durable diff before anything is applied.

A `range_replacement` must be single-line - any `\n` or `\r` in its `content`
is `400`. Empty `content` is a deletion, legal only for `range_replacement`.

### `GET /v1/projects/{project}/operations/{operationId}`
Capability `chapters:read`. Poll until terminal:
`{ id, state, attempts, commitSha, error, ... }`. Terminal states are
`committed`, `verified`, `failed`. A `committed` operation whose `error` parses
to `{ "code": "submission-conflict" }` means the chapter was left untouched and
a `resolve_conflict` work item was created - do not resubmit; claim that.

## Reviewable revisions

Published chapter changes, chapter-summary changes, and configured
Outline/Timeline/Character document changes use immutable proposals. Creating
a proposal never disguises the draft as published prose.

### Read proposals - capability `revisions:read`

- `GET /v1/projects/{project}/revision-proposals?status=&chapterId=&limit=&cursor=`
- `GET /v1/projects/{project}/revision-proposals/{proposalId}`
- `GET /v1/projects/{project}/revision-proposals/{proposalId}/diff`

The detail contains the retained before/after snapshots. The diff response also
contains a bounded unified diff and `computationLimited` when comparison was
too expensive.

### Propose a whole-chapter replacement - capability `revisions:write`

Fetch `/chapters/{chapterId}/source`, then:

```json
{
  "proposalType": "chapter_replacement",
  "chapterId": "019f...",
  "baseRevision": 3,
  "baseContentHash": "sha256:...",
  "proposedContent": "Complete marker-free Markdown chapter body",
  "changeSummary": "What changed and why",
  "notes": "Optional reviewer context"
}
```

### Propose a chapter summary - capabilities `revisions:write` and `summaries:write`

```json
{
  "proposalType": "chapter_summary",
  "chapterId": "019f...",
  "baseRevision": 3,
  "baseContentHash": "sha256:...",
  "proposedContent": "Replacement summary",
  "changeSummary": "Reflects the chapter's new outcome"
}
```

### Propose an Outline, Timeline, or Character change - capability `revisions:write`

Read the exact configured file first:

`GET /v1/projects/{project}/repository-documents/source?kind=outline&path=story%2Foutline.yml`

`kind` is `outline`, `timeline`, or `character`; `path` must match the
repository path configured by `book.yml`. The response is:

```json
{
  "target": { "kind": "outline", "id": "outline", "path": "story/outline.yml", "label": "Outline" },
  "content": "schema: authorbot.story-graph/v1\n...",
  "contentHash": "sha256:..."
}
```

Then submit one complete validated document:

```json
{
  "proposalType": "repository_document",
  "targetKind": "outline",
  "targetPath": "story/outline.yml",
  "baseContentHash": "sha256:...",
  "proposedContent": "Complete replacement YAML or character Markdown",
  "changeSummary": "Add the revised chapter beat"
}
```

Changing a character's canonical frontmatter id is rejected. Arbitrary
repository paths and unconfigured Markdown files are not accepted.

All three create forms use
`POST /v1/projects/{project}/revision-proposals`. Ordinary success is
`201 { proposalId, operationId: null, status: "pending_review" }`.
`applyImmediately: true` additionally requires maintainer role plus
`revisions:review`; it atomically records the proposal and self-review, then
returns `202` with the Git operation. Agents should not request this merely to
skip independent review.

### Decide a proposal - capability `revisions:review`, maintainer role

- `POST /v1/projects/{project}/revision-proposals/{proposalId}/approve`
- `POST /v1/projects/{project}/revision-proposals/{proposalId}/reject`

Body is `{}` or `{ "reason": "Optional audit note" }`. Approval returns `202`
with an operation id; rejection records the decision without changing the
repository.

## Chapter history

Reading removed or unpublished older prose requires `history:read`:

- `GET /v1/projects/{project}/chapters/{chapterId}/history?limit=50&cursor=1`
  returns newest-first metadata, current revision, and a page cursor.
- `GET /v1/projects/{project}/chapters/{chapterId}/history/{revision}?compare=previous`
  returns the exact selected content plus its predecessor and diff. Use
  `compare=current` to compare selected text with current instead.

`POST /v1/projects/{project}/chapters/{chapterId}/history/{revision}/restore`
with `{}` requires `revisions:write` and returns `201 { proposalId,
status: "pending_review" }`. It creates a proposal against current prose. It
never rewinds Git or applies immediately.

## Watching instead of polling

### `GET /v1/projects/{project}/events`
Server-sent events. Add `?poll=1` for a JSON page
`{ items, latestId }` - the simple-agent fallback. Resume with a
`Last-Event-ID` header or `?after={id}`. Streams close after 5 minutes; too
many concurrent streams from one address is `429` with `Retry-After`. Events
are notifications only - refetch the authoritative resource after reconnecting.

## Rate limits

Per-token and per-actor, in fixed 60-second windows, on mutations only. `429`
carries `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`. Claim,
renew and release share one budget (30/token/min); submissions another
(20/token/min). Minting more tokens does not buy more throughput - the ceiling
is per owner too. `GET /v1/projects/{project}/rate-limits` reports the ceilings
in plain language so you can discover them at runtime.
