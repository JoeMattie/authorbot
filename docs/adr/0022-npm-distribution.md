# ADR-0022: Distribute prebuilt packages on npm

**Status:** Accepted (2026-07-20). Refines ADR-0021 §1 and §6.

## Context

Today an author's CI clones this repository at a pinned ref, installs
**429 MB** of `node_modules`, and compiles a TypeScript monorepo - every time
they publish a chapter. That is the most fragile and slowest part of author
CI, and it makes them depend on our repository being reachable at build time.

Meanwhile the Worker bundles to a **single 1.5 MB file** with every dependency
inlined. The artifact an author actually needs is small; the process of
producing it is not.

Two problems were being conflated:

- **Availability** - what if this repository disappears?
- **Provenance and reproducibility** - is the build verifiable and pinned?

A release tarball downloaded from GitHub at build time solves neither: it has
the same availability profile as the repository (same account, same platform),
and a tag can be moved. Only an artifact committed into the author's own
repository survives our disappearance, and only a checksummed, immutable
version gives provenance.

## Decision

**Authors depend on versioned, prebuilt npm packages - not on a git checkout
of this repository.**

The scope is available (`@authorbot/*` and the bare `authorbot` name are both
unregistered as of this decision) and should be claimed.

### Published packages

| Package | Contents | Consumed by |
|---|---|---|
| `@authorbot/cli` | `authorbot` binary: `validate`, `build`, `upgrade` | author CI, local use |
| `@authorbot/api` | prebuilt Worker entry + Durable Object | `wrangler.jsonc` `main` |
| `@authorbot/create` | the Phase 6 wizard | `npx @authorbot/create` |

Each ships **prebuilt `dist/`** - consumers never compile our source.
Internal packages (`domain`, `schemas`, `markdown`, `publisher`,
`repo-coordinator`, `rule-engine`, `database`, `git-github`) are published as
dependencies but are not part of the public contract; only the three above
carry compatibility promises (ADR-0021 §2).

### The pin moves into the book repository

`AUTHORBOT_REF` - a GitHub *repository variable* - is replaced by a normal
dependency in the book repo's `package.json`, plus a lockfile.

This is a strict improvement, and the reason is not convenience:

- The pin becomes **versioned, diffable, and revertable with git**. A repo
  variable is invisible in history and cannot be rolled back with the content
  it was paired with.
- An `authorbot upgrade` pull request (ADR-0021 §3) now *shows the version
  bump* alongside any format migration, which is precisely the review the PR
  exists to enable.
- The lockfile carries **integrity hashes**, which is stronger provenance
  than a mutable git tag.

The cost is two small files in an otherwise prose-only repository. The safety
net is unaffected: the book is still Markdown and YAML that reads fine without
any tooling.

### Author CI becomes

```yaml
- uses: actions/setup-node@v4
- run: npm ci                       # pinned, checksummed, no build
- run: npx authorbot validate .
- run: npx authorbot build . --out _site
- uses: cloudflare/wrangler-action@v3
```

The "check out and build the Authorbot toolchain" steps are deleted.
`wrangler.jsonc` points `main` at `node_modules/@authorbot/api/dist/worker.js`.

### Status: trusted publishing is live (2026-07-21)

All eleven packages are configured with GitHub Actions as their trusted
publisher, and `v0.1.2` was published over OIDC - npm records the publisher as
`GitHub Actions <npm-oidc-no-reply@github.com>` rather than a user account,
which is the evidence rather than an assumption. The bootstrap token has been
deleted from the repository's secrets and revoked at npm, so there is no
standing publish credential anywhere.

The `NODE_AUTH_TOKEN` line stays in the workflow: it is empty and unread while
trusted publishing is configured, and it leaves a deliberate fallback for a
fork or a future maintainer who has not set it up.

### Release process

A semver tag triggers a workflow that builds once and publishes to npm with
**`--provenance`** (GitHub Actions OIDC attestation, tying each published
artifact to the commit and workflow that produced it).

### No bespoke vendoring channel

*(Revised the same day this ADR was accepted, narrowing its scope.)*

An earlier draft attached self-contained bundles to each GitHub release as a
supported vendoring path. That is dropped: **npm already provides vendoring**,
and better than we would.

- `npm pack @authorbot/cli@1.5.0` produces a tarball that can be committed and
  installed from a path.
- `npm ci --offline` works against a populated cache.
- A registry mirror or proxy covers an organisation that cannot reach npm.

None of that requires anything from us. Publishing a second, parallel
distribution channel would mean building, checksumming, documenting, and
testing artifacts that almost nobody uses - and an untested artifact that
silently rots is worse than none, because it looks supported.

The disappearance scenario is therefore answered by standard tooling rather
than a bespoke mechanism, and the reviewability of upgrade pull requests
(ADR-0021 §3) is preserved by default rather than by advice.

## Consequences

**Good.** Author CI loses a clone, a 429 MB install, and a compile; publishing
a chapter becomes seconds rather than minutes. Provenance improves (integrity
hashes and build attestation beat a git ref). The pin becomes part of the
book's history. Upgrades are `npm install @authorbot/cli@1.5.0` plus whatever
migration the release carries.

**Cost.** We take on release engineering: publishing on tag, keeping prebuilt
`dist/` outputs correct, and not breaking the three public packages' APIs
within a major. Authors gain a dependency on the npm registry - heavily
mirrored and cached, and already the least of the external dependencies in a
GitHub-plus-Cloudflare deployment.

**Migration.** The existing production book (`causal-projector`) moves from
`AUTHORBOT_REF` to a `package.json` dependency as part of Phase 6, and its
repository variable is removed once its workflows no longer read it.
