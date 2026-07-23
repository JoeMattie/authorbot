/**
 * The site's Content-Security-Policy, in one place (design §19.4).
 *
 * ## Why every prose page carries it, not just the collaborative ones
 *
 * Phase 2b introduced this policy for the collaboration islands and attached it
 * to the pages that load them. That left the pages which render *prose* - the
 * chapter page in an api-url-less build, and every character page - emitting
 * `set:html` with no policy at all. Today nothing exploitable reaches that
 * HTML: raw HTML in chapters is escaped, `content.raw_html` is immutable
 * through the API, and enabling it takes a reviewed commit. But §19.4 asks for
 * defence in depth precisely because "nothing exploitable reaches it today" is
 * a statement about the current code, not about the book that legitimately
 * turns `content.raw_html` on - and on that book these are the pages that
 * inject author-supplied markup into the document.
 *
 * A CSP costs nothing on a static page and is the layer that turns an injected
 * `<script>` from a compromise into a console error. It belongs on the pages
 * that render prose whether or not they also happen to load an island.
 *
 * `default-src 'self'` already constrains connections; `connect-src` is stated
 * anyway so the island's requirement is explicit rather than inherited, and so
 * that narrowing `default-src` later cannot silently break the API calls.
 */
export const SITE_CSP =
  "default-src 'self'; " +
  // Same-origin only (ADR-0019 §1): `'self'` is the whole story.
  "connect-src 'self'; " +
  "img-src 'self' data:; " +
  // The editor's UI can emit an inlined WOFF2 asset. Keep every other font
  // source same-origin while permitting that single asset shape.
  "font-src 'self' data:";
