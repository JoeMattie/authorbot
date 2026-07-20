# Phase 2b implementation contract — inline annotation UI

Subordinate to `AUTHORBOT_PROJECT_DESIGN.md` (§5.1, §16.1–16.3, §16.6, §22.1)
and additive to the Phase 0/1/2 contracts. Scope: the collaboration islands on
published chapter pages, backed by the Phase 2 API. Votes and the work queue
UI are Phase 3.

## 1. Shape

- The UI ships as **framework-free TypeScript islands** inside the publisher
  site (design §1.1 "small interactive islands"): custom elements, compiled by
  the existing Astro build, hydrated only on chapter pages and only when the
  build is given an API base. Total shipped JS ≤ 35 KB gzipped; no runtime
  dependencies.
- `authorbot build` gains `--api-url <url>` (and `publication.api_url` in
  `book.yml` as the durable form; the flag overrides). Without either, the
  site builds exactly as today — **zero JS, byte-comparable output**.
- Progressive enhancement is a hard rule (§16.1/§27.11): with JS disabled or
  the API unreachable, chapter pages remain fully readable with no
  collaboration chrome and no errors.

## 2. Features (§22.1 MVP subset)

1. **Read**: fetch a chapter's annotations; render gutter cards (desktop ≥
   960px) aligned to their anchor block, stacking on collision; a bottom
   drawer on smaller viewports. Highlight the anchor block on card focus and
   vice-versa. Public visibility follows `publication.show_public_annotations`.
2. **Create**: text selection within a single block offers Comment / Suggest
   change; a keyboard-accessible per-block "Annotate" affordance (§16.6)
   offers the same for the whole block. Range annotations capture
   `{ blockId, textPosition, textQuote(exact, prefix≤32, suffix≤32) }`
   computed against the block's **normalized text** (NFC, collapsed
   whitespace — mirror `@authorbot/markdown` normalization; ship the tiny
   normalizer as shared code in the islands, with unit tests proving parity
   on the package's own normalization fixtures).
3. **Reply**: threaded replies on a card. **Withdraw**: author-only affordance.
4. **Auth**: `GET /v1/me` drives state. Signed-out: a "Sign in with GitHub"
   link to the API's OAuth start URL with a `return_to` back to the chapter
   page (API validates `return_to` against the site origin). Dev mode: the
   islands accept a `data-dev-login` build flag surfacing the dev-login form
   for local testing only (never emitted for production builds).
5. **Status honesty**: cards show `pending_git` state as "syncing" until the
   operation completes (poll the 202 operation endpoint with backoff, max 5
   polls, then leave a refresh hint).

## 3. Security

- **Client rendering of bodies is plain text**: escaped, newline-preserving,
  no client-side Markdown rendering in 2b. (Server-side sanitized rendering
  can come later; this forecloses the XSS surface now.)
- **CORS**: the API gains explicit CORS support — `ALLOWED_ORIGINS` config
  (exact origins, no wildcard), `Access-Control-Allow-Credentials: true`,
  preflight handling. Same-origin deployment (site + API on one host) is the
  documented recommendation; cross-origin is supported for the GH-Pages case.
- **CSRF**: cookie-authenticated mutations require an `Origin` (or `Referer`)
  header matching `ALLOWED_ORIGINS` or the API's own origin; missing/foreign
  origin → 403 problem. Bearer-token requests are exempt (no ambient
  credential). Session cookie becomes `SameSite=None; Secure` only when
  cross-origin is configured; stays `Lax` otherwise.
- CSP on published pages (design §19.4): `default-src 'self'; connect-src
  'self' <api-origin>; img-src 'self' data:` emitted as a `<meta>` tag when
  islands are enabled.

## 4. Accessibility (§16.6)

Keyboard path for every action (annotate block, open card, reply, withdraw);
visible focus; cards are labeled regions announcing quote + author + status;
highlights use outline + background (not color alone); reduced-motion
respected; touch targets ≥ 44px; the reading column's width and typography
are unchanged when the gutter is present.

## 5. Testing

- Island logic (anchoring math, normalizer parity, selection→selector
  mapping, state machine of the composer) under vitest + happy-dom.
- **Playwright e2e** (chromium, installed as a dev dep of the publisher):
  build `examples/book-repo` with `--api-url`, serve statically, run the
  Phase 2 Node dev API (dev auth, temp git repo); flows: dev-login → select
  text → suggest → gutter card appears anchored to the right block → reply →
  reload → both persist (API-backed) → withdraw → card gone; signed-out
  reader sees public annotations read-only; JS-disabled page renders prose
  with zero collaboration chrome; keyboard-only annotation creation.
- Regression: an api-url-less build remains script-free (e2e asserts zero
  `<script>` — same assertion Phase 1 introduced, now conditional).

## 6. Exit criteria

1. The Playwright flows above pass headlessly and repeatably.
2. `pnpm build/typecheck/test` green; Phase 0/1/2 suites and fixture loops
   intact; script-free-without-api-url regression holds.
3. ADR-0018 records the islands approach (framework-free custom elements,
   plain-text bodies, CORS/CSRF model).
4. README + apps/api/README document the site↔API pairing (local dev and
   production same-origin recommendation).
