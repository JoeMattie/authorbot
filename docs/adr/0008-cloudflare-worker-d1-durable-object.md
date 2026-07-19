# ADR 0008: Cloudflare Worker + D1 + Durable Object per project

## Status

Accepted (2026-07-19)

## Context

A small serial-fiction project needs near-zero hosting cost, a serialized
writer per project for leases and Git commits, and a static-friendly public
site (design §18.1, §1.1). Design §26.1 left open one Worker versus separate
API and web Workers.

## Decision

- Cloudflare Worker for the API and collaborator UI, with Workers Static
  Assets for the shell (design §18.1); one Worker deployment where practical
  (§26.1).
- D1 (SQLite-compatible) for operational state and projections (ADR 0002).
- One Durable Object per project as the single-writer coordinator for
  serialized commands, lease compare-and-set, rule evaluation, and repository
  writes (§1.1, §18.1).
- GitHub Actions for validation and publication; GitHub App installation
  tokens for repository writes (ADR 0007). R2 only if attachments arrive.
- Local development uses Wrangler with local D1/SQLite, a local Git adapter,
  and fixture repositories (§18.3). Initial tenancy: one deployment per book
  project (§1.1).

## Consequences

- Expected to stay within free-tier limits; first paid step is the Workers
  paid plan, not a re-architecture (§18.1).
- Code must target the Workers runtime (no Node-only APIs in `apps/api` and
  its dependencies); domain packages stay runtime-neutral.
- The Durable Object gives per-project serialization without distributed
  locking; cross-project scale-out is by instance, not by shards.
