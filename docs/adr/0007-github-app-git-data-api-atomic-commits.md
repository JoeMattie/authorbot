# ADR 0007: GitHub App auth + Git Data API atomic multi-file commits, no force pushes

## Status

Accepted (2026-07-19)

## Context

One accepted literary mutation touches several files at once — chapter,
annotation state, decision, work-item state, attribution, release metadata
(design §14.2). A series of one-file Contents API calls would leave the
repository observably inconsistent mid-mutation. Long-lived personal access
tokens are over-privileged and hard to revoke (§14.1).

## Decision

- Authenticate as a GitHub App installed on the repository, requesting only
  contents, metadata, and webhook permissions; mint short-lived installation
  tokens per operation (design §14.1, §1.1).
- Apply each logical mutation with the Git Data API sequence (§14.2): read
  ref, create blobs, create tree, create commit with current parent, update
  the ref **with force disabled**; if the head moved, reload/revalidate/retry
  a bounded number of times, else surface an explicit conflict.
- Commits use a clear subject plus structured `Authorbot-*` trailers (actor,
  work item, annotation, base revision, operation) (§14.3). Git
  author/committer is the Authorbot service; attribution records preserve the
  real actor.

## Consequences

- Repository state is always a consistent snapshot of a mutation; readers and
  CI never see half-applied changes.
- No force pushes means external history is never destroyed; divergence is
  detected via webhooks and reconciliation (§14.5) rather than overwritten.
- GitHub.com only in v0.1 (§26.1); the adapter isolates this behind
  `@authorbot/git-github`.
