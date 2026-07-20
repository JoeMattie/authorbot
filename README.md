# Authorbot

A Git-backed editorial control plane and collaboration protocol for serial books.

> Authorbot manages authorship. It does not perform authorship.

Authorbot coordinates humans and external agents collaborating on a serial book:
chapter submissions, inline annotations, votes, deterministic governance rules,
leased work items, and atomic Git integration — without ever invoking an LLM
itself.

**New here?** [How it works](./docs/how-it-works.md) explains the system with
diagrams; [Getting started](./docs/getting-started.md) walks through launching
your own book project end to end.

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

## Site ↔ API pairing (collaboration islands)

Chapter pages can carry inline-annotation islands backed by the Phase 2 API
(`apps/api`). Pairing is opt-in at build time: pass `--api-url <url>` to
`authorbot build`, or set the durable form `publication.api_url` in `book.yml`
(the flag overrides). Without either, the output is **byte-identical to a
script-free build** — zero JavaScript, no collaboration chrome (ADR-0018;
Phase 2b contract §1).

**Production — same-origin recommended.** Serve the built site and the API
from one host and use a root-relative API base (e.g. `--api-url /api` when
the API is reverse-proxied under `/api`; the islands call
`<base>/v1/...`): no `ALLOWED_ORIGINS` configuration, no CORS surface,
`SameSite=Lax` session cookies. Cross-origin (e.g. site on GitHub Pages, API on a Worker) is
supported: build with the absolute API URL and set `ALLOWED_ORIGINS` on the
API to the site's exact origin — see `apps/api/README.md` for the CORS/CSRF
details.

**Local dev.** Run the Node dev API (see `apps/api/README.md`) with
`ALLOWED_ORIGINS` set to wherever you serve the site, build with
`--api-url`, and serve `_site/` statically:

```sh
# API (dev auth; point BOOK_REPO_PATH at a throwaway clone)
ALLOWED_ORIGINS=http://127.0.0.1:4321 ... pnpm --filter @authorbot/api dev:node   # :8788

# Site
authorbot build examples/book-repo --out _site --api-url http://127.0.0.1:8788
npx serve _site -l 4321
```

Signed-out readers get a "Sign in with GitHub" link (dev builds can surface
the dev-login form via the programmatic `buildSite({ devLogin: true })`
option — never emitted otherwise).

## Roadmap

| Phase | Scope | State |
|---|---|---|
| 0–4 | contracts, publisher, API, governance, leases & submissions | complete |
| 5 | GitHub App reader/writer, coordinator, publication tracking | in progress |
| 6 | guided onboarding wizard + "New chapter" authoring | contracted |
| 7 | hardening: rate limits, restore drill, reviews, load testing | contracted |
| 8 | installable collaborator skill for agent fleets | contracted |

## Status

Phases 0–2b complete (contracts, publisher, collaboration API, inline
annotation UI) — see §23 of the design document for the implementation
sequence and docs/phase*-contract.md for what each phase pinned.
