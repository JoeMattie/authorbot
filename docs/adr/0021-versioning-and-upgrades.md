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
  1. TOOLCHAIN - our code            pinned ref in the book repo
  2. OPERATIONAL DB - D1 schema      migrations, applied to their database
  3. BOOK FORMAT - their files       schema versions inside their prose
```

Layer 1 is solved: `AUTHORBOT_REF` names what to build. Layer 2 was **not
automated** - nothing applied D1 migrations, so bumping the pin could deploy
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
  1. resolve current pin → target release; hand off to that exact CLI release
     before changing anything, then show what changed
  2. run the target's book-repo migrations against a working copy
  3. validate BEFORE and AFTER; abort on any new error
  4. open a PULL REQUEST - never push to main
  5. apply pending D1 migrations
  6. redeploy, and verify health before declaring success
```

The pull request is the point: the author sees exactly what changed in their
prose and configuration before accepting it, and `git revert` is the undo
button. Book-repo migrations are committed separately from content so they
can be reverted independently.

`--dry-run` runs every pre-branch gate in throwaway copies, including
validation, migration idempotency, npm relocking, and exact lock verification,
then prints the plan and changes nothing. `--check` reports whether a version
upgrade or interrupted-state repair is required and whether it would require a
format migration, for use in a scheduled job.

The handoff in step 1 is a safety boundary, not an optimization. Plain
`npx authorbot` prefers the local executable, and `node_modules` can lag behind
the exact pin in `package.json` after an interrupted or script-blocked install.
That stale executable does not know migrations or package-alignment rules
which shipped later. The helper therefore selects the exact release which must
own the operation, uses an exact matching book-local install when one exists,
or acquires that release with npm in a throwaway directory. The book is not an
installation target.

A bootstrap child carries the exact version its parent requested. If npm or
PATH starts anything else, or a second handoff would be needed, the command
fails before repository mutation instead of recursing. This also makes the
offline behavior explicit: an exact local install works without downloading;
a populated npm cache may satisfy acquisition; and an unavailable release
stops the operation with the repository unchanged.

That unchanged guarantee ends when the target helper starts. A signal or
process failure after that point reports that repository work may have begun
and tells the author to inspect `git status`. Failure to remove the temporary
package after the child exits is only a warning: it must not replace a
successful child exit status or misreport the child's upgrade result.

The nested npm call preserves the author's intentional offline, cache,
registry, userconfig, and authentication settings. It removes only npm
configuration known to be invalid when inherited from the outer `npx`
process, currently `allow_scripts`.

On Windows, npm and npx are command scripts which cannot be launched by
`execFile` without a shell. The helper does not enable one. It validates npm's
absolute JavaScript launcher path, or an existing launcher in npm's standard
location beside `node.exe`, and runs that file with `process.execPath` while
preserving argv as an array. Environment-provided Node executable paths are
never trusted.

An interrupted run may leave `package.json` on the target release while its
API pin or lockfile is still older. Equal manifest and target versions are
therefore not automatically a no-op. The target helper repairs that state
through the same clean-tree, validation, migration, verified-relock, and pull
request path as a forward upgrade. The only evidence allowed to lower the
book-format migration baseline is an internally coherent committed CLI lock
tuple: a parseable root `@authorbot/cli` spec and an exact resolved version
which satisfies it and is not newer than the target. API pins, the running
helper, and `node_modules` are alignment inputs, not format evidence. Missing,
malformed, contradictory, or newer lock evidence blocks unchanged rather than
guessing which migrations already ran.

For a mutating run, the helper records both the current branch and exact HEAD
before reading repository state, then rechecks HEAD, branch, and cleanliness
immediately before creating its branch. This catches same-branch commits as
well as ordinary uncommitted edits made while migration or relocking was in
progress. Branch creation names that recorded HEAD as its explicit start point,
so even a commit in the final gap cannot become the pull request's unnoticed
base.

No release can change an executable which was already published before this
bootstrap existed. A book whose installed helper predates this behavior needs
one explicit launch of a new package:

```
npx --yes @authorbot/cli@<target> upgrade --to <target>
```

After that pull request is merged and installed, ordinary
`npx authorbot upgrade` owns every later handoff automatically.

### 4. CI applies database migrations

The publish workflow gains a `wrangler d1 migrations apply` step, ordered
**before** the Worker deploy. Migrations must follow expand/contract: the
currently-deployed Worker keeps serving during a deploy, so a migration must
be compatible with the code already running. Destructive changes (dropping a
column, tightening a constraint) require two releases - expand in one,
contract in the next.

### 5. Rollback

Rolling back the toolchain is setting the pin to the previous tag and
redeploying. Rolling back a *format* migration is reverting its commit. These
are different operations and the documentation must say so, because an author
who reverts the pin without reverting a format migration has a new toolchain
expectation with old files - the exact state validation is meant to catch, so
`upgrade` re-validates on rollback too.

### 6. The build-time dependency, stated plainly

An author's CI depends on our published packages at build time (ADR-0022
replaced the git checkout this originally described). If they became
unavailable, the next build fails - while the deployed site and API keep
serving untouched. Mitigation is ordinary npm tooling: `npm pack` a tarball
into the repository, a populated offline cache, or a registry mirror. This
remains the only dependency an author has on us, and it must never grow into
a runtime one.

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
upgrade failure is a book that stops gaining features - never one that stops
being readable.
