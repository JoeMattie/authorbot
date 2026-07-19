# Fixture: block-id-missing

Broken in exactly one way: the chapter's second paragraph has no `authorbot:block` marker.

Expected validator codes (see expected-errors.json): BLOCK_ID_MISSING.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
