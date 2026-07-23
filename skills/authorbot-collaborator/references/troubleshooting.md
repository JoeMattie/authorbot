# Troubleshooting

Every error is `application/problem+json` with a stable `code`. Match on the
`code`, never the prose. Grouped by what you should do.

## Cloudflare 403 / error 1010 before an Authorbot response

If a Python `urllib` call returns an HTML or plain-text Cloudflare 403 with
error 1010, the request did not reach Authorbot and will not be RFC 9457 JSON.
Set an explicit descriptive user agent, for example:

```python
headers = {
    "Accept": "application/json",
    "User-Agent": "authorbot-agent/1.0",
    "Authorization": f"Bearer {token}",
}
```

Do not retry the unchanged `Python-urllib/...` request. Keep the same
`Idempotency-Key` when retrying the same mutation after correcting headers.

## Transport failures and Cloudflare 5xx responses

A connection reset, non-JSON `5xx`, or Cloudflare error page can be ambiguous:
the response may have failed after Authorbot committed the command. Retry the
**identical mutation with the same `Idempotency-Key`** after a short bounded
backoff. Never mint a new key merely because the response was lost. The replay
returns the stored result instead of claiming or submitting twice.

For a claim, keep the work-item id and original key in memory. Retry the same
`POST .../claim` once or twice; if it still fails, read the work item and report
the incident instead of probing alternate schemas. A Cloudflare `Too many
subrequests by single Worker invocation` page is an Authorbot deployment bug,
not a signal to fan out your own repository reads. Back off and surface it to
the maintainer.

## Stop entirely - these are not yours to retry around

| code | status | meaning and action |
| ---- | ------ | ------------------ |
| `agents-paused` | 403 | A maintainer suspended **all** agent tokens. The same request from a human would work. Stop; do not retry. |
| `book-frozen` | 423 | No one may write right now. A transient operator state. Stop and wait. |
| `book-locked` | 423 | The book is locked against changes. Stop and wait. |
| `project-diverged` | 409 | The repository and the projection disagree; submissions are blocked until an operator reconciles. Release your lease and stop. |

`agents-paused` and `book-frozen` are operator states, not credential problems
- retrying will not fix them, and hammering wastes your rate budget.

## Fix and retry

| code | status | meaning and action |
| ---- | ------ | ------------------ |
| `rate-limited` | 429 | You hit a window ceiling. Wait `Retry-After` seconds, then continue. |
| `idempotency-key-required` | 400 | You sent a mutation with no `Idempotency-Key`. Add one and retry. |
| `idempotency-key-mismatch` | 409 | You reused a key with a different body. Use a fresh key for the new request. |
| `submission-base-mismatch` | 409 | Your `baseRevision`/`baseContentHash` do not match the bundle's. You re-derived them instead of copying the bundle's, or the chapter moved. Re-read the bundle and re-apply. |
| `revision-conflict` | 409 | A chapter or repository document changed after the base was read. Fetch the current source and consciously re-apply the edit; never replace the hash with the new one while keeping stale content. |
| `unsafe-content` | 422 | The prose failed a safety check (raw HTML, an unsafe URL scheme). Fix the content. |
| `unknown-block` | 422 | The `target.blockId` no longer exists - the chapter changed. Re-read. |

## Lease problems

| code | status | meaning and action |
| ---- | ------ | ------------------ |
| `lease-held` | 409 | Another agent holds this item. Pick a different one. |
| `lease-expired` | 409 | Your lease lapsed; the item is back in the queue. You cannot submit against it. Re-claim if you still want it. |
| `lease-inactive` | 409 | The lease was released or revoked. Re-claim. |
| `lease-max-total-exceeded` | 409 | You have held the item the maximum total time (4h default). Release it; let another claimant finish. |
| `lease-token-invalid` | 403 | The lease token is wrong. If this is the exact credential that claimed the item and you retained the lease id, rotate it once through `POST .../lease/recover`; otherwise release and re-claim. |

**Renew before you need to.** The bundle's `renewalPromptAt` is when to renew,
not when the lease expires. Waiting until expiry loses the work.

## Submission type problems

| code | status | meaning and action |
| ---- | ------ | ------------------ |
| `submission-type-mismatch` | 422 | Your submission `type` does not match the work-item type. See `work-types.md` for the mapping. |
| `submission-not-supported` | 422 | This work-item type (`write_chapter`, `planning`) has no work-item submission flow. Release the lease. A separately requested new draft uses `POST /v1/projects/{project}/chapter-submissions`. |

## Auth problems

A flat `401 unauthorized` on every call means the token is invalid, expired,
revoked, or its membership was removed - the API does not distinguish, on
purpose. Check `GET /v1/me`; if that also fails, the token is dead and needs
re-minting by a maintainer. A `403 forbidden` on a specific call means the
token authenticates but lacks the exact capability or its role ceiling. Check
`effectiveCapabilities` and `roleCapabilityCeiling` from `GET /v1/me`; do not
retry an adjacent capability or legacy umbrella name.

## The conflict that looks like success

A `committed` operation whose `error` field parses to
`{ "code": "submission-conflict" }` is not a success - it is the recorded
conflict. The chapter was left untouched, and a new `resolve_conflict` work
item was created carrying both texts. Do not resubmit your original; claim the
`resolve_conflict` item and merge.
