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
2. **Dual-write gate deployed.** v0.1.35 makes every legacy mint populate the
   exact safe canonical projection while leaving legacy mode authoritative. It
   carries the upgrade-helper safety fixes but no D1 migration. Its Worker is
   deployed and verified healthy, so the backfill gate is open.
3. **Ship the capability backfill after the writer gate.** v0.1.36 adds
   `0013_phase11_capabilities_backfill.sql` after v0.1.35 is live. Its tests
   cover every legacy scope combination plus canonical, revoked, expired,
   unknown, and malformed rows. It remains idempotent, preserves legacy mode,
   and leaves ordinary legacy scopes available to the deployed dual-reader.
   A persistent database guard projects safe old-Worker inserts and
   authority-field updates. A legacy write that would need scope sanitation is
   aborted so an old Worker cannot persist a misleading response or audit.
   Historical redacted mint replays are corrected during the backfill. Together
   those rules close the direct-skip and rollback race until Phase 3C retires
   legacy mode.
4. **Wait on Phase 3C legacy retirement.** Do not retire the legacy read path or
   remove its storage during the releases above. Phase 3C starts only after
   the documented compatibility window, supported token rows have been
   converted, and the rollback conditions in the Phase 11 contract are met.
   Legacy shadow writes continue for the additional required release before a
   later contract migration can remove them. That migration must drop
   `agent_tokens_phase11_legacy_insert`, then
   `agent_tokens_phase11_legacy_update`, then
   `_phase11_legacy_token_projection` before rebuilding or removing legacy
   columns. Do not remove this shield while rollback to an old writer remains
   supported.

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
