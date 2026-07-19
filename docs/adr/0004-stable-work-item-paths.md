# ADR 0004: Work items at stable paths with status frontmatter

## Status

Accepted (2026-07-19). Supersedes the status directories shown in design §8.1.

## Context

Design §8.1 sketches `.authorbot/work-items/{open,done,cancelled,conflicts}/`
directories, implying a file move on every status transition. Design §26.1
recommends stable paths plus status frontmatter instead, and contract §4
adopts that.

## Decision

- Every work item lives at `.authorbot/work-items/<id>.md` for its entire
  lifecycle (`<id>` is a lowercase UUIDv7, contract §2).
- Status is a frontmatter field:
  `ready|leased|submitted|applying|completed|conflict|failed|cancelled`
  (contract §4, aligned with the §9.5 state machine).
- The §8.1 status directories are superseded and must not be created by
  templates, fixtures, or tooling.

## Consequences

- Git history for a work item is one file's history; renames never break
  links, decision references, or attribution records.
- Status transitions are one-line frontmatter diffs inside the same atomic
  commit as the rest of a mutation (§14.2).
- Browsing by status in the raw repository requires tooling or search rather
  than `ls`; revisit only if repository browsing proves awkward (§26.1).
