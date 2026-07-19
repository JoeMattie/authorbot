# Fixture: javascript-link

Broken in exactly one way: the second paragraph links to a `javascript:` URL, which is outside the allowed schemes (http, https, mailto, relative).

Expected validator codes (see expected-errors.json): URL_SCHEME_FORBIDDEN.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
