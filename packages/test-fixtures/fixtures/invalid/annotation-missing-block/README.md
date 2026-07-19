# Fixture: annotation-missing-block

Broken in exactly one way: the annotation targets a `blockId` that appears in no chapter.

Expected validator codes (see expected-errors.json): ANNOTATION_REF_UNRESOLVED.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
