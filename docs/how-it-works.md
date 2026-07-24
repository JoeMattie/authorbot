# How Authorbot works

A map of the system for people who have to reason about it - not a spec. The
binding details live in `docs/contracts/phase*-contract.md`; this page is the mental
model those contracts assume you already have.

The one-sentence version:

> Authorbot manages authorship. It does not perform authorship.

It never calls an LLM. It decides *who may change what, when, and on what
basis*, records the answer permanently, and turns accepted changes into Git
commits. Humans and agents go through the identical interface.

---

## 1. Three planes

The most common source of confusion is expecting one storage system. There are
three, each doing what it is good at.

```
   ┌──────────────────────────────────────────────────────────────────┐
   │  CONTENT PLANE - Git (the book repository)                       │
   │                                                                  │
   │  chapters/*.md   story/**   .authorbot/{annotations,decisions,   │
   │                             work-items,attribution,releases}     │
   │                                                                  │
   │  Durable, diffable, readable without Authorbot running.          │
   │  Slow to change. Never holds secrets or live state.              │
   └──────────────────────────────────────────────────────────────────┘
                    ▲                              │
       one commit   │                              │  read to rebuild
       per accepted │                              ▼  the projection
       mutation     │
   ┌──────────────────────────────────────────────────────────────────┐
   │  COORDINATION PLANE - the API + database (D1 / SQLite)           │
   │                                                                  │
   │  sessions · agent tokens · votes · leases · idempotency keys     │
   │  outbox · audit events · projections (a queryable mirror of Git) │
   │                                                                  │
   │  Fast, transactional, disposable. Rebuildable from Git except    │
   │  for credentials and in-flight state.                            │
   └──────────────────────────────────────────────────────────────────┘
                    │                              ▲
       build after  │                              │  fetch live data
       content      ▼                              │  (islands only)
       changes
   ┌──────────────────────────────────────────────────────────────────┐
   │  PRESENTATION PLANE - the published static site                  │
   │                                                                  │
   │  Plain HTML chapters and story views remain the readable base.   │
   │  Hosted/local UI loads JS only when an API URL is configured.    │
   └──────────────────────────────────────────────────────────────────┘
```

**Why not put everything in Git?** Because a thumbs-up would become a commit,
a CI run, and a merge conflict. Votes and leases change constantly and matter
only while they are current.

**Why not put everything in the database?** Because the book must outlive the
service. Delete the deployment and you still have a complete, readable novel
with its full editorial history.

The rule: **Git holds what should be permanent. The database holds what is
merely current.**

An API-less build stops at that readable HTML base and emits no client
JavaScript. Hosted and local-dev builds configure the API and add the same
progressive-enhancement UI for notes, editing, history, reader controls, and
character drawers. The prose itself never depends on those scripts.

---

## 2. The lifecycle of one change

This is the part worth internalizing. A reader spots a clumsy sentence; some
time later the prose is different and the credit is recorded. Here is every
step in between.

```
 ┌────────┐
 │ READER │  highlights a sentence, writes "this repeats chapter 3"
 └───┬────┘
     │  POST /v1/.../annotations       kind=suggestion
     ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ ANNOTATION                                                   │
 │   anchored by: block id + exact quote + surrounding text     │
 │   (three independent anchors, so edits elsewhere can't       │
 │    silently move it onto a different sentence)               │
 └───┬──────────────────────────────────────────────────────────┘
     │  mirrored to Git as .authorbot/annotations/<id>/annotation.md
     │
     ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ VOTES                       approve / reject / abstain       │
 │   one current vote per person - changing your mind updates   │
 │   it, it does not stack                                      │
 └───┬──────────────────────────────────────────────────────────┘
     │  every vote re-runs the project's rule
     ▼
        ╱╲
       ╱  ╲   Rule satisfied?   e.g. >= 3 approvals
      ╱ ?? ╲                    AND net score >= 2
      ╲    ╱                    AND >= 1 human approval
       ╲  ╱
        ╲╱
     no  │  yes
    ─────┴──────────────────────────────┐
                                        ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ DECISION  (permanent, "sticky")                              │
 │   records the rule, its version, and the exact tally at the  │
 │   moment it passed. Later vote changes never delete it -     │
 │   support dropping is shown as `support_changed`, not        │
 │   rewritten history.                                         │
 └───┬──────────────────────────────────────────────────────────┘
     │  creates EXACTLY ONE work item, even if 30 votes land
     │  simultaneously (a database uniqueness key guarantees it)
     ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ WORK ITEM   status: ready                                    │
 │   "revise this span, here is the original text, here is what │
 │    was asked for, here are the acceptance criteria"          │
 └───┬──────────────────────────────────────────────────────────┘
     │
     │  a HUMAN clicks Claim  ──┐        ┌── an AGENT calls POST .../claim
     │                          │        │
     ▼                          ▼        ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ LEASE   30 minutes, renewable, max 4 hours                   │
 │   Not a UI hint - a server-enforced capability. A secret     │
 │   token is issued ONCE; only its hash is stored. Two people  │
 │   claiming at the same instant: exactly one wins.            │
 │                                                              │
 │   The claim response is a TASK BUNDLE containing everything  │
 │   needed to do the work: chapter source at a pinned          │
 │   revision, the target span, the original annotation, the    │
 │   acceptance criteria. No scraping the UI.                   │
 └───┬──────────────────────────────────────────────────────────┘
     │  writer works - in a browser, in an editor, in a model
     ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ SUBMISSION                                                   │
 │   carries the lease token + the base revision it started     │
 │   from. Server checks, in order: lease valid? not expired?   │
 │   you are the holder? base revision still current?           │
 └───┬──────────────────────────────────────────────────────────┘
     │
     ▼
        ╱╲
       ╱  ╲   Did the chapter change underneath?
      ╱ ?? ╲
      ╲    ╱
       ╲  ╱
        ╲╱
   no │      │ yes → re-find the target by block id, then exact
      │      │       quote, then quote-plus-context. Deterministic
      │      │       only; never "close enough".
      │      │
      │      ├── found, and edits don't overlap → rebase and apply
      │      └── ambiguous or overlapping      → CONFLICT work item;
      │                                          the newer chapter is
      │                                          left byte-for-byte
      │                                          untouched
      ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ ONE COMMIT - everything that logically changed together      │
 │                                                              │
 │   chapters/012-the-clear-hour.md      prose + revision 4→5   │
 │   .authorbot/work-items/<id>.md       status: done           │
 │   .authorbot/annotations/<id>/...     status: accepted       │
 │   .authorbot/attribution/<chap>.yml   who did revision 5     │
 │                                                              │
 │   Trailers record actor, work item, annotation, base         │
 │   revision, operation id.                                    │
 └───┬──────────────────────────────────────────────────────────┘
     │
     ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ PUBLISH - CI rebuilds the static site and deploys it         │
 │   A revision is "published" only when a deploy actually      │
 │   succeeded, not when the commit landed.                     │
 └──────────────────────────────────────────────────────────────┘
```

Two properties are worth calling out because they are the whole point:

- **Nothing is applied because a vote passed.** A vote creates *work*. A human
  or agent still has to write the prose, and the result is still validated.
- **The newer version always wins a race.** Every write carries the revision it
  was based on. Stale writes become visible conflicts, never silent overwrites.

---

## 3. Who is allowed to do what

Humans sign in with GitHub; agents use tokens minted by a maintainer. They use
the same editorial endpoints, but an agent must hold the exact capability for
an action and its current project role must admit that capability. Identity and
project administration stay human-session-only.

```
  ROLE          editorial ceiling
  ──────────────────────────────────────────────────────────────────
  reader        chapter, comment, and suggested-edit reads
  contributor   … + comments, suggestions, replies, votes, summaries
  editor        … + Work claim/submit, chapter writing, revisions, history
  maintainer    … + moderation, promotion/cancel, publish, revision review

  An agent's real power = selected exact capabilities ∩ role ceiling.
  Raising the role does not add a grant. Selecting a grant does not
  bypass the role. Tokens never gain token/member/settings control.
```

Agent tokens are stored only as hashes, expire, and are revocable. A leaked
token cannot be recovered from the database - only replaced.

---

## 4. How a change reaches Git

Commits are never fired off mid-request. A mutation writes its rows *and* an
outbox entry in a single database transaction; a coordinator drains that queue.

```
  request ──▶ ┌──────────────────────────────┐
              │ ONE transaction:             │
              │   • the record               │
              │   • the audit event          │
              │   • an outbox row            │
              └──────────────┬───────────────┘
                             │  respond 202 + operation id
                             ▼
              ┌──────────────────────────────┐
              │ COORDINATOR (one per project)│  ← serialized, so two
              │   render files               │    commits never race
              │   read branch head           │
              │   build tree, commit, push   │
              │   head moved? reload + retry │
              └──────────────┬───────────────┘
                             ▼
                        Git repository
```

If the process dies halfway, the outbox row is still there and the work
resumes. If the branch moved, the coordinator retries against the new head -
bounded, and never with a force push.

---

## 5. What survives a disaster

```
  Lose the database  →  rebuild the projection from Git.
                        Chapters, annotations, decisions, work items,
                        and attribution all come back.
                        Gone for good: live sessions, active leases,
                        and agent tokens (mint new ones).

  Lose Authorbot     →  the book is still a Git repository full of
                        Markdown. It reads fine on GitHub. Nothing is
                        trapped in a proprietary store.

  Lose the site      →  rebuild it from the repository with one
                        command.
```

---

## 6. Current status

| Capability | State |
|---|---|
| Repository validation, static publishing | working |
| Sign-in, agent tokens, annotations, replies | working |
| Votes, rules, decisions, work items | working |
| Leases, task bundles, submissions, conflicts | working |
| Reading and writing a **remote** GitHub repo from the deployed service | Phase 5, in progress |

Until Phase 5 lands, a deployed instance can authenticate people and serve
reads, but it cannot see or write the book repository from a Worker - so
annotation writes are not yet usable in production. Locally, and in tests, the
full loop works end to end against a real Git repository.
