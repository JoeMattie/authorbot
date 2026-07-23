# Follow-up work

The product work previously listed here is implemented or already in the
feature integration path. This document now tracks only the remaining release
sequence and durable repository hygiene. Unless a step is marked completed
below, it does not imply that its pull request, release, deployment, migration,
or branch cleanup has completed.

## Required release sequence

The capability migration must continue to follow the expand, backfill, and
retire order in the Phase 11 contract. Do not combine these steps.

1. **Expand reader deployed.** v0.1.34 shipped the additive columns and
   dual-read Worker through the normal Authorbot upgrade path. Its Worker,
   publisher, and editorial flows were verified healthy. Its deprecated
   legacy mint request still writes a null canonical projection, so this alone
   does not open the one-shot backfill gate.
2. **Deploy the dual-write gate.** v0.1.35 makes every legacy mint populate the
   exact safe canonical projection while leaving legacy mode authoritative. It
   also carries the upgrade-helper safety fixes, but no D1 migration. Deploy
   and verify this Worker before preparing the backfill release.
3. **Ship the capability backfill after the writer gate.** v0.1.36 can add
   `0013_phase11_capabilities_backfill.sql` only after v0.1.35 is live.
   Validate it against legacy, canonical, revoked, and expired token rows. It
   must remain idempotent, preserve legacy mode, and leave ordinary legacy
   scopes available to the deployed dual-reader.
4. **Wait on Phase 3C legacy retirement.** Do not retire the legacy read path or
   remove its storage during the releases above. Phase 3C starts only after
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
- After each release is merged, audit existing remote branches and remove only
  heads that are confirmed merged and inactive.
