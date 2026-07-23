# Follow-up work

The product work previously listed here is implemented or already in the
feature integration path. This document now tracks only the remaining release
sequence and durable repository hygiene. It does not mean that any pull
request, release, deployment, migration, or branch cleanup has completed.

## Required release sequence

The capability migration must continue to follow the expand, backfill, and
retire order in the Phase 11 contract. Do not combine these steps.

1. **Ship the feature and expand release.** Finish integrating the in-flight
   editor deployment-state change, run the full validation suite, merge the
   reviewed feature pull request, and cut its release. This release must deploy
   the dual-read Worker before any capability backfill runs.
2. **Deploy that release to a book.** Upgrade at least one book through the
   normal Authorbot upgrade path and verify that the expand migration, Worker,
   publisher, and editorial flows are healthy. This deployment is a hard gate
   for the backfill release.
3. **Ship the capability backfill separately.** Rebase the prepared backfill
   work on the released feature line, keep the capability backfill as migration
   `0013`, validate it against legacy, canonical, revoked, and expired token
   rows, then merge and release it independently. The backfill must remain
   idempotent, preserve legacy mode, and leave ordinary legacy scopes available
   to the deployed dual-read Worker.
4. **Wait on Phase 3C legacy retirement.** Do not retire the legacy read path or
   remove its storage during either release above. Phase 3C starts only after
   the documented compatibility window, supported token rows have been
   converted, and the rollback conditions in the Phase 11 contract are met.
   Legacy shadow writes continue for the additional required release before a
   later contract migration can remove them.

## Repository hygiene

Ordinary merged pull-request branches do not need to remain indefinitely. Tags
preserve releases, Git preserves merged commits, and a deleted branch can be
recreated from its final commit when necessary.

- Keep `main`, active pull-request branches, and explicitly documented
  long-running integration branches.
- Enable GitHub's automatic deletion of same-repository head branches after a
  pull request merges.
- After each merge, verify the remote head was deleted, prune stale remote
  tracking refs, and remove the matching local branch and worktree only when
  they are clean and no active agent owns them.
- Never delete an unmerged branch, another agent's active branch, or a fork
  branch the repository does not own.
- After the feature release work is merged, audit existing remote branches and
  remove only heads that are confirmed merged and inactive.
