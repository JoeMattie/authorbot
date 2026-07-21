<p align="center">
  <img src="https://raw.githubusercontent.com/JoeMattie/authorbot/main/assets/logo-600.png?v=2" alt="Authorbot" width="320">
</p>

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
change and deploy `_site/` to a Cloudflare Worker on pushes to `main`
(ADR-0020; see `templates/book-repo/README.md`).

## Site ↔ API pairing (collaboration islands)

Chapter pages can carry inline-annotation islands backed by the Phase 2 API
(`apps/api`). Pairing is opt-in at build time: pass `--api-url <url>` to
`authorbot build`, or set the durable form `publication.api_url` in `book.yml`
(the flag overrides). Without either, the output is **byte-identical to a
script-free build** — zero JavaScript, no collaboration chrome (ADR-0018;
Phase 2b contract §1).

**Same-origin, always (ADR-0019).** The site and the API are served from one
origin; cross-origin deployment is not supported. `--api-url` therefore takes
a **root-relative path only** — `/` when the API answers at the origin root,
or a base path like `/my-book` for a book published under a subpath (the
islands then call `/my-book/v1/...`, and the Worker runs with a matching
`API_BASE_PATH`). An absolute URL fails the build. No CORS header is ever
emitted, session cookies are always `SameSite=Lax`, and the CSRF origin check
stays — see `apps/api/README.md`.

A static-only host can therefore never serve a site with collaboration
features — the API has to answer on the same origin as the prose — which is
why Cloudflare is the single supported host (ADR-0020).

**Local dev.** Run the Node dev API (see `apps/api/README.md`), serve `_site/`
from the same origin (any reverse proxy that routes `/v1/*` to the API — the
Playwright e2e in `packages/publisher/test/e2e-ui/helpers.ts` does exactly
this in ~30 lines of `node:http`), and build with `--api-url /`:

```sh
# API (dev auth; point BOOK_REPO_PATH at a throwaway clone)
... pnpm --filter @authorbot/api dev:node   # :8788

# Site — served behind a proxy that forwards /v1/* to :8788
authorbot build examples/book-repo --out _site --api-url /
```

Signed-out readers get a "Sign in with GitHub" link (dev builds can surface
the dev-login form via the programmatic `buildSite({ devLogin: true })`
option — never emitted otherwise).

## Roadmap

| Phase | Scope | State |
|---|---|---|
| 0–4 | contracts, publisher, API, governance, leases & submissions | complete |
| 5 | GitHub App reader/writer, coordinator, publication tracking | in progress |
| 6 | onboarding wizard, "New chapter" authoring, browser settings | contracted |
| 7 | hardening: rate limits, restore drill, reviews, load testing | contracted |
| 8 | installable collaborator skill for agent fleets | contracted |
| 9 | author-facing docs and authorbot.joemattie.com | contracted |
| 10 | reading presentation settings (measure, typeface) | contracted |

## Status

Phases 0–2b complete (contracts, publisher, collaboration API, inline
annotation UI) — see §23 of the design document for the implementation
sequence and docs/phase*-contract.md for what each phase pinned.
