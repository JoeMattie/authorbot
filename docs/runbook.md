# Operator runbook

For the person on call at 3am who has never read the source.

This document describes what Authorbot does when things go wrong, how to tell
which thing is going wrong, and what to do about it. Every procedure here was
checked against the code; where a capability does not exist, it says so
plainly instead of describing one that would be nice to have. Those gaps are
collected in [§9 Known gaps](#9-known-gaps) - read that section before you
plan any work that depends on a tool existing.

**Conventions.** `{project}` is the project id (a UUID) or its slug, depending
on the call. Bindings and secrets are named as they appear in
`apps/api/wrangler.jsonc` and `wrangler secret`. Anything shown as SQL is run
with `wrangler d1 execute`.

---

## 1. The thirty-second orientation

Authorbot keeps its data in two places, and knowing which one you are looking
at answers most questions.

| | Git repository | Operational database (D1) |
|---|---|---|
| Holds | Prose, annotations, replies, decisions, work items, attribution, `book.yml` | A **projection** of all of the above, plus sessions, agent tokens, leases, submissions, the outbox, votes, idempotency keys, delivery ledgers, audit events |
| Is | The source of truth | Rebuildable from the repository |
| Losing it | Is a disaster | Is an incident, not a disaster (see [§4](#4-backup-and-restore)) |

Writes go in one direction: an HTTP command lands in D1 inside one atomic
batch (the record, an audit event, and an **outbox** row), returns **`202`
with an `operationId`**, and a background **coordinator** later drains that
outbox into a real Git commit. A `202` therefore means *accepted*, never
*committed*. Reads are served entirely from the projection and never touch
GitHub, which is why nearly every failure below leaves reads working.

### Your first three calls

```bash
# 1. The whole health picture in one response.
curl -s https://<api-host>/v1/projects/{project} -H "Cookie: <session>" | jq

# 2. Is there a backlog?
wrangler d1 execute authorbot --command \
  "SELECT status, COUNT(*) FROM outbox GROUP BY status"

# 3. Are operations failing?
wrangler d1 execute authorbot --command \
  "SELECT state, COUNT(*) FROM git_operations GROUP BY state"
```

Call 1 returns the fields you will use throughout this runbook:

```jsonc
{
  "gitIntegration": "configured",       // or unconfigured | incomplete | invalid
  "projection": { "commit": "…", "stale": false },
  "divergence": { "state": "ok" },      // or { "state": "diverged", … }
  "publication": {
    "integratedCommit": "…",            // what Authorbot has projected
    "deployedCommit": "…",              // what CI says is live
    "buildStatus": "succeeded",
    "inSync": true
  }
}
```

---

## 2. Failure modes: what each looks like from outside

Every one of these is covered by an automated test in
`apps/api/test/resilience-failure-injection.test.ts`. If you change behaviour
here, that suite is where the contract lives.

### 2.1 Coordinator backlog - "my comment never showed up in GitHub"

**Symptom.** Writes still return `202`. Reads work. Nothing new appears in the
repository. `GET /v1/projects/{project}/operations/{operationId}` reports
`"state": "queued"` with `"commitSha": null`. (A healthy operation ends at
`committed`, and then `verified` once the commit has been read back.)

```sql
SELECT COUNT(*) FROM outbox WHERE status = 'pending';
```

**What it means.** The coordinator (a Durable Object) is not draining. Causes,
in rough order of likelihood: the `COORDINATOR` binding is missing; the cron
trigger that arms the coordinator's alarm is not firing; `MIRROR_MODE` is
`queue` (which records outbox rows and deliberately never drains them); or
GitHub credentials are absent, in which case `gitIntegration` reads
`unconfigured` and the drain refuses to claim any row at all.

**Why nothing is lost.** Rows are left `pending`, never failed. Annotation
bodies live in the `annotations` row with status `pending_git` and the
projection rebuild is specifically written never to delete them. A backlog is
a delay.

**What still works, and what quietly does not.** Intake keeps working:
annotations, replies and withdrawals are all accepted while the queue grows.
But **governance stalls behind the backlog.** A vote on an annotation that has
not reached Git yet is refused:

```jsonc
{ "code": "state-conflict", "detail": "cannot vote on an annotation with status \"pending_git\"" }
```

That is a clear, typed refusal rather than a dropped ballot - but it means a
stuck coordinator silently freezes the suggestion → vote → work-item pipeline
for everything queued behind it. Authors will report "my suggestion can't be
approved" long before anyone notices the outbox. Check the outbox first when
that comes in. Once the coordinator drains, the same vote succeeds; nothing is
permanently blocked.

**Do.**

1. Confirm `gitIntegration` is `configured` in call 1. If it is
   `incomplete`, exactly one or two of `GITHUB_APP_ID`,
   `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID` are set - a
   half-configured app deliberately never half-works. If `invalid`, see
   [§5.3](#53-github-app-private-key).
2. Confirm `MIRROR_MODE=durable` and that the `COORDINATOR` Durable Object
   binding exists. With `MIRROR_MODE=durable` and no binding the Worker
   refuses to boot, so if it is running, the binding is there.
3. Confirm the cron trigger (`* * * * *` in `wrangler.jsonc`) is enabled. On a
   deployment that receives neither durable-mode mutations nor webhooks, the
   cron poke is the *only* thing that arms the coordinator's alarm.
4. The backlog drains itself once the coordinator runs. Any mutation, any
   webhook push, or the next alarm tick will do it.

### 2.2 GitHub rate limiting - `403` with `retry-after`

**Symptom.** Reads fine, writes accepted, operations stall then fail. The
`git_operations` row shows a non-null `error`, `state` moves `queued →
failed` once the retry budget (3 attempts) is spent, and `commitSha` stays
`null`.

```sql
SELECT id, state, attempts, error, updated_at
  FROM git_operations WHERE state = 'failed' ORDER BY updated_at DESC LIMIT 20;
```

**What it means.** GitHub answered `403` with `x-ratelimit-reset` and possibly
`retry-after`. A rate limit is classified `retryable`, so a burst that clears
inside the budget is absorbed and the commit succeeds. A `401`, or a `403`
that is *not* a rate limit, is classified non-retryable and fails immediately -
that one usually means the App lost `contents:write` or was uninstalled.

**The retry budget is spent inside a single drain, not across drains.** The
processor loops `conflict → queued` internally, so one drain against a
persistently failing GitHub burns all three attempts and lands the operation
in `failed`. Do not expect "wait and it will retry": once `state` is `failed`,
nothing retries it.

**Do.** Wait for the reset window. The content is not lost - the annotation
row is still `pending_git` with its body intact. There is no supported
re-queue command (see [§9](#9-known-gaps)); recovery today means re-issuing
the client request, or a maintainer resetting the row by hand.

**Do not** conclude from a failed operation that the write was lost. Check the
`annotations` / `replies` row before telling an author to retype anything.

### 2.3 GitHub outage - unreachable, not rate limited

**Symptom.** Identical to 2.2 from the API's point of view, except the stored
`error` is a transport failure rather than a status code. Reads are completely
unaffected: the site and every `GET` are served from the projection.

**What still works during a full GitHub outage.**

- All reads, including the published site.
- All write *intake*: annotations, replies, votes, claims, work-item
  lifecycle. They queue.
- **Lease sweeping.** This matters: the coordinator's alarm runs the lease
  sweep first and unconditionally, so an agent that dies during an outage
  still has its lease expire and its work item returned to `ready`. A Git
  failure inside the alarm is recorded as an error and never aborts the sweep
  or prevents the alarm from rescheduling itself.

**Do.** Nothing, usually. Confirm the outage is GitHub's
(<https://www.githubstatus.com>), then let the backlog drain when it ends. If
operations have already exhausted their attempts and moved to `failed`, treat
as 2.2.

### 2.4 D1 errors

**Symptom.** `500` responses carrying `application/problem+json` with
`"code": "internal"` and a `correlationId`. The response deliberately contains
no database error text - D1 error strings can carry SQL values.

**What it means, and what it guarantees.** Every command writes through one
atomic `batch()`. If that batch fails, *nothing* lands: no record, no audit
event, no outbox row, no commit. There is no half-applied state to clean up.

A D1 failure during the coordinator's drain is the more interesting case,
because the Git commit may already have happened. It is still safe: the
operation is left in `committing` with the real `commitSha` recorded and its
outbox row still `processing`, never in a terminal success state. Rows found
`processing` when a drain starts are treated as crash leftovers and resumed,
and the resumed operation *reuses* the commit it already made rather than
producing a second one. So the outcome is a delay, not a duplicate and not a
loss. If you see `git_operations` rows stuck in `committing`, the fix is to
get a drain to run - not to touch the rows.

**Do.**

1. Grab the `correlationId` from the response and find it in Cloudflare's
   Workers logs.
2. Check D1 health in the Cloudflare dashboard.
3. Retry. The failure leaves no poison - the identical request succeeds once
   D1 is healthy.

### 2.5 A submission arrives against a stale projection

Two distinct shapes, with two distinct refusals. Both are correct behaviour,
not bugs.

**Shape A - an external edit landed under a live lease.** An agent claimed a
work item, someone edited that chapter directly on GitHub, and the push was
reconciled while the agent was still working. The re-anchor pass returns the
work item to `ready` (its task bundle no longer describes text that exists),
so the agent's submission is refused with **`409 state-conflict`**, detail
`work item in status "ready" cannot accept a submission`. The repository is
untouched and the outside editor's prose survives. (`submission-base-mismatch`
is the neighbouring code for a bundle whose base moved without the work item
being reset; both are typed 409s and both mean "re-claim".)

> **Operational wrinkle, verified by test.** The reconciliation resets the
> work item but does **not** release the agent's lease. The item is therefore
> `ready` and still unclaimable: a fresh claim gets `409 lease-held` from a
> lease whose holder has nothing useful left to submit. It clears on its own
> when the lease expires (`LEASE_DURATION`, default 30 minutes, up to
> `LEASE_MAX_TOTAL_DURATION`), or immediately if the holder calls
> `POST /work-items/{id}/lease/release`. If a work item is urgent, ask the
> holder to release rather than waiting.

**Shape B - the project is diverged (`409 project-diverged`).** The
reconciliation found something it cannot resolve deterministically. The
response names the kind and includes a `recovery` field pointing at the fix.

```jsonc
{
  "code": "project-diverged",
  "divergence": { "kinds": ["revision-regressed"], "chapters": [ … ] },
  "recovery": "POST /v1/projects/{projectId}/divergence/clear (maintainer)"
}
```

There are exactly two divergence kinds:

| Kind | Means |
|---|---|
| `revision-regressed` | A chapter's frontmatter `revision` moved *backwards* in the repository. Usually a force-push, a revert, or a bad merge. |
| `anchor-blocks-vanished` | A `<!-- authorbot:block id="…" -->` marker that live annotations point at disappeared from a chapter, with no successor minted. |

**What divergence does and does not block.** It blocks **prose writes only** -
submissions and chapter writes. Reads keep serving the last coherent
projection, the published site keeps serving, and annotations, replies, votes
and lease lifecycle all keep working. Refusing those would turn a repository
problem into a total outage for collaborators who cannot fix it.

**Do.**

1. Look at the `chapters` array in the problem response. It names the file,
   the revision the projection holds, and the revision the repository
   declares.
2. Decide which side is right.
   - **The repository is right** (someone intentionally reverted): clear
     divergence with `resync` left at its default `true`. This accepts the
     repository as truth, re-projects it, and re-anchors annotations -
     annotations whose anchors are genuinely gone become `needs_reanchor`
     rather than staying quietly wrong.
   - **The repository is wrong** (a bad force-push): fix the repository
     first - restore the correct revision numbers or block markers and push -
     then clear with `"resync": false`, which just reopens writes.

```bash
curl -X POST https://<api-host>/v1/projects/{project}/divergence/clear \
  -H "Cookie: <maintainer session>" -H "Origin: https://<api-host>" \
  -H "Content-Type: application/json" \
  -d '{"reason":"reverted a bad force-push; repository is correct"}'
```

Maintainer role required. The action is audited, and clearing without a resync
leaves the projection and repository still disagreeing, so the very next push
diverges again. That is why `resync` defaults to `true`.

---

## 3. Reading the audit log - "who changed this?"

### 3.1 Where it is

Table `audit_events` in D1. It is **append-only, enforced by SQL triggers**:
`UPDATE` and `DELETE` both `RAISE(ABORT, 'audit_events is append-only')`. You
cannot tamper with it, and neither can anything else.

| Column | Notes |
|---|---|
| `id` | UUIDv7 - time-ordered, so `ORDER BY id` is chronological |
| `project_id` | |
| `actor_id` | Nullable. `NULL` means the system did it (projection rebuilds, divergence detection) |
| `action` | See the vocabulary below |
| `target_type` | `annotation`, `reply`, `lease`, `submission`, `chapter`, `project`, … |
| `target_id` | Nullable |
| `correlation_id` | The request id. **This is the join key** - one HTTP request's whole footprint shares it |
| `metadata` | JSON blob, varies by action |
| `created_at` | ISO-8601 |

Index: `(project_id, created_at)`.

### 3.2 There is no API for it

**This is the single biggest operator gap.** There is no endpoint, no CLI, and
no UI that reads `audit_events`. Every query below is `wrangler d1 execute`.
(`GET /v1/projects/{project}/events` exists but reads a *different* table -
the `events` stream, which is a collaboration feed, not the audit record.)

### 3.3 The queries you actually need

**Who touched this annotation, and when:**

```sql
SELECT a.created_at, a.action, a.correlation_id,
       COALESCE(ac.external_identity, 'system') AS who, a.metadata
  FROM audit_events a
  LEFT JOIN actors ac ON ac.id = a.actor_id
 WHERE a.target_id = '<annotation-id>'
 ORDER BY a.id;
```

**Everything one person or agent did:**

```sql
SELECT a.created_at, a.action, a.target_type, a.target_id
  FROM audit_events a
  JOIN actors ac ON ac.id = a.actor_id
 WHERE ac.external_identity = 'github:someone'   -- or 'agent:name'
 ORDER BY a.id DESC LIMIT 200;
```

**The whole footprint of one request** (you have the `correlationId` from a
problem response or a client log):

```sql
SELECT created_at, action, target_type, target_id, metadata
  FROM audit_events WHERE correlation_id = '<id>' ORDER BY id;
```

**Who changed a chapter's prose:** chapter edits go through submissions, so
follow `submission.create` → the applying commit. The durable answer is also
in Git: `.authorbot/attribution/<chapter-id>.yml` lists every revision with
its actor and commit sha, and commit trailers carry `Authorbot-Actor`.

```bash
git log --format='%H %s%n%b' -- chapters/001-baseline.md | grep -A1 Authorbot-Actor
```

### 3.4 Action vocabulary

Actor identities are `github:<login>` for humans, `agent:<name>` for agents,
`system:<name>` for the system.

| Group | Actions |
|---|---|
| Identity | `session.login`, `agent_token.mint`, `agent_token.revoke` |
| Feedback | `annotation.create`, `annotation.withdraw`, `annotation.reanchor`, `reply.create`, `reply.withdraw` |
| Governance | `decision.create`, `decision.support_changed`, `work_item.force_create`, `work_item.cancel` |
| Work | `work_item.claim`, `lease.recover`, `lease.renew`, `lease.release`, `submission.create` |
| Chapter | `chapter.create`, `chapter.revise`, `chapter.publish`, `chapter.unpublish` |
| System | `projection.rebuild`, `projection.external_edit`, `projection.book_config_invalid`, `project.seed`, `project.diverged`, `project.divergence_cleared`, `book_config.update`, `publication.reported` |

One useful detail: `work_item.claim` records the task bundle's base on the
lease (`metadata.baseRevision`, `metadata.baseContentHash`), with
`target_id` set to the **lease id**. That is how you reconstruct what an agent
was actually looking at when it submitted.

---

## 4. Backup and restore

### 4.1 What you are backing up

**The Git repository is the backup.** Prose, annotations, replies, decisions,
work items and attribution all have their durable record in the repository, so
a repository you can clone is a book you can restore. Keep at least one mirror
that is not GitHub. Nothing else in this section matters as much as that
sentence.

**D1 is a projection with a small operational tail.** For D1, use Cloudflare's
Time Travel (point-in-time restore, 30 days) - Authorbot ships no backup job
of its own. But Time Travel is a convenience, not the plan: the plan is
[§4.3](#43-the-restore-procedure).

### 4.2 What a restore does not bring back

The restore drill (`apps/api/test/recovery-restore-drill.test.ts`) asserts
this list *deliberately* - a lease surviving a rebuild would be a bug, and so
would a token. Expect all of it to be gone:

| Gone | Consequence |
|---|---|
| **Human sessions** | Everyone signs in again. Old cookies get `401`. |
| **Agent tokens** | Every token is dead. Mint new ones and redistribute. This is a feature: a bearer credential must not outlive the database holding its hash. |
| **Leases** | Every leased work item comes back `ready` and is immediately claimable by anyone. Any agent still working against an old lease will be refused. |
| **In-flight submissions** | Submission `content` is DB-only by design. An edit submitted but not yet applied to a chapter is **genuinely lost** - the author must redo it. This is the one real data loss in a restore. |
| **Votes** | Ballots are DB-only. Every *decision* those votes produced survives (it is a Git artifact); the raw tallies do not, so support counts restart from zero. |
| **Outbox / git_operations** | Any command accepted but not yet committed is lost. Clients see an `operationId` that no longer resolves. |
| **Idempotency keys** | A replayed request after a restore is a *real* request, not a cached response. Expect duplicates if clients retry aggressively across the restore. |
| **Audit events** | The audit log is DB-only. **It is not restored from Git.** If you need audit history to survive, you need a D1 backup, not a rebuild. |
| **Webhook/publication delivery ledgers** | Deduplication restarts. A redelivered GitHub push is processed again (harmless - the rebuild is idempotent). |

### 4.3 The restore procedure

This is the same sequence the automated drill runs, in the same order. The
drill is the reference: if the procedure below stops matching it, the drill is
right.

1. **Confirm the repository is intact.** Clone it fresh and run
   `pnpm --filter @authorbot/cli start validate <path>`. Do not restore into a
   repository you have not validated.

2. **Create the database and apply migrations.**

   ```bash
   wrangler d1 create authorbot
   wrangler d1 migrations apply authorbot --remote
   ```

3. **Set every binding and secret.** Missing ones fail the boot rather than
   degrading, which is what you want. Required: `AUTH_MODE`,
   `SESSION_SECRET`, `WEBHOOK_SECRET`, `PROJECT_SLUG`, `PROJECT_REPO`,
   `INITIAL_MAINTAINER`, and the `DB` binding. `DEV_LOGIN_ENABLED=true` is
   *additionally* required when `AUTH_MODE=dev` - a second independent guard
   so dev login cannot ship through one misconfigured variable. With
   `AUTH_MODE=github` you also need `GITHUB_CLIENT_ID`,
   `GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URI`. With `MIRROR_MODE=durable`
   you also need the `COORDINATOR` Durable Object binding.

4. **Deploy, then make one request.** The first request seeds the project row
   and runs the projection rebuild from the repository. Check it landed:

   ```sql
   SELECT metadata FROM audit_events
    WHERE action = 'projection.rebuild' ORDER BY id DESC LIMIT 1;
   ```

   The metadata carries `{chapters, annotations, replies, decisions,
   workItems, preservedPending, orphaned}`. Compare those counts against the
   repository.

5. **Verify.** `GET /v1/projects/{project}` should show
   `projection.commit` equal to the branch head and `divergence.state: "ok"`.
   Spot-check a chapter's `revision` against its file, and list annotations on
   it.

6. **Restore the credentials that did not survive.** Mint fresh agent tokens
   and distribute them. Tell humans to sign in again.

7. **Re-establish publication state.** `publication.deployedCommit` will be
   `null` until CI reports again - the API never infers deployment from its
   own knowledge. Trigger a build.

**Rebuilding is safe to repeat.** The rebuild is idempotent: running it twice
over an unchanged repository produces one no-op rebuild and zero re-anchor
decisions. If you are unsure whether step 4 worked, do it again.

### 4.4 Partial recovery: the projection is wrong but the database is fine

The projection refresh is triggered by a verified GitHub `push` webhook, or by
the coordinator's alarm when `projection.stale` is set. **There is no operator
endpoint that forces a rebuild** (see [§9](#9-known-gaps)). Your options are:

- Redeliver the most recent `push` from the GitHub App's Advanced →
  Recent Deliveries page. This is the supported path.
- Push an empty commit to the default branch.
- Set the stale flag by hand and wait up to one alarm interval
  (`COORDINATOR_ALARM_SECONDS`, default 60):

  ```sql
  UPDATE projects SET projection_stale = 1 WHERE id = '<project-id>';
  ```

---

## 5. Key rotation

Three secrets, three very different blast radii. **None of them supports two
valid values at once** - there is no key ring anywhere in this system, so
every rotation below is a hard cutover. Plan accordingly.

### 5.1 `SESSION_SECRET`

**What it protects.** Session cookies are `<sessionId>.<HMAC-SHA256>`. The
HMAC is verified before any database lookup.

**What breaks, immediately and completely.** Every outstanding session cookie
becomes invalid the moment the new secret is live. There is no grace period,
no dual-secret window, and no way to stage it.

- Every signed-in human is logged out and gets `401` on their next request.
  Sessions last 7 days, so on a busy book this is *everyone*.
- Any OAuth login in flight fails. The OAuth state cookie is signed with the
  same secret and lives for 10 minutes, so the tail is short.
- **Agent tokens are unaffected.** They are bearer credentials hashed into
  `agent_tokens`, and the session secret is not involved. Agent fleets keep
  working straight through a session rotation.

**Do.**

```bash
wrangler secret put SESSION_SECRET   # then paste a fresh 32+ byte random value
```

Announce it first. There is nothing to clean up afterwards: the stale
`human_sessions` rows are harmless and expire on their own.

**Rotate when:** you suspect the secret leaked, or on a schedule you have
decided you can absorb the mass logout for. Note that rotation is currently
the *only* way to invalidate all sessions at once (see [§9](#9-known-gaps)),
which makes it your emergency "log everybody out" button.

### 5.2 `WEBHOOK_SECRET` and `PUBLICATION_SECRET`

**Two protocols, two secrets - set both.**

| Consumer | Secret | Header | Signed material |
|---|---|---|---|
| GitHub push webhook | `WEBHOOK_SECRET` | `x-hub-signature-256` | raw body only |
| CI publication callback | `PUBLICATION_SECRET` | `x-authorbot-signature-256` | `<deliveryId>.<timestamp>.<rawBody>` |

These used to be one value, which was the trap: `WEBHOOK_SECRET` lives in the
GitHub App's webhook configuration while the publisher's copy lives in the book
repository's **Actions secrets**, so a single shared value meant whoever held
either could forge the other's requests, and you could not rotate them
atomically.

**If `PUBLICATION_SECRET` is unset, the API falls back to `WEBHOOK_SECRET`** -
purely for compatibility with deployments that predate the split. Treat that as
a state to leave, not a configuration to keep. To split them, with no window in
which anything is signed with the wrong key:

1. `wrangler secret put PUBLICATION_SECRET` with a fresh random value.
2. Update the CI publisher's copy of the secret to that same value.
3. Trigger a build; confirm `publication.buildStatus` moves.

The GitHub webhook secret is untouched throughout, so pushes never stop.

**Rotating either one afterwards** touches one producer, so it is an ordinary
rotation: change the Worker secret, change the single consumer, confirm.

**What breaks if a value goes wrong.**

- **GitHub pushes: recoverable.** A push signed with the old secret gets
  `401`, and - importantly - the failing request returns *before* recording a
  delivery id. GitHub retries with the same delivery id, and once you have
  updated the App's webhook secret those retries are accepted. You lose
  reconciliation latency, not pushes.
- **Publication callbacks: not recoverable.** CI is not expected to retry, a
  duplicate delivery id is refused even after a failure, and the callback
  carries a **5-minute skew window** so a delayed retry expires anyway. A
  callback signed with the wrong key is simply lost; the site will look stale
  until the next successful build reports.

**Rotating `WEBHOOK_SECRET`, in this order:**

1. `wrangler secret put WEBHOOK_SECRET`.
2. Immediately update the GitHub App's webhook secret (App settings →
   Webhook → Secret).
3. Redeliver the most recent `push` from Recent Deliveries to confirm.
4. Verify: `GET /v1/projects/{project}` shows `projection.stale: false`.

**Rotating `PUBLICATION_SECRET`, in this order:**

1. Pick a maintenance moment with no build running - a callback signed with
   the old key is lost, not retried.
2. `wrangler secret put PUBLICATION_SECRET`.
3. Immediately update the CI publisher's copy of the secret.
4. Trigger a build and verify `publication.buildStatus` moved.

**If the two are still sharing `WEBHOOK_SECRET`** (no `PUBLICATION_SECRET`
set), you cannot rotate them atomically and every rotation is the combined
procedure with both windows open at once. Split them first.

### 5.3 GitHub App private key

**Format.** PKCS#8 only - `-----BEGIN PRIVATE KEY-----`. GitHub's download
button gives you PKCS#1 (`BEGIN RSA PRIVATE KEY`), which is **rejected** with
a message telling you the conversion:

```bash
openssl pkcs8 -topk8 -nocrypt -in downloaded.pem -out app-key-pkcs8.pem
```

**What breaks.** Less than you would expect, and for longer than you would
expect.

- Nothing that reads. The projection is local.
- Nothing that *accepts* writes. They queue.
- Commits pause until the new key mints a token.
- **Already-minted installation tokens keep working until they expire.**
  Tokens last an hour and are cached in-process with a 5-minute refresh
  margin. A Worker isolate that survives the rotation can keep using its
  cached token for up to about 55 minutes - the private key is deliberately
  not part of the isolate-level auth cache key. In practice
  `wrangler secret put` produces new isolates and this resolves itself, but do
  not be surprised by a short period of mixed behaviour.

**One sharp edge.** Structural problems (PKCS#1, non-numeric app or
installation id) are caught at boot and reported as `gitIntegration:
"invalid"`. A key that is *well-formed but revoked* reports `"configured"` and
fails later, inside the coordinator, at token-mint time. So after a rotation,
do not trust `gitIntegration` alone - prove it with a real commit.

**Do.**

1. Generate a new private key in the GitHub App settings. **Do not delete the
   old one yet.**
2. Convert to PKCS#8.
3. `wrangler secret put GITHUB_APP_PRIVATE_KEY` (paste the whole PEM; escaped
   `\n` literals are also accepted).
4. Confirm `gitIntegration: "configured"` in call 1.
5. **Prove it with a write.** Post a throwaway annotation and watch its
   operation reach `state: "verified"` with a non-null `commitSha`. This is
   the only check that distinguishes "configured" from "actually working".
6. Only then delete the old key in GitHub.

If you rotate `GITHUB_INSTALLATION_ID` or `GITHUB_APP_ID` too, remember all
three are all-or-nothing: one or two set out of three reports `incomplete` and
performs no Git work at all.

---

## 6. Integrated vs deployed - "this chapter looks stale"

An author says the site is showing old text. There are four distinct places
that could be behind, and they fail differently. Walk them in order.

```
    author writes  →  D1 projection  →  Git commit  →  CI build  →  live site
                          (1)              (2)           (3)          (4)
```

**Call 1 answers most of this in one response.**

### Step 1 - is it committed?

```jsonc
"publication": { "integratedCommit": "abc123…", "deployedCommit": "def456…", "inSync": false }
```

- `integratedCommit` is **`projects.projected_commit`** - the commit Authorbot
  has *projected*. It advances when a push is reconciled, which includes
  Authorbot's own commits: "integrated" means Authorbot has read it back, not
  merely that a write returned success.
- `deployedCommit` is written **only** by the signed CI callback to
  `POST /v1/publications`. Nothing in the API ever infers it.
- `inSync` is true only when both are non-null and equal. Unknown never
  renders as up to date.

**If `integratedCommit` is behind the branch head**, the projection is stale or
the backlog is stuck → [§2.1](#21-coordinator-backlog--my-comment-never-showed-up-in-github) and
[§4.4](#44-partial-recovery-the-projection-is-wrong-but-the-database-is-fine).

**If `integratedCommit` equals the branch head but `deployedCommit` lags**, the
commit exists and the *site* is behind. Look at `buildStatus`:

| `buildStatus` | Reading |
|---|---|
| `null` | CI has never reported for this commit. Is the publisher wired up? Is `PUBLICATION_SECRET` (or, if unset, `WEBHOOK_SECRET`) right on both sides ([§5.2](#52-webhook_secret-and-publication_secret))? |
| `queued` / `building` | It is in flight. Wait. |
| `failed` | The build broke. Go look at CI. |
| `succeeded` with a lagging `deployedCommit` | The build passed but the deploy did not land, or the callback reporting the deploy was lost. |

History, if you need it:

```
GET /v1/projects/{project}/publications?limit=50
```

### Step 2 - is it a different kind of stale?

Three things are easy to confuse with a deployment lag:

- **`projection.stale: true`** - a push arrived and the refresh has not run
  yet. Normally clears within one alarm interval (default 60s). If it persists,
  the coordinator is not running.
- **`divergence.state: "diverged"`** - prose writes are blocked project-wide.
  Reads keep serving the last coherent projection, so the site looks *frozen*
  rather than broken. → [§2.5](#25-a-submission-arrives-against-a-stale-projection).
- **The chapter is `status: "draft"`.** Editorial state, not deployment state.
  A draft chapter is not published to the site no matter how current every
  commit is. A signed-in maintainer sees it in the home page's private Drafts
  section; API diagnosis can use
  `GET /v1/projects/{project}/chapters/{chapterId}`.

### Step 3 - one thing not to trust

The chapter JSON exposes a `lastPublishedCommit` field. **It is always
`null`.** Nothing populates it. Per-chapter publication status does not exist;
publication tracking is project-wide only. Do not build a diagnosis on that
field.

---

## 7. Quick reference: problem codes

Every refusal is `application/problem+json` with a stable `code` and a
`correlationId`. The ones you will see during an incident:

| `code` | Status | Means |
|---|---|---|
| `project-diverged` | 409 | Prose writes blocked; repository disagrees with the projection. Response carries `recovery`. |
| `submission-base-mismatch` | 409 | The agent's task bundle is stale. Re-claim. |
| `state-conflict` | 409 | The resource moved under the request. `detail` always names the offending status - read it. Covers a vote on a `pending_git` annotation and a submission against a work item the reconciliation reset to `ready`. |
| `lease-held` | 409 | Another actor holds the work item - including a work item that is `ready` but still carries an unreleased lease ([§2.5](#25-a-submission-arrives-against-a-stale-projection)). |
| `lease-expired` | 409 | The lease ran out mid-work. |
| `revision-conflict` | 409 | The chapter moved under a write. |
| `signature-invalid` | 401 | Publication callback signature or skew failed. |
| `unauthorized` | 401 | Missing/invalid session or token. After a restore or a `SESSION_SECRET` rotation, expect a lot of these. |
| `internal` | 500 | Something threw. Take the `correlationId` to the logs. |

---

## 8. Configuration reference

Required - the Worker refuses to boot without these: `DB` binding,
`AUTH_MODE` (`dev` or `github`, no fallback), `SESSION_SECRET`,
`WEBHOOK_SECRET`, `PROJECT_SLUG`, `PROJECT_REPO` (`owner/name`),
`INITIAL_MAINTAINER` (`github:<login>`).

Conditionally required: `DEV_LOGIN_ENABLED=true` when `AUTH_MODE=dev`;
`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_REDIRECT_URI` when
`AUTH_MODE=github`; the `COORDINATOR` Durable Object binding when
`MIRROR_MODE=durable`.

Validated at boot, so a typo fails the deploy rather than silently disabling
something: `LEASE_DURATION` (PT30M), `LEASE_RENEWAL_DURATION` (PT30M),
`LEASE_MAX_TOTAL_DURATION` (PT4H), `LEASE_RENEWAL_PROMPT_BEFORE` (PT5M),
`COORDINATOR_ALARM_SECONDS` (60), `RULES_JSON`, `API_BASE_PATH`.

Optional: `MIRROR_MODE` (`inline` | `queue` | `durable`), `DEFAULT_BRANCH`,
`PUBLIC_ANNOTATIONS`, and the GitHub App trio `GITHUB_APP_ID` /
`GITHUB_APP_PRIVATE_KEY` / `GITHUB_INSTALLATION_ID` (all three or none).

**One warning about `wrangler.jsonc`.** The checked-in
`apps/api/wrangler.jsonc` is *not* the live deployment's configuration. It
carries no `assets` binding and no auth variables, and `wrangler deploy`
replaces `vars` wholesale - deploying it at a live Worker would wipe the
static-site binding and the auth configuration. The file says so at the top.
Read it before you deploy from it.

---

## 9. Known gaps

Things an operator reasonably expects that **do not exist**. Each is a real
constraint on what you can do at 3am, not a to-do list.

1. **No audit-log API, CLI, or UI.** `audit_events` is SQL-only
   ([§3.2](#32-there-is-no-api-for-it)).
2. **No session revocation.** There is no logout endpoint, no per-actor
   revocation, and no session epoch. The `human_sessions.revoked_at` column
   exists and the repository method to set it exists, but nothing calls it.
   Your options are direct SQL or rotating `SESSION_SECRET`, which logs
   everybody out.
3. **No dual-secret window for any key.** Every rotation in [§5](#5-key-rotation)
   is a hard cutover.
4. **No operator endpoint to force a projection rebuild.** The coordinator's
   `refresh` action is reachable only from inside the Worker. Use a webhook
   redelivery ([§4.4](#44-partial-recovery-the-projection-is-wrong-but-the-database-is-fine)).
5. **No re-queue for a failed git operation.** Once an operation exhausts its
   retry budget and lands in `failed`, there is no supported command to retry
   it. The content is still in the database; getting it committed means
   re-issuing the request or hand-editing rows. Made sharper by the fact that
   the whole retry budget is spent inside one drain
   ([§2.2](#22-github-rate-limiting--403-with-retry-after)), so a GitHub
   outage that outlasts a single drain pass fails the operation permanently.
6. **A reconciliation does not release the lease it invalidates.** A work item
   can be `ready` and unclaimable at the same time
   ([§2.5](#25-a-submission-arrives-against-a-stale-projection)).
7. **No replay window on the GitHub push webhook.** Signature and delivery-id
   dedupe only; there is no timestamp check. (The publication callback *does*
   have a 5-minute skew window.)
8. **No per-chapter publication status.** `chapters.last_published_commit` is
   never written ([§6 step 3](#step-3--one-thing-not-to-trust)).
9. **No submission retention job.** Submission rows are documented as retained
   until completion plus 7 days, but no purge job exists. The table grows.
10. **No backup job for D1.** Cloudflare Time Travel is the whole story, and it
   is the only thing standing between you and permanent loss of the audit log.

---

## 10. Where the tests are

Each of these runs in CI and is the executable version of a section above. If
this document and one of these disagree, the test is right.

| File | Proves |
|---|---|
| `apps/api/test/recovery-restore-drill.test.ts` | [§4](#4-backup-and-restore) - destroys the database, rebuilds from Git, asserts what returns *and* what deliberately does not |
| `apps/api/test/resilience-failure-injection.test.ts` | [§2](#2-failure-modes-what-each-looks-like-from-outside) - backlog, rate limiting, outage, D1 errors, stale/diverged submissions |
| `apps/api/test/resilience-load-concurrency.test.ts` | Phase 4 invariants under sustained concurrent claims and submissions |

## 11. Why the test timeout is 30 seconds, not vitest's 5

Every package runs `vitest run --testTimeout=30000`.

The 5-second default is sized for unit tests. This repository also has
property tests that loop 120+ generated documents through parse → patch →
re-parse, exhaustive adversarial tables, and integration tests that spawn real
`git` against temporary repositories. Several of those sat just under 5s on a
developer machine and timed out on a slower CI runner - green where they were
written, red where the release is gated, which is the worst place to discover
a limit.

30s is deliberately generous rather than tuned. It is not a substitute for
noticing genuinely slow tests, and it still catches a hang: the outbox spin
bug (a deferred row re-picked by the same drain, forever) ran for over two
minutes before anything killed it, and would still fail this ceiling loudly.
