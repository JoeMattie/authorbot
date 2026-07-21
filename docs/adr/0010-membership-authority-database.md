# ADR 0010: Membership authority in the database, public-safe manifest in Git

## Status

Accepted (2026-07-19)

## Context

Design §26.1 left open whether project membership lives in the database, in
Git, or both. Membership changes must take effect immediately (revocation
especially), interact with sessions and token scopes (§7.2, §19), and may
involve information that does not belong in a public repository.

## Decision

- The operational database is the single authority for project membership,
  roles, and grants (design §26.1); authorization checks read only the
  database.
- A **public-safe collaborator manifest** is exported to Git under
  `.authorbot/` for transparency and attribution display - derived data,
  never read back as authority.
- Secrets, tokens, installation IDs, and private identity details never enter
  the repository (§8.2, §19).

## Consequences

- Revoking a member or agent token is immediate - no Git round-trip and no
  window where a committed file re-grants access.
- The manifest can lag membership briefly (it flows through the outbox like
  other mirrored records, §7.3); consumers must treat it as informational.
- Rebuilding the projection from Git (§7.5) does not restore membership; the
  operational backup covers it, and this is an accepted cost of keeping
  authority out of the public repository.
