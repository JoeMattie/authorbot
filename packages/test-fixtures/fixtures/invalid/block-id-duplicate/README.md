# Fixture: block-id-duplicate

Broken in exactly one way: both paragraphs carry the same block ID.

Expected validator codes (see expected-errors.json): BLOCK_ID_DUPLICATE.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
