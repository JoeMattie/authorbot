# Authorbot

A Git-backed editorial control plane and collaboration protocol for serial books.

> Authorbot manages authorship. It does not perform authorship.

Authorbot coordinates humans and external agents collaborating on a serial book:
chapter submissions, inline annotations, votes, deterministic governance rules,
leased work items, and atomic Git integration — without ever invoking an LLM
itself.

The full design is in [AUTHORBOT_PROJECT_DESIGN.md](./AUTHORBOT_PROJECT_DESIGN.md).
Architecture decisions live in [docs/adr](./docs/adr).

## Repository layout

```text
apps/
  cli/               # `authorbot` CLI (validate, ...)
packages/
  schemas/           # Zod schemas + generated JSON Schemas for all artifacts
  markdown/          # frontmatter, stable block IDs, safety checks
  test-fixtures/     # valid and invalid fixture book repositories
templates/
  book-repo/         # starter template for a new book repository
examples/
  book-repo/         # richer example book used by tests and docs
openapi/             # OpenAPI 3.1 skeleton for the v1 API
docs/adr/            # architecture decision records
```

## Getting started

```sh
pnpm install
pnpm build
pnpm test
pnpm validate:example   # runs `authorbot validate examples/book-repo`
```

## Status

Phase 0 (contracts and fixtures) — see §23 of the design document for the
implementation sequence.
