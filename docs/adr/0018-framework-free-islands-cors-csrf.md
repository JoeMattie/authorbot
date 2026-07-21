# ADR 0018: Framework-free collaboration islands, plain-text bodies, explicit CORS/CSRF model

## Status

Accepted (2026-07-19)

## Context

Phase 2b adds the inline annotation UI to published chapter pages
(`docs/contracts/phase2b-contract.md`; design §16.2, §22.1), backed by the Phase 2 API.
Constraints in tension:

- Design §16.1 and ADR-0013 make no-JavaScript readability a hard rule; the
  2b contract §1 tightens it to **byte-comparable output** when no API base
  is configured, with total shipped JS ≤ 35 KB gzipped and no runtime
  dependencies.
- Annotation and reply bodies are untrusted user content rendered in the
  reader's browser (contract §3; design §19.4 forbids raw-HTML injection).
- The site may be served cross-origin from the API (the GitHub Pages case)
  while authenticating with session cookies, which raises CORS, CSRF, and
  open-redirect questions (contract §3).

## Decision

### Framework-free custom elements (contract §1)

- The islands are **framework-free TypeScript custom elements** - a single
  `<authorbot-collab>` root element in `packages/publisher/site/src/islands/`
  - with zero runtime dependencies. No framework integration is added to the
  publisher; design §1.1's "small interactive islands" is satisfied with the
  platform's own component model.
- The islands are bundled by an **explicit Vite build step** (the toolchain
  Astro already uses) run only when collaboration is enabled, emitting
  stable-named assets `_astro/authorbot-collab.js` and
  `_astro/authorbot-collab.css`, referenced from chapter pages via inline
  `<script type="module">`/`<link>` tags. Astro's own script pipeline was
  rejected because it emits hashed chunks into `_astro/` even when no page
  references them, which would break the byte-comparability requirement for
  api-url-less builds. A regression test asserts a build without an API base
  produces zero `<script>` tags and differs from an enabled build only by the
  island insertions and the two assets.
- Enablement is `--api-url <url>` on `authorbot build` (durable form:
  `publication.api_url` in `book.yml`; the flag overrides). Only chapter
  pages hydrate; index/story/character pages are untouched. Shipped size is
  ~8 KB gzipped JS + ~2 KB CSS against the 35 KB budget.

### Plain-text bodies, CSP-compatible rendering (contract §3)

- Annotation and reply bodies are rendered as **plain text**: `textContent`
  assignment plus `white-space: pre-wrap` (escaped, newline-preserving). The
  bundle contains no `innerHTML` (asserted by test) and no client-side
  Markdown rendering; server-side sanitized rendering can be added later
  without reopening this surface.
- Dynamic card positioning is applied through the CSSOM only - no inline
  `style="…"` strings - so the page CSP needs no `'unsafe-inline'`. Enabled
  chapter pages emit the contract's CSP as a `<meta>` tag:
  `default-src 'self'; connect-src 'self' <api-origin>; img-src 'self'
  data:` (design §19.4); a root-relative API base is same-origin and covered
  by `'self'`.

### CORS/CSRF model in the API (contract §3)

- **CORS**: `ALLOWED_ORIGINS` is a comma-separated list of **exact
  http(s) origins** - no wildcards, paths, or credentials - validated at
  boot (invalid config fails startup). Listed origins get per-origin
  `Access-Control-Allow-Origin` with `Access-Control-Allow-Credentials:
  true`, preflight handling, and `X-Correlation-Id` exposure; unlisted
  origins and unconfigured deployments get no CORS headers at all.
- **CSRF**: cookie-authenticated mutations require an `Origin` header
  (`Referer` consulted only when `Origin` is absent) matching
  `ALLOWED_ORIGINS` or the API's own request origin; missing or foreign →
  403 problem `csrf-origin-mismatch`. The check is enforced
  unconditionally - the API's own origin is derived from the request URL, so
  same-origin deployments need no configuration. It runs after successful
  cookie authentication (anonymous requests stay 401) and never applies to
  bearer-token requests, which carry no ambient credential.
- **Cookies**: the session cookie is `SameSite=None; Secure` only when
  `ALLOWED_ORIGINS` is non-empty (cross-origin configured), `SameSite=Lax`
  otherwise. The OAuth state cookie stays `Lax` (top-level GET navigation).
- **`return_to`**: the OAuth start URL accepts `?return_to=<url>` for the
  islands' sign-in link, validated against the allow-list (exact-origin
  prefix match defeating `javascript:`, userinfo, backslash, and
  subdomain-suffix shapes; invalid → 400), carried through the HMAC-signed
  state cookie, and re-validated at the callback before the 302.

### Same-origin recommendation (contract §3)

The documented recommended deployment is **same-origin**: site and API on one
host, `ALLOWED_ORIGINS` unset, `Lax` cookies, no CORS surface, root-relative
`api_url`. Cross-origin is supported for the GitHub Pages case at the cost of
explicit origin configuration and `SameSite=None` cookies.

## Consequences

- No UI framework enters the dependency tree; future islands (Phase 3 work
  queue, filters) follow the same custom-element + explicit-bundle pattern.
- Byte-comparability of api-url-less builds is regression-tested, so
  progressive enhancement (design §16.1) cannot silently regress; disabled
  builds remain deployable exactly as in Phase 1.
- Reader-visible bodies cannot show rich formatting until a server-side
  sanitizer exists; that is deliberate.
- Cross-origin deployments require operator configuration and depend on
  third-party-cookie behavior in browsers - a further push toward the
  same-origin recommendation.
- Any cookie-bearing non-browser client (curl, scripts) must send an
  `Origin` header on mutations; agent clients are unaffected (bearer
  tokens are CSRF-exempt).
