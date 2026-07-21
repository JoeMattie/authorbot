# ADR-0020: GitHub for the repository, Cloudflare for hosting - nothing else

**Status:** Accepted (2026-07-20). Extends ADR-0019.

## Context

ADR-0019 made the API same-origin with the site. A static-only host therefore
cannot serve a collaborative book - it can serve the prose, but never the
annotations, votes, or work queue.

We nevertheless still carried a GitHub Pages path: template workflows with
Pages deploy steps, a `--base-url` project-path dance, Pages-specific
documentation, and a second published URL. The production book currently
deploys to *both* Pages and Cloudflare, which means two live URLs where one
silently lacks every collaboration feature - precisely the shape that
generates confused bug reports.

Supporting a host we cannot recommend is worse than supporting one host well.

## Decision

**The supported deployment is: GitHub for the book repository, Cloudflare
Workers for hosting the site and the API. There is no second supported host.**

1. GitHub Pages support is **removed** - deploy steps, Pages-specific base-URL
   handling, and its documentation. The template ships one publish workflow
   that builds and deploys to Cloudflare.
2. The `--base-url` build flag survives, because it is how a book is served
   under a base path (ADR-0019 §6). Its Pages-project-path role is gone.
3. The production book's Pages deployment is retired; `causal-projector` will
   have exactly one canonical URL.
4. **Other hosts are explicitly deferred, not forbidden.** The publisher
   emits ordinary static files and the API is a standard Worker-shaped fetch
   handler, so another host is a porting exercise, not a redesign. We are
   choosing not to spend time on it now. Nothing in this decision should be
   implemented in a way that makes a future host harder - no Cloudflare
   assumptions leaking into the publisher or the domain packages.

## Consequences

**Good.** One deployment path to document, script, test, and support. The
wizard (Phase 6) loses a branch and a question. The template stops shipping a
workflow that produces a semi-functional site. Users stop having to reason
about which of their two URLs is real.

**Cost.** A user who wants free static hosting on Pages and nothing else is no
longer served by our tooling. They can still run `authorbot build` and deploy
the output anywhere they like - the output is plain HTML - but we do not
document, script, or test it. Cloudflare's free tier covers the hosting and
the API for a project of this size, so the practical cost is an account, not
money.

**Boundary to hold.** "Cloudflare only" is a support decision, not an
architectural one. If Worker-specific assumptions start appearing in
`packages/publisher`, `packages/domain`, or the schemas, that is a bug against
this ADR, not an expression of it. The API's Cloudflare coupling is confined
to `apps/api/src/worker.ts`, the coordinator Durable Object, and the D1
adapter - all of which already sit behind interfaces.
