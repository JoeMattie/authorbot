# Fixture: story-graph-unresolved-chapter-id

Broken in exactly one way: the outline's chapter node carries a `chapter_id` that matches no chapter in the repository.

Expected validator codes (see expected-errors.json): STORY_GRAPH_REF_UNRESOLVED.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
