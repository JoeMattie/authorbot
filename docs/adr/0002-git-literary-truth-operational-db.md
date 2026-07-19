# ADR 0002: Git as literary source of truth, operational database for the rest

## Status

Accepted (2026-07-19)

## Context

Git excels at prose, diffs, releases, attribution, and recovery; it is poor at
leases, sessions, idempotency, rapid vote mutation, and transactional queues
(design §3.2). A single store for both would either commit every thumbs-up or
lose the durable literary record.

## Decision

Split authority per design §7:

- **Canonical in Git** (§7.1): chapter Markdown and metadata, story graph and
  bible, public-safe config, annotation/reply bodies, decision records,
  work-item specs and final disposition, attribution, release manifests.
- **Canonical in the operational database** (§7.2): sessions, agent token
  hashes, active leases, raw votes, idempotency keys, query projections,
  pending Git operations/outbox, webhook dedup, publication status, rate
  limits.
- Mirroring (§7.3): annotations enter as commands, appear immediately as
  `pending_git`, and become durable once committed. Votes commit only as
  decision records at threshold crossings, not per click.
- The database projection must be rebuildable from the repository tree,
  `.authorbot/` records, and Git history (§7.5).

## Consequences

- A book repository remains legible without a running instance (§3.4).
- Two stores mean reconciliation logic (webhooks, outbox, §14.5/§20) is
  mandatory, not optional.
- No literary fact may exist only in the database; the projection is
  disposable, credentials/leases/votes need separate operational backup.
