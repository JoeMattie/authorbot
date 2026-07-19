# Fixture: block-id-invalid

Broken in exactly one way: the second block marker carries a UUIDv4 (version nibble 4), not a UUIDv7.

Expected validator codes (see expected-errors.json): BLOCK_ID_INVALID.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
