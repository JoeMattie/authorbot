# ADR 0011: Aggregate-only vote export by default

## Status

Accepted (2026-07-19)

## Context

Raw votes are rapidly mutable and belong in the operational database (design
§7.2); exporting them named to a public Git repository would publish
per-person voting behavior forever. Design §26.1 left open named,
pseudonymous, or aggregate-only export.

## Decision

- Default: **aggregate-only** vote export (design §26.1). When a proposal
  crosses a decision boundary, the committed decision record carries the rule,
  rule version, and aggregate metrics snapshot - privacy-safe voter
  information only (§7.3; decision shape per contract §4 has `metrics` as an
  object of numbers, no voter list).
- Raw votes never trigger commits or publication (§7.4).
- Projects may opt in to periodic full or pseudonymous vote-event export under
  `.authorbot/exports/` (§7.3, §8.1); that is a per-project configuration
  choice, not the default.

## Consequences

- Public history proves *that* and *why* a threshold was crossed without
  exposing who voted how.
- Full vote-level auditability requires either the operational backup or the
  opt-in export; Git alone cannot replay individual votes by default.
- Decision records stay small and deterministic to validate.
