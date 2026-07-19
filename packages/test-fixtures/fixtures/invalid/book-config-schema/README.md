# Fixture: book-config-schema

Broken in exactly one way: book.yml `id` is not a lowercase UUIDv7, so the book config fails its schema.

Expected validator codes (see expected-errors.json): BOOK_CONFIG_INVALID.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
