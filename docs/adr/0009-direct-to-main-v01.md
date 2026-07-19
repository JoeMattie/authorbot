# ADR 0009: Direct-to-main commits in v0.1, pull-request mode later

## Status

Accepted (2026-07-19)

## Context

Design §26.1 left open direct-to-main versus pull-request mode per project.
PR mode adds review workflow, protected-branch handling, merge-state
tracking, and a second reconciliation surface — heavy for a v0.1 whose
mutations are already gated by validation, governance rules, and leases.

## Decision

- v0.1 commits directly to the default branch (design §14.4), with:
  - non-force ref updates only (ADR 0007),
  - strict pre-commit validation of every artifact touched,
  - governance gating: mutations originate from accepted work items
    (ADR 0005/0006), never ad-hoc writes.
- Pull-request mode is deferred to a later phase for projects requiring
  external review or protected-branch rules (§14.4, §26.1); the
  repo-coordinator interface should keep "produce commit" separate from
  "land commit" so PR mode slots in without redesign.

## Consequences

- Simple mental model: accepted work appears on `main` in one atomic commit.
- Projects with branch protection requiring PRs cannot use v0.1 as-is.
- External direct pushes remain possible and are handled by webhook
  reconciliation and divergence detection (§14.5), not prevented.
