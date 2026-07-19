# Fixture: timeline-unresolved-chapter-ref

Broken in exactly one way: the timeline event's `chapter_refs` names a chapter UUID that matches no chapter in the repository.

Expected validator codes (see expected-errors.json): TIMELINE_REF_UNRESOLVED.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
