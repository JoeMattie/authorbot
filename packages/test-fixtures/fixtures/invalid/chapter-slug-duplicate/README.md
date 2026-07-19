# Fixture: chapter-slug-duplicate

Broken in exactly one way: both chapters share the slug `solitary`.

Expected validator codes (see expected-errors.json): CHAPTER_SLUG_DUPLICATE.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
