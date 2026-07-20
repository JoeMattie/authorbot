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
  cli/               # `authorbot` CLI (validate, build)
packages/
  schemas/           # Zod schemas + generated JSON Schemas for all artifacts
  markdown/          # frontmatter, stable block IDs, safety checks
  publisher/         # static site publisher (Astro 5, invoked programmatically)
  test-fixtures/     # valid and invalid fixture book repositories
templates/
  book-repo/         # starter template for a new book repository (CI included)
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
pnpm build:example      # runs `authorbot build examples/book-repo --out _site`
```

`pnpm build:example` renders the example book to `_site/` as a static reading
site — chapter index, chapter pages, story outline, timeline, and character
pages, plus an `authorbot-build.json` build manifest — with no client
JavaScript. Open `_site/index.html` in a browser to read it.

### Building a book

```sh
authorbot build <repo> [--out <dir>] [--base-url <url>] [--include-drafts] [--force]
```

The build refuses to run when `authorbot validate` reports errors (warnings
are allowed); `--force` overrides with a prominent warning. Chapters with
`status: published` are included by default; `--include-drafts` adds
draft/proposed chapters with a visible draft banner. The template book
repository ships GitHub Actions workflows that validate on every content
change and publish `_site/` to GitHub Pages on pushes to `main`
(see `templates/book-repo/README.md`).

## Status

Phase 1 (read-only publisher) — see §23 of the design document for the
implementation sequence.
