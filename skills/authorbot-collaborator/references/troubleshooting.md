# Troubleshooting

Every error is `application/problem+json` with a stable `code`. Match on the
`code`, never the prose. Grouped by what you should do.

## Stop entirely — these are not yours to retry around

| code | status | meaning and action |
| ---- | ------ | ------------------ |
| `agents-paused` | 403 | A maintainer suspended **all** agent tokens. The same request from a human would work. Stop; do not retry. |
| `book-frozen` | 423 | No one may write right now. A transient operator state. Stop and wait. |
| `book-locked` | 423 | The book is locked against changes. Stop and wait. |
| `project-diverged` | 409 | The repository and the projection disagree; submissions are blocked until an operator reconciles. Release your lease and stop. |

`agents-paused` and `book-frozen` are operator states, not credential problems
— retrying will not fix them, and hammering wastes your rate budget.

## Fix and retry

| code | status | meaning and action |
| ---- | ------ | ------------------ |
| `rate-limited` | 429 | You hit a window ceiling. Wait `Retry-After` seconds, then continue. |
| `idempotency-key-required` | 400 | You sent a mutation with no `Idempotency-Key`. Add one and retry. |
| `idempotency-key-mismatch` | 409 | You reused a key with a different body. Use a fresh key for the new request. |
| `submission-base-mismatch` | 409 | Your `baseRevision`/`baseContentHash` do not match the bundle's. You re-derived them instead of copying the bundle's, or the chapter moved. Re-read the bundle and re-apply. |
| `unsafe-content` | 422 | The prose failed a safety check (raw HTML, an unsafe URL scheme). Fix the content. |
| `unknown-block` | 422 | The `target.blockId` no longer exists — the chapter changed. Re-read. |

## Lease problems

| code | status | meaning and action |
| ---- | ------ | ------------------ |
| `lease-held` | 409 | Another agent holds this item. Pick a different one. |
| `lease-expired` | 409 | Your lease lapsed; the item is back in the queue. You cannot submit against it. Re-claim if you still want it. |
| `lease-inactive` | 409 | The lease was released or revoked. Re-claim. |
| `lease-max-total-exceeded` | 409 | You have held the item the maximum total time (4h default). Release it; let another claimant finish. |
| `lease-token-invalid` | 403 | The lease token is wrong. You lost it, or copied it wrong — it is shown only once at claim. Release and re-claim. |

**Renew before you need to.** The bundle's `renewalPromptAt` is when to renew,
not when the lease expires. Waiting until expiry loses the work.

## Submission type problems

| code | status | meaning and action |
| ---- | ------ | ------------------ |
| `submission-type-mismatch` | 422 | Your submission `type` does not match the work-item type. See `work-types.md` for the mapping. |
| `submission-not-supported` | 422 | This work-item type (`write_chapter`, `planning`) has no submission flow. Release the lease. |

## Auth problems

A flat `401 unauthorized` on every call means the token is invalid, expired,
revoked, or its membership was removed — the API does not distinguish, on
purpose. Check `GET /v1/me`; if that also fails, the token is dead and needs
re-minting by a maintainer. A `403 forbidden` on a specific call means the
token authenticates but lacks the scope for it — check the effective scopes
`GET /v1/me` reported, and do not retry.

## The conflict that looks like success

A `committed` operation whose `error` field parses to
`{ "code": "submission-conflict" }` is not a success — it is the recorded
conflict. The chapter was left untouched, and a new `resolve_conflict` work
item was created carrying both texts. Do not resubmit your original; claim the
`resolve_conflict` item and merge.
