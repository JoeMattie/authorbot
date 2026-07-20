# ADR-0019: The API is same-origin with the site, by design

**Status:** Accepted (2026-07-20). Supersedes the cross-origin provisions of
`docs/phase2b-contract.md` §3.

## Context

Phase 2b supported two deployment shapes: the recommended same-origin one
(site and API on one host) and a cross-origin one (site on GitHub Pages, API
elsewhere). Supporting both cost us, permanently:

- CORS configuration, preflight handling, and exact-origin allow-lists
  (`apps/api/src/cors.ts`, `origins.ts` — ~200 lines plus tests).
- A session cookie that switches between `SameSite=Lax` and
  `SameSite=None; Secure` depending on configuration.
- `return_to` validation that must consider a set of foreign origins.
- Two security postures to reason about, review, and keep correct forever —
  and the weaker one is the configurable one.

The production deployment is same-origin. Every deployment we would recommend
is same-origin. The cross-origin path existed for a case (collaboration on a
GitHub Pages site) that cannot work anyway: Pages serves static files and
cannot host the API, so that deployment's site and API were always going to be
two different things.

Nothing about a book requires a second domain. `example.com/my-book/` and its
API under the same prefix is a perfectly good arrangement.

## Decision

**Authorbot serves the collaboration API from the same origin as the published
site. Cross-origin deployment is not supported.**

Consequently:

1. `ALLOWED_ORIGINS`, CORS headers, and preflight handling are **removed**.
   No CORS header is ever emitted; a cross-origin browser request fails at
   the browser, which is the correct outcome.
2. The session cookie is always `HttpOnly; Secure; SameSite=Lax`. The
   `SameSite=None` path is removed.
3. CSRF protection **stays**: cookie-authenticated mutations still require an
   `Origin` (or `Referer`) matching the API's own origin. Same-origin is not
   the same as no CSRF risk.
4. `return_to` accepts only URLs within the API's own origin.
5. `publication.api_url` accepts only a **root-relative path** (`/`, or a base
   path such as `/my-book`). Absolute URLs are rejected at build time with an
   explanatory error.
6. **A base path is supported**, so a book can live under a subpath of a
   larger site: with `api_url: "/my-book"`, the islands call
   `/my-book/v1/...` and the Worker serves the API under that prefix. Getting
   this right is what makes the prescription tolerable — the constraint is
   "one origin", not "the root of a domain".

## Consequences

**Good.** One deployment shape to document, test, and secure. The weaker
security posture stops being reachable by configuration. A meaningful amount
of code and test surface disappears. Getting-started loses its most confusing
fork.

**Cost.** A site published to GitHub Pages can never have collaboration
features; it is a read-only mirror. This is honest rather than limiting —
that combination never worked. Deployments wanting collaboration need a host
that can serve both planes (Cloudflare Workers in our case).

**On the existing production deployment**: it is already same-origin on one
Cloudflare Worker, so no migration is required. Its GitHub Pages mirror
remains a static copy and should be presented as such, or retired to avoid
two URLs where one silently lacks features.

## Implementation

Landed as a Phase 6 prerequisite (after Phase 5): delete `cors.ts` and the
cross-origin half of `origins.ts`, simplify `sessions.ts`, drop
`ALLOWED_ORIGINS` from configuration and documentation, tighten the
publisher's `api_url` validation, and add base-path support end to end.
`docs/phase2b-contract.md` §3 is superseded by this record rather than
rewritten, so the history of the decision stays legible.
