# Phase 5 implementation contract — GitHub integration and publication tracking

Subordinate to `AUTHORBOT_PROJECT_DESIGN.md` (§14, §17.3, §18.1, §20.2–20.3,
§23 Phase 5) and additive to Phase 0–4 contracts. Exit criterion (design §23):
a successful edit becomes one auditable commit and one published revision.

This phase closes the two gaps the live deployment exposed: the Worker can
neither **read** the book repository (chapter projection is empty, so
annotation writes cannot validate) nor **write** to it (outbox rows never
drain). Both are solved by one package plus a serialized coordinator.

## 1. Scope

**In:** `packages/git-github` (GitHub App auth, Git Data API writer, repo
reader); the `ProjectCoordinator` Durable Object (serialized commits, outbox
drain, lease sweep, projection refresh); webhook-driven reconciliation;
publication/deployment tracking (design §17.3); a deterministic fake GitHub
API for tests; operator setup documentation.

**Out (deferred to Phase 6):** pull-request mode (§14.4 — direct-to-main
only, per §26.1), GitHub Enterprise, rate limiting, restore drills,
notifications, multi-project.

## 2. GitHub App authentication (design §14.1)

- App credentials: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PKCS#8 PEM,
  secret), `GITHUB_INSTALLATION_ID`. All optional — absent means Git
  integration is disabled and the API behaves exactly as it does today
  (degraded, not broken; `/v1/projects/{id}` reports `gitIntegration:
  "unconfigured"`).
- App JWT signed **RS256 via WebCrypto** (`crypto.subtle.importKey` on the
  PKCS#8 key, `RSASSA-PKCS1-v1_5` + SHA-256); 9-minute expiry, 60s backdated
  `iat` for clock skew. Never Node `crypto`; this must run in a Worker.
- Installation tokens fetched with the app JWT, cached in memory per isolate
  until 5 minutes before expiry, refreshed on 401. **Never logged, never
  persisted, never in a task bundle or artifact.**
- Required permissions, documented for the operator: `contents: write`,
  `metadata: read`. Webhooks: `push`.

## 3. Repository reader (closes the projection gap)

`GitHubBookRepoReader implements BookRepoReader` (the Phase 2 interface, so
`rebuildProjection` works unchanged):

- `readTextFile(path)` — path containment rules identical to the local
  reader (absolute paths and `..` segments refused before any request).
- `readSnapshot()` — one `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1`
  at the default branch head, then blob fetches for matching paths only
  (`chapters/*.md`, `story/**`, `.authorbot/**`, `book.yml`). Truncated trees
  are an explicit error, never a silent partial snapshot.
- Blob fetches bounded by concurrency (≤ 8) and count; base64 decoded.
- Every snapshot records the commit SHA it was taken at; the projection
  stores it so reconciliation can detect drift.

## 4. Repository writer (design §14.2)

`GitHubBookRepoWriter implements BookRepoWriter`, replacing `LocalGitAdapter`
in production. `commitFiles` follows the §14.2 sequence exactly:

1. `GET /git/ref/heads/{branch}` → current head (or use `expectedHeadOverride`
   from the Phase 4 apply, which pins the head resolved at patch time).
2. Create blobs for each changed file.
3. Create a tree with `base_tree` = the head commit's tree.
4. Create a commit with the head as sole parent, message + §14.3 trailers,
   author/committer = the Authorbot service identity (design §14.3: Git
   identity is the service; human/agent credit lives in attribution records).
5. `PATCH /git/refs/heads/{branch}` with **`force: false`**.
6. On 422 (non-fast-forward) the head moved: reload, re-validate semantic
   preconditions, retry — bounded at 3 attempts.
7. Exhausted retries or a failed precondition → typed conflict, never a force
   update.

`resolveHead(branch)` is implemented (Phase 4 flagged it as required here, so
apply commits are head-pinned).

## 5. Serialization: the ProjectCoordinator Durable Object (design §6.2)

- One DO instance per project id. All Git-touching work goes through it, so
  commits for a project are serialized regardless of isolate count.
- Methods: `drainOutbox()`, `refreshProjection()`, `sweepLeases()`.
- `MIRROR_MODE=durable` (new, the production value) routes mutations to
  `DO.drainOutbox()` after the command's DB batch commits; `queue` and
  `inline` keep their Phase 2 meanings so tests and local dev are unchanged.
- **Alarms**: a periodic alarm (default 60s, `COORDINATOR_ALARM_SECONDS`)
  drains any outbox backlog, sweeps expired leases (Phase 4 §2 requires this
  in production), and refreshes the projection when a webhook marked it
  stale. Alarms reschedule themselves and are idempotent — a duplicate drain
  must never double-commit (the Phase 4 outbox claim semantics carry this).
- The DO holds no durable state beyond scheduling bookkeeping; D1 remains the
  source of operational truth so a DO reset loses nothing.

## 6. Reconciliation and publication tracking

- Webhook `push` on the default branch: verify signature, dedupe delivery,
  mark the projection stale, and ask the coordinator to refresh. The
  refresh re-reads the snapshot and applies it through the existing
  id-keyed upsert path (Phase 3 §7.5 semantics — pending rows preserved).
- Detect **external edits**: a projected chapter whose content hash changed
  without an Authorbot operation bumps its revision from the file's own
  frontmatter and re-anchors annotations (Phase 4 §5 rules). A chapter whose
  frontmatter `revision` moved backwards, or whose block ids vanished while
  annotations reference them, marks the project `diverged`: prose writes are
  refused with a clear problem type while reads keep working (design §14.5).
- Publication state per design §17.3 — never mark a revision published
  because a commit succeeded. Track `integrated_commit`, `build_status`,
  `deployed_commit`, `public_url`, `deployed_at`, `publisher_version` in a
  `publications` table, fed by a signed CI callback
  `POST /v1/publications` (HMAC with `WEBHOOK_SECRET`, delivery-id
  deduped). `GET /v1/projects/{id}` exposes integrated-vs-deployed so the
  gap is visible rather than assumed.

## 7. Testing

- **Fake GitHub**: an in-process implementation of the Git Data API subset
  (refs, blobs, trees, commits, installation tokens) with a real content
  model, so writer and reader are tested deterministically — including
  moved-head retry, truncated trees, 401 token refresh, and 422 non-fast-
  forward. No network in the default suite.
- Round trip: write a commit through the writer into the fake, then read it
  back through the reader and rebuild the projection from it — the Phase 2
  rebuildability guarantee, now over GitHub.
- Serialization: concurrent mutations through one coordinator produce
  correctly ordered, non-overlapping commits; a duplicate drain commits once.
- Reconciliation: external edit re-projects and re-anchors; a backwards
  revision marks `diverged` and blocks writes but not reads.
- Publication: signed callback updates state; bad signature rejected;
  integrated≠deployed surfaced.
- **Optional live smoke** (`GITHUB_LIVE_TEST=1` + credentials, skipped by
  default and in CI): commit a scratch file to a throwaway branch of a real
  repository, read it back, delete the branch. Never runs against `main`.

## 8. Exit criteria

1. An annotation created through the API lands as a real commit in the book
   repository (fake-GitHub integration test end to end), and the projection
   rebuilt from GitHub serves it — reads and writes both closed.
2. A Phase 4 submission completes through the GitHub writer: one commit
   containing chapter bump, work-item disposition, annotation acceptance,
   and attribution, with §14.3 trailers and no force update.
3. Moved-head retry succeeds within bounds; exhaustion yields a conflict,
   never a clobber — asserted by content, not just status.
4. Coordinator serialization holds under concurrent mutations; duplicate
   drains commit once.
5. Webhook reconciliation projects an external edit and re-anchors; a
   divergent repository blocks prose writes while reads continue.
6. Publication tracking distinguishes integrated from deployed.
7. Workspace green; all Phase 0–4 suites, e2e, and regressions intact;
   OpenAPI synced; operator setup documented well enough to configure the
   GitHub App without reading source.
