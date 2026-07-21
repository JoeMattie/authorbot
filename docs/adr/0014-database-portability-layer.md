# ADR 0014: Database portability layer - `SqlDatabase` with D1 and better-sqlite3 adapters

## Status

Accepted (2026-07-19)

## Context

Production runs on Cloudflare D1 (ADR 0008; design §18.1), but the Phase 2
exit criteria demand fast Node-side integration tests and local development
without Wrangler (phase2-contract §7.1; design §18.3, §21.3). D1's binding
API is Workers-only, while ORMs would add a heavy dependency for what design
§9.2 defines as a small fixed table set. Migrations must also work under
`wrangler d1 migrations` in production and plain SQLite in tests.

## Decision

- Repositories in `packages/database` are written against a minimal
  `SqlDatabase` interface - prepared statements plus `batch` for
  transactional multi-statement writes - and nothing else
  (phase2-contract §2).
- Two adapters implement it: **D1** (production, Workers runtime) and
  **better-sqlite3** (tests and local Node). Both execute the identical
  schema; there is no per-adapter SQL dialect.
- `batch` is the only transaction primitive, chosen because it is the
  strongest guarantee D1 offers; repositories must express each command's
  writes (record + audit event + outbox row, phase2-contract §5) as one
  batch rather than relying on interactive transactions.
- Migrations are plain SQL files in `migrations/` with
  wrangler-d1-compatible numbering; no migration DSL, no ORM-generated
  schema (phase2-contract §2). The better-sqlite3 adapter applies the same
  files in order for tests.
- Schema constraints from phase2-contract §2 (unique membership, unique
  token hash, unique idempotency triple, unique webhook delivery id,
  append-only `audit_events`) live in the SQL schema, not in application
  code, so both adapters enforce them identically.

## Consequences

- The Phase 2 exit test (dev-login → suggestion → rebuild) runs entirely in
  Node with better-sqlite3 and a temp Git work tree - no Workers runtime in
  the inner loop (phase2-contract §7.1).
- Repository code is restricted to SQL both engines execute; features D1
  lacks (interactive transactions, savepoints) are off-limits even though
  better-sqlite3 has them, so tests cannot pass on capabilities production
  lacks.
- Adding a third backend later (e.g. Postgres) means writing one adapter
  and auditing the SQL, not rewriting repositories.
- One schema, two engines: a CI job must run migrations under both adapters
  to catch dialect drift early.
