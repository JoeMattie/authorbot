# Fixture: chapter-id-duplicate

Broken in exactly one way: both chapters share the same chapter `id`.

Expected validator codes (see expected-errors.json): CHAPTER_ID_DUPLICATE.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
