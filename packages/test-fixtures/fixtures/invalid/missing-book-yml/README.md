# Fixture: missing-book-yml

Broken in exactly one way: the repository has no book.yml at its root.

Expected validator codes (see expected-errors.json): BOOK_CONFIG_MISSING.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
