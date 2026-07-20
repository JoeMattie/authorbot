# ADR-0021: Versioning and the author upgrade path

**Status:** Accepted (2026-07-20).

## Context

Authorbot ships **source code and nothing else**. Every author brings their
own GitHub repository, Cloudflare account, Worker, D1 database, GitHub App,
and secrets. Their CI checks out this repository at a pinned ref, builds it in
their runner, and deploys to their infrastructure. We operate no service on
their behalf, hold none of their data, and receive no telemetry. (The
`authorbot.dev` strings in error payloads are RFC 7807 problem *type*
identifiers, not endpoints, and are never dereferenced.)

Two consequences follow, and they pull in opposite directions:

- **We cannot break a running deployment.** There is no switch we hold. A book
  deployed today keeps working if this project is abandoned.
- **We cannot fix one either.** Every upgrade is an action the author takes,
  on their schedule, against infrastructure only they can reach. An upgrade
  that requires manual steps is an upgrade most authors will not perform.

So the upgrade path is a product feature, not an operational procedure.

## Three layers drift independently

```
  1. TOOLCHAIN — our code            pinned ref in the book repo
  2. OPERATIONAL DB — D1 schema      migrations, applied to their database
  3. BOOK FORMAT — their files       schema versions inside their prose
```

Layer 1 is solved: `AUTHORBOT_REF` names what to build. Layer 2 was **not
automated** — nothing applied D1 migrations, so bumping the pin could deploy
a Worker expecting columns the database lacked. Layer 3 was unaddressed:
nothing rewrites an author's chapter files when an artifact schema changes.

## Decision

### 1. Releases, not commit SHAs

Tagged semver releases (`v1.5.0`) with notes. `AUTHORBOT_REF` should name a
tag. A `v1` channel tracking the latest compatible release is offered for
authors who prefer automatic patch and minor updates; pinning an exact tag
remains the default and the recommendation for a book that matters.

### 2. Compatibility promises

- **A book valid under `v1.x` stays valid under `v1.y`.** Validation may add
  warnings within a major, never new errors on previously-valid content.
- **Artifact schema changes ship additively.** A new `authorbot.chapter/v2`
  is accepted *alongside* `v1`; the validator reads both through the
  transition. No flag days.
- **Every format change ships with an automated migration.** If we cannot
  write the migration, we do not make the change. This is a constraint on us,
  deliberately.
- Breaking changes happen only at a major, with a migration and a documented
  window in which both versions are read.

### 3. `authorbot upgrade`

One command, and it must be safe to run on a book that matters:

```
  1. resolve current pin → target release; show what changed
  2. run the target's book-repo migrations against a working copy
  3. validate BEFORE and AFTER; abort on any new error
  4. open a PULL REQUEST — never push to main
  5. apply pending D1 migrations
  6. redeploy, and verify health before declaring success
```

The pull request is the point: the author sees exactly what changed in their
prose and configuration before accepting it, and `git revert` is the undo
button. Book-repo migrations are committed separately from content so they
can be reverted independently.

`--dry-run` prints the plan and changes nothing. `--check` reports whether an
upgrade is available and whether it would require a format migration, for use
in a scheduled job.

### 4. CI applies database migrations

The publish workflow gains a `wrangler d1 migrations apply` step, ordered
**before** the Worker deploy. Migrations must follow expand/contract: the
currently-deployed Worker keeps serving during a deploy, so a migration must
be compatible with the code already running. Destructive changes (dropping a
column, tightening a constraint) require two releases — expand in one,
contract in the next.

### 5. Rollback

Rolling back the toolchain is setting the pin to the previous tag and
redeploying. Rolling back a *format* migration is reverting its commit. These
are different operations and the documentation must say so, because an author
who reverts the pin without reverting a format migration has a new toolchain
expectation with old files — the exact state validation is meant to catch, so
`upgrade` re-validates on rollback too.

### 6. The build-time dependency, stated plainly

An author's CI clones this repository at build time. If it disappeared, their
next build fails — while their deployed site and API keep serving untouched.
Documented mitigations: fork the repository, or vendor a release archive.
This is the only dependency an author has on us, and it should never grow
into a runtime one.

## Consequences

**Good.** Upgrading is one command producing a reviewable pull request.
Authors on `v1` get fixes without thinking about it; authors who pin get
determinism. The compatibility promises constrain us in a way that keeps
old books working by construction rather than goodwill.

**Cost.** Additive-only schema evolution accumulates compatibility code, and
migrations are real work we cannot skip. Two-release expand/contract cycles
slow down destructive database changes. Both are the price of not breaking
books.

**Unchanged.** The safety net stays what it always was: the book is Markdown
and YAML in a repository the author owns. The worst realistic outcome of any
upgrade failure is a book that stops gaining features — never one that stops
being readable.
