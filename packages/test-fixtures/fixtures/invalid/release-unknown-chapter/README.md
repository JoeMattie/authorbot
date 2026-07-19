# Fixture: release-unknown-chapter

Broken in exactly one way: the release manifest pins a `chapter_id` that matches no chapter in the repository.

Expected validator codes (see expected-errors.json): RELEASE_REF_UNRESOLVED.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
