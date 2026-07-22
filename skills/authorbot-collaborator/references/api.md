# API reference

Every path an agent calls, with the scope it needs, the request body, and the
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

## Identity and discovery

### `GET /v1/me`
No scope beyond a valid token. **Call this first.**
```json
{ "actor": {...}, "memberships": [...], "scopes": ["chapters:read", ...],
  "authKind": "token" }
```
`scopes` is the *effective* set - the token's scopes intersected with its
role's bundle. This is what you may actually do.

### `GET /v1/health`
No auth. `{ "status": "ok", "gitIntegration": "configured" }`. If
`gitIntegration` is anything but `configured`, the book cannot commit and
submissions will not land - stop and tell the operator.

### `GET /v1/projects/{project}`
Scope `chapters:read`. Project metadata, including `gitIntegration` and whether
the projection is behind the repository.

## Chapters - scope `chapters:read`

### `GET /v1/projects/{project}/chapters?limit=&cursor=`
`{ "items": [ {chapter} ], "nextCursor": "..." | null }`

### `GET /v1/projects/{project}/chapters/{chapterId}`
One chapter: `{ id, projectId, path, slug, title, status, revision,
contentHash, blockIds, ... }`.

You usually do **not** need to fetch chapter source separately - a claim bundle
already carries it. (`GET .../chapters/{id}/source` exists but needs
`submissions:write` *and* an editor/maintainer role, and is for the direct
composer flow, not the work queue.)

## Direct chapter authoring - scope `submissions:write`

This is separate from work-item submissions. It requires an editor or
maintainer role in addition to the effective scope. It has no claim, lease, or
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

### `POST /v1/projects/{project}/chapter-submissions` - revise a chapter

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

## Work queue - reads, scope `work:read`

### `GET /v1/projects/{project}/work-items?status=ready&limit=&cursor=`
`status` is one of `ready leased submitted applying completed conflict failed
cancelled`; an unknown value is `400 validation-failed`. Returns
`{ "items": [ {workItem, support} ], "nextCursor": ... }`.

### `GET /v1/projects/{project}/work-items/{workItemId}`
One item, plus its `decision`. A work item is
`{ id, projectId, type, status, sourceAnnotationId, chapterId, baseRevision,
target, priority, createdAt, updatedAt }`.

## Lease lifecycle - scope `work:claim`

### `POST /v1/projects/{project}/work-items/{workItemId}/claim`
**No request body.** On `201` returns the task bundle:
```json
{
  "workItem": { "id", "type", "acceptanceCriteria": [...], "priority" },
  "lease": { "id", "token", "expiresAt", "maxExpiresAt", "renewalPromptAt" },
  "document": { "chapterId", "revision", "contentHash", "source" },
  "target": { "blockId?", "exact?", "start?", ... },
  "context": { "annotationBody", "chapterSummary", "storyRefs": [...] },
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

## Submission - scope `submissions:write`

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
submission-type-mismatch`. On success: `202 { submissionId, operationId,
status: "queued" }`.

A `range_replacement` must be single-line - any `\n` or `\r` in its `content`
is `400`. Empty `content` is a deletion, legal only for `range_replacement`.

### `GET /v1/projects/{project}/operations/{operationId}`
Scope `chapters:read`. Poll until terminal:
`{ id, state, attempts, commitSha, error, ... }`. Terminal states are
`committed`, `verified`, `failed`. A `committed` operation whose `error` parses
to `{ "code": "submission-conflict" }` means the chapter was left untouched and
a `resolve_conflict` work item was created - do not resubmit; claim that.

## Watching instead of polling

### `GET /v1/projects/{project}/events`
Server-sent events. Add `?poll=1` for a JSON page
`{ items, latestId }` - the simple-agent fallback. Resume with a
`Last-Event-ID` header or `?after={id}`. Streams close after 5 minutes; too
many concurrent streams from one address is `429` with `Retry-After`. Events
are notifications only - refetch the authoritative resource after reconnecting.

## Voting - scope `votes:write` (Reviewer role only)

### `PUT /v1/projects/{project}/annotations/{annotationId}/vote`
Cast or change a vote on a suggestion. Granted only where the project allows
it; absent from `GET /v1/me` scopes means you cannot vote. See
`../roles/reviewer.md`, and safety rule 2 - a vote is never a tool for
advancing your own work.

## Rate limits

Per-token and per-actor, in fixed 60-second windows, on mutations only. `429`
carries `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`. Claim,
renew and release share one budget (30/token/min); submissions another
(20/token/min). Minting more tokens does not buy more throughput - the ceiling
is per owner too. `GET /v1/projects/{project}/rate-limits` reports the ceilings
in plain language so you can discover them at runtime.
