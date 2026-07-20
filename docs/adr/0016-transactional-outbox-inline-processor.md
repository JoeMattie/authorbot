# ADR 0016: Transactional outbox with inline processor for Phase 2 Git mirroring

## Status

Accepted (2026-07-19)

## Context

Annotations and replies are canonical in Git but accepted as API commands
(design §7.1, §7.3): the record must be durable the moment the API responds,
yet the Git commit is slow, can conflict, and must be serialized per project.
Design §20.1 prescribes a transactional outbox, and ADR 0008 assigns
per-project serialization to a Durable Object — but Phase 2 has no Durable
Object wiring, no GitHub App writes (Phase 5), and must remain fully testable
in Node (phase2-contract §1, §7.1). Writing to Git synchronously inside the
request would lose the record on commit failure; writing to Git "later" with
no transactional link would lose it silently.

## Decision

- **Outbox in the command transaction**: each mirroring mutation writes, in
  one `SqlDatabase` batch (ADR 0014), the domain record with status
  `pending_git`, its audit event, and an `outbox` row, then responds `202`
  with an `operationId` (phase2-contract §5; design §20.1, §15.4).
- **Processor** drains the outbox per project serially: renders the artifact
  files per Phase 0 contract §4 (`.authorbot/annotations/<id>/annotation.md`,
  `replies/<reply-id>.md`; withdraw edits frontmatter `status`), then commits
  via `BookRepoWriter.commitFiles` — one commit per logical mutation with
  design §14.3 trailers (`Authorbot-Actor`, `Authorbot-Annotation`,
  `Authorbot-Operation`).
- `git_operations` rows track design §20.2 states (`queued → preparing →
  committing → committed → verified`; failures → `conflict|failed`) with
  bounded retries (3). Records leave `pending_git` only after the commit
  succeeds (phase2-contract §5).
- **Inline invocation in Phase 2**: with `MIRROR_MODE=inline` (dev/tests)
  the processor runs in-process after each command, so the `202` semantics,
  state machine, and artifacts are real while the transport is trivial.
  `MIRROR_MODE=queue` records the outbox row only; wiring the processor to
  the per-project Durable Object alarm is deferred to Phase 5
  (phase2-contract §5; ADR 0008).
- Git writes go through the `BookRepoWriter` port: **LocalGitAdapter**
  (Node, spawns `git` against a work tree) now; the typed `GitHubAdapter`
  stub throws `not-implemented` until Phase 5 (phase2-contract §5;
  ADR 0007).

## Consequences

- No lost-update window: record, audit event, and outbox row are atomic, so
  a crash before the commit leaves a visible `pending_git` record the
  processor (or design §20.3 reconciliation) can resume, never a phantom.
- The Phase 5 change is confined to invocation and adapter: swap inline
  invocation for the Durable Object alarm and LocalGitAdapter for the
  GitHub App adapter; the outbox schema, state machine, artifact rendering,
  and trailers are already exercised by the Phase 2 exit test
  (phase2-contract §7.1).
- Inline mode makes the exit criterion provable in one Node process:
  `202` → operation `committed` → file in the work tree → projection rebuild
  from the repo (design §7.5).
- Clients must treat mirroring mutations as asynchronous (`202` +
  `GET /v1/projects/{projectId}/operations/{operationId}`) even in dev,
  where inline processing makes them effectively synchronous — the contract
  stays honest for Phase 5.
