# Fixture: chapter-order-duplicate

Broken in exactly one way: both chapters share `order: 10`.

Expected validator codes (see expected-errors.json): CHAPTER_ORDER_DUPLICATE.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
