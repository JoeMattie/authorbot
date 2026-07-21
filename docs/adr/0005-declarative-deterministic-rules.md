# ADR 0005: Deterministic declarative rules, no user-supplied code

## Status

Accepted (2026-07-19)

## Context

Vote-to-work-item governance must be auditable, replayable, and safe to load
from an untrusted book repository. Executing JavaScript, templates, or
arbitrary expressions from repository data would be a code-execution vector
and would break the deterministic core principle (design §3.3, §11.1).

## Decision

- Rules are declarative data only (design §11.1): a `trigger`, an `all`/`any`
  condition tree of `{ metric, operator, value }` clauses, and a typed
  `action` - never evaluated code.
- The metric vocabulary is a small closed set (approvals, rejections,
  net/weighted score, distinct voters, human/agent approvals, role/trust-group
  approvals, proposal age, maintainer override).
- Rules carry a `version`; decision records store `rule` and `rule_version`
  plus the metric snapshot (contract §4).
- Evaluation is idempotent: a unique constraint on
  `(source_annotation_id, action_type, rule_version)` yields at most one
  decision and one generated work item per accepted suggestion (§11.4);
  threshold crossings are sticky (§11.3).

## Consequences

- Rule evaluation is pure and testable; replaying vote history reproduces the
  same decisions.
- No plugin/rule-scripting extensibility; new governance needs come through
  new metrics or operators added in the engine, versioned deliberately.
- A fleet of fresh API tokens cannot manufacture consensus when defaults
  require human approvals and registered collaborators (§11.2).
