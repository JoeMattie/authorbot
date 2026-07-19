# Fixture: raw-html-forbidden

Broken in exactly one way: the second paragraph contains raw inline HTML (`<b>`) while book.yml sets `content.raw_html: false` (authorbot marker comments are exempt).

Expected validator codes (see expected-errors.json): RAW_HTML_FORBIDDEN.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
