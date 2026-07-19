# Fixture: annotation-missing-chapter

Broken in exactly one way: the annotation's `chapter_id` matches no chapter in the repository.

Expected validator codes (see expected-errors.json): ANNOTATION_REF_UNRESOLVED.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
