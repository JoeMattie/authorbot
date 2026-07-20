# Phase 2 implementation contract — identity and collaboration records (API-first)

Subordinate to `AUTHORBOT_PROJECT_DESIGN.md` (§9, §10.1, §14.3, §15, §19, §20,
§23 Phase 2) and additive to the Phase 0/1 contracts. Scope decision: this pass
delivers the API and persistence; the inline annotation UI is Phase 2b. Exit
criterion (design §23): a range suggestion survives refresh, repository
rebuild, and service restart — provable via API.

## 1. Shape and scope

**In:** `apps/api` (Cloudflare Worker, Hono 4, TypeScript); `packages/domain`
(pure state machines/invariants); `packages/database` (migrations +
repositories over a portability interface); `packages/repo-coordinator`
(outbox → serialized Git commits via adapter). Human sessions (GitHub OAuth
behind an interface + a dev provider), agent tokens, memberships/roles,
annotations + replies with Git mirroring, chapter projections, GitHub webhook
ingest, audit events, idempotency.

**Out (deferred):** votes/rules/decisions (Phase 3), work items/leases
(Phase 4), GitHub App Git writes + PR mode (Phase 5 — this phase writes Git
through a local adapter), SSE events (Phase 3), rate limiting (Phase 6),
collaborator UI (Phase 2b), multi-project.

## 2. Database contract

Portability: repositories are written against a minimal `SqlDatabase`
interface (prepared statements, `batch` for transactional multi-statement
writes) with two adapters: **D1** (production) and **better-sqlite3**
(tests/local Node). Migrations are plain SQL files in `migrations/`
(wrangler-d1-compatible numbering); one schema for both adapters.

Tables (design §9.2 subset): `projects`, `actors`, `project_memberships`,
`human_sessions`, `agent_tokens`, `chapters` (projection), `annotations`,
`replies`, `git_operations`, `outbox`, `idempotency_keys`,
`webhook_deliveries`, `audit_events`.

Constraints that MUST exist: unique `(project_id, actor_id)` membership;
unique agent-token hash; unique idempotency `(project_id, actor_id, key)`;
unique webhook delivery id; annotations/replies keyed by UUIDv7 with status
and `git_operation_id`; `audit_events` append-only.

## 3. Identity and authorization

- **Agent tokens:** `authorbot_<43 chars base64url (256-bit random)>`.
  Stored as SHA-256 hash only. Fields: name, scopes[], expires_at (≤ 90d
  default 30d), created_by, revoked_at, last_used_at (updated at most once
  per minute). Sent as `Authorization: Bearer`. Minted/revoked by maintainers
  via API; the plaintext appears exactly once in the mint response.
- **Human sessions:** opaque 256-bit session id in an HttpOnly, Secure,
  SameSite=Lax cookie, HMAC-signed (SESSION_SECRET); server-side row with
  expiry (7d) and actor id. `IdentityProvider` interface with two
  implementations: `github` (OAuth web flow; config via env; implemented but
  exercised only when configured) and `dev` (AUTH_MODE=dev: `POST
  /v1/dev/login {login, role}` creates/loads the actor+membership and issues a
  session; the route MUST NOT mount when AUTH_MODE=github).
- **Roles → scope bundles** (design §19.3): reader `chapters:read,
  annotations:read`; contributor + `annotations:write`; editor + `work:read,
  work:claim, submissions:write` (granted now, used in Phase 4); maintainer +
  `tokens:manage, members:manage`. An agent's effective scopes =
  token.scopes ∩ its membership role bundle.
- Every mutation records an `audit_events` row (actor, action, target,
  correlation id). Never log or store token/session plaintext.

## 4. API surface (this pass)

Conventions per design §15.1: `/v1` prefix, UUIDv7, RFC3339 UTC,
`Idempotency-Key` required on all mutations, `application/problem+json`
errors with stable `type` slugs, cursor pagination, `X-Correlation-Id` on
every response. Single project per deployment; `{projectId}` must match the
configured project.

```text
GET    /v1/me
GET    /v1/projects/{projectId}
GET    /v1/projects/{projectId}/members
POST   /v1/projects/{projectId}/agent-tokens          (maintainer)
DELETE /v1/projects/{projectId}/agent-tokens/{tokenId} (maintainer)
GET    /v1/projects/{projectId}/chapters
GET    /v1/projects/{projectId}/chapters/{chapterId}
GET    /v1/projects/{projectId}/chapters/{chapterId}/annotations
POST   /v1/projects/{projectId}/chapters/{chapterId}/annotations
POST   /v1/projects/{projectId}/annotations/{annotationId}/replies
POST   /v1/projects/{projectId}/annotations/{annotationId}/withdraw
GET    /v1/projects/{projectId}/operations/{operationId}
POST   /v1/webhooks/github
POST   /v1/dev/login                                   (dev mode only)
```

Annotation create: `{ kind: comment|suggestion, scope: range|block|chapter,
chapterRevision, target? { blockId, textPosition?, textQuote? }, body }`.
Server validation: chapter exists in projection; `chapterRevision` equals the
projected revision (else 409); for range/block scope the `blockId` exists in
that revision; `textPosition.end > start`; body is Markdown ≤ 32 KiB passing
Phase 0 safety rules (no raw HTML, allowed URL schemes only). Withdraw is
author-or-maintainer. Idempotency: replay with same key + same request hash
returns the stored response; same key + different hash → 409.

## 5. Git mirroring (design §7.3, §20)

- Command flow: within one DB batch — insert record (status `pending_git`),
  audit event, and `outbox` row; respond `202` with `operationId`. The
  **processor** drains the outbox per project serially: renders artifact
  files (Phase 0 contract §4 formats: `.authorbot/annotations/<id>/annotation.md`,
  `replies/<reply-id>.md`; withdraw updates frontmatter `status`), then
  commits via `BookRepoWriter`.
- `BookRepoWriter.commitFiles({ branch, expectedHeadOverride?, files,
  message, trailers }) → { commitSha }` — one commit per logical mutation,
  commit trailers per design §14.3 (`Authorbot-Actor`, `Authorbot-Annotation`,
  `Authorbot-Operation`). Implementations: **LocalGitAdapter** (Node-only,
  spawns `git` against a work-tree path — used by tests and local dev) and a
  typed `GitHubAdapter` stub that throws `not-implemented` (Phase 5).
- `git_operations` states per design §20.2 (`queued → preparing → committing
  → committed → verified`, failures → `conflict|failed`); bounded retries (3).
  Records become `synced` (status leaves `pending_git`) only after commit.
- Processor invocation: in-process after each command in dev/tests
  (`MIRROR_MODE=inline`); production wiring to a Durable Object alarm is
  Phase 5 (`MIRROR_MODE=queue` records outbox only).
- **Projection**: `BookRepoReader` (local FS implementation) + a rebuild
  routine that scans the repo with `@authorbot/schemas`/`@authorbot/markdown`
  and repopulates `chapters`, `annotations`, `replies` from committed
  artifacts (design §7.5 rebuildability). Webhook `POST /v1/webhooks/github`:
  verify `X-Hub-Signature-256` (HMAC of raw body with WEBHOOK_SECRET), dedupe
  on delivery id, then trigger rebuild.

## 6. Configuration

Env/bindings: `DB` (D1), `AUTH_MODE`, `SESSION_SECRET`, `WEBHOOK_SECRET`,
`GITHUB_CLIENT_ID/SECRET` (github mode), `BOOK_REPO_PATH` (local dev),
`PROJECT_SLUG`, `PROJECT_REPO` (e.g. `JoeMattie/causal-projector`),
`INITIAL_MAINTAINER` (e.g. `github:JoeMattie`). First-boot seed creates the
project row and the initial maintainer membership idempotently. Secrets never
in code or fixture repos.

## 7. Exit criteria

1. Integration test (Node, better-sqlite3 + LocalGitAdapter + temp book repo
   cloned from `examples/book-repo`): dev-login → create range suggestion →
   `202` → operation reaches `committed` → annotation file exists in the Git
   work tree with correct frontmatter and trailer-bearing commit →
   **new app instance, same DB** serves it → **fresh DB, projection rebuild
   from the repo** serves it again. (The Phase 2 exit criterion.)
2. Authorization matrix tests: every endpoint × {anonymous, reader,
   contributor, maintainer, agent-with/without-scope, revoked token, expired
   token} — enforced and audited.
3. Idempotency replay + mismatch tests; annotation revision-conflict test
   (stale `chapterRevision` → 409).
4. Webhook: bad signature 401, duplicate delivery ignored, valid push
   triggers rebuild.
5. Token storage: DB contains only hashes (test asserts no plaintext).
6. `wrangler dev` boots `apps/api` with local D1 and AUTH_MODE=dev
   (documented in apps/api/README; smoke script included).
7. `openapi/openapi.yaml` updated so every implemented endpoint matches the
   spec (paths, request/response shapes for this pass).
8. Workspace `pnpm build`, `pnpm typecheck`, `pnpm test` green; Phase 0/1
   regressions intact.
