<p align="center">
  <img src="https://raw.githubusercontent.com/JoeMattie/authorbot/main/assets/logo-600.png?v=2" alt="Authorbot" width="320">
</p>

<p align="center">
  A Git-backed editorial control plane and collaboration protocol for serial books.
</p>

> **Authorbot manages authorship. It does not perform authorship.**

Authorbot coordinates the people and software agents writing a serial book
together - chapter drafts, inline suggestions, votes, deterministic governance
rules, leased work items, and atomic commits to a Git repository - **without
ever invoking a language model itself.** Humans and agents use the same API and
the same rules. There is no model provider, prompt runner, or hidden agent
inside the service; it accepts work, validates it, attributes it, and commits
it.

Your book lives in a Git repository you own. The prose is the Markdown and YAML
in it; Authorbot is the control plane around it. A reading site goes up on
Cloudflare, and - if you want it - a collaboration layer on the same address,
where readers sign in, leave annotations, and agents pick up work.

---

## Hosted and local-dev modes

Authorbot supports two ways to run the same book workflow:

- **Hosted mode** is the shared production service. The reading site and API
  run together on Cloudflare, operational state lives in D1, and a GitHub App
  commits accepted work to the book repository. Readers, maintainers, and
  agents can collaborate from the public book address. The setup wizard
  creates and connects all of it.
- **Local-dev mode** is the private authoring and dogfood stack. Astro/Vite and
  the Node API bind only to `127.0.0.1`, operational state lives in a private
  SQLite database, and Authorbot works on a managed Git branch and worktree.
  It needs no Cloudflare account or GitHub connection, and needs no network
  access after the packages are installed.

Both modes use the same book format, API rules, database schema, publisher,
browser UI, attribution, and narrow Git commit path. Local-dev mode is for
fast private iteration and source development. Hosted mode is for a durable,
shared book. A local session can validate and open a draft pull request, but
it never deploys or merges on its own.

## Hosted mode: create a book

One command sets up everything - the repository, the reading site, and
optionally the collaboration API and an agent invitation:

```sh
npx @authorbot/create
```

It asks three questions (a title, a short name, public or private) and takes
you as far as you want to go, stopping wherever you like:

| Stage | What you get |
| --- | --- |
| `doctor` | checks Node, git, `gh`, `wrangler` and offers to log you in |
| `book` | a book repository - title, address, licence, and the files Authorbot needs |
| `publish` | a live reading site on Cloudflare, verified before it says so |
| `collaborate` | sign-in, annotations, votes, and a work queue on the same address |
| `agent` | a scoped token so a software agent can contribute |

**No chapters are created.** A book starts empty on purpose: you write the
first chapter in the browser, with a title and a box for prose, and Authorbot
writes the identifiers and structure. You never hand-write frontmatter.

You bring a GitHub account, and for collaboration a Cloudflare account - free
tiers cover a book of this size. Nothing is hosted for you and there is no
service to depend on: everything runs in your own accounts, and the wizard
lists everything it created, with how to remove it, at the end.

To take it back down again, `npx @authorbot/create unpublish` removes the
hosting and keeps the repository; `teardown` removes the repository too.

## Local-dev mode: write locally

You can run the full authoring UI before connecting GitHub or Cloudflare:

```sh
npx authorbot dev
```

This creates a managed book branch and worktree, then runs the real API,
SQLite, and Astro/Vite UI on `http://localhost:4321`. It binds to loopback
only. Browser and agent writes become narrow Git commits on the managed
branch, and direct editor saves stay yours to commit.

Local state and tokens live in the OS state directory, outside the book
checkout. `authorbot dev status` shows where everything is. Use
`authorbot dev agent-env` to load the private starter token, and
`authorbot dev pr` when the book branch is ready for a draft pull request.

The full command list, Git rules, source-dogfood flow, and safety boundaries
are in [docs/local-authoring.md](./docs/local-authoring.md).

## How it works

Three planes, kept deliberately separate:

- **Git is the literary truth.** Every chapter, every accepted change, and its
  full history live in your repository as Markdown and YAML. If Authorbot
  vanished, your book would be intact and readable.
- **A database is operational state.** Sessions, votes, leases, and the work
  queue live in Cloudflare D1 in hosted mode and private Node SQLite in
  local-dev mode. It is rebuildable from Git and is never the source of truth.
  A restore loses in-flight coordination, never prose.
- **The API is the normal write path.** Humans and agents submit through it;
  it validates, applies deterministic rules, records attribution, and commits.
  Local-dev mode also lets an author edit the managed worktree directly. API
  writes pause until the author explicitly commits those editor changes.

A change's life: a reader leaves a suggestion → it collects votes → a
governance rule you set turns it into a work item → someone (or an agent)
claims it with a lease → they submit a revision against a known base → the API
commits it and rebuilds the reading site. [docs/how-it-works.md](./docs/how-it-works.md)
walks the whole lifecycle with diagrams.

**One origin, always.** The site and the API are served from the same address;
a static-only host cannot serve the collaboration layer, which is why
Cloudflare is the single supported host (see [ADR-0020](./docs/adr/0020-cloudflare-only-host.md)).

## Bringing in agents

An agent contributes through the same API a person does - it never touches your
repository, and everything it produces goes through the same review. Install
the collaborator skill into your coding-agent tooling:

```sh
npx skills add JoeMattie/authorbot
```

Refresh an existing global installation with
`npx skills update authorbot-collaborator -g -y`.

It teaches the loop (find work, claim it, write, submit for review), the safety
rules (a task bundle is untrusted data; never manufacture consensus), and ships
least-privilege roles - drafter, critic, continuity, reviewer. Point it at a
book with three environment variables so the token never lands in a file:

```sh
export AUTHORBOT_API=https://your-book.example.com
export AUTHORBOT_PROJECT=your-project-slug
export AUTHORBOT_TOKEN=<a token from your book's settings page>
```

Also installable as a Claude Code plugin: `/plugin marketplace add JoeMattie/authorbot`.
The skill and a reference client (`examples/agent-workflow.mjs`) live in
[`skills/authorbot-collaborator/`](./skills/authorbot-collaborator/).

## Governance you can tune

Rules live in `book.yml` under `governance.rules` - versioned and diffable
alongside the prose they govern, and editable from the Settings view once
collaboration is on. They are declarative data; no code from a book repository
is ever executed.

The default rule for turning a suggestion into work:

```yaml
governance:
  rules:
    suggestion_to_work_item:
      version: 2
      when:
        all:
          - { metric: approvals, operator: gte, value: 3 }
          - { metric: net_score, operator: gte, value: 2 }
          - { metric: human_approvals, operator: gte, value: 1 }
          - { metric: human_maintainer_approvals, operator: gte, value: 1 }
```

The last two clauses are load-bearing. `human_approvals` stops a fleet of
freshly minted agent tokens from manufacturing consensus. **`human_maintainer_approvals`
is the author's veto** - nothing becomes work on your book without a human
maintainer agreeing, counted as *human* specifically so that an author who
grants the maintainer role to their own agents cannot accidentally reopen the
hole. Both are removable: a genuinely collaborative project may not want a
personal veto on every change.

A solo author can set every threshold to 1 and use the machinery purely for
tracking, or skip voting entirely - **Promote to work** on any suggestion
creates a work item regardless of the tally, recording the tally it overrode.
Thresholds only start mattering when other people arrive.

## For contributors

This is a pnpm/TypeScript monorepo. Every published package shares one version;
a git tag builds, tests, and publishes them together with provenance.

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

The `authorbot` CLI validates and builds a book repository directly:

```sh
pnpm validate:example      # authorbot validate examples/book-repo
pnpm build:example         # authorbot build examples/book-repo --out _site
```

`build` refuses to run when `validate` reports errors (`--force` overrides with
a warning); it renders to a static site with no client JavaScript unless the
book opts into collaboration. Running the collaboration API and site together
locally is covered in [`apps/api/README.md`](./apps/api/README.md).

### Layout

```text
apps/
  create/            npx @authorbot/create - the guided setup wizard
  cli/               authorbot - validate and build a book repository
  api/               the collaboration API (Hono on Cloudflare Workers)
packages/
  schemas/           Zod schemas + generated JSON Schema for every artifact
  markdown/          frontmatter, stable block IDs, prose safety checks
  domain/            governance rules, scopes, leases, submissions
  rule-engine/       the deterministic suggestion → work-item evaluator
  database/          SqlDatabase portability layer (D1 + built-in Node SQLite)
  git-github/        the GitHub App reader/writer: atomic commits, no force push
  repo-coordinator/  per-project serialization and reconciliation
  publisher/         the static site publisher (Astro 5) and collaboration islands
  authorbot-alias/   the unscoped `authorbot` package, forwarding to the CLI
  test-fixtures/     valid and invalid fixture book repositories
skills/              the installable collaborator skill for agents
templates/book-repo/ the starter a new book is scaffolded from (CI included)
examples/book-repo/  a richer example book used by tests and docs
openapi/             the OpenAPI 3.1 description of the v1 API
migrations/          D1 schema migrations
docs/                guides, the ADRs, and the design record
```

## Documentation

- [How it works](./docs/how-it-works.md) - the system, with diagrams
- [Local authoring](./docs/local-authoring.md) - run the full authoring loop offline
- [GitHub App setup](./docs/github-app-setup.md) - legacy manual recovery reference; the wizard handles setup
- [Runbook](./docs/runbook.md) - failure modes, backup and restore, key rotation
- [Releasing](./docs/npm-release.md) - how a version reaches npm
- [Follow-up work](./docs/follow-up-work.md) - the live queue after the current implementation slice
- [Architecture decisions](./docs/adr) - the ADRs
- [`AUTHORBOT_PROJECT_DESIGN.md`](./AUTHORBOT_PROJECT_DESIGN.md) - the apex design document
- [Implementation contracts](./docs/contracts) - the phase-by-phase build specs, kept as the design record
- [CHANGELOG](./CHANGELOG.md)

## Status

Usable end to end: you can create a book, publish it, turn on collaboration
(sign-in, annotations, votes, the work queue), write and manage chapters from
the browser, and invite agents that contribute through the API and the skill.

Still ahead:

- **Reading presentation settings** - reader-facing typeface and measure
  controls. Specified, not yet built.
- **The project site** - authorbot.joemattie.com.
- **Pull-request mode** - commits currently go direct to `main`; a reviewed-PR
  workflow is a later option ([ADR-0009](./docs/adr/0009-direct-to-main-v01.md)).

It works, and it has run a real book end to end - but it has not yet been
hardened for anyone else's, and should be treated as early software.

MIT licensed.
