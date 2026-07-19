# Fixture: story-graph-unresolved-parent

Broken in exactly one way: the outline node `scene:orphaned` declares `parent: part:ghost`, and no such node exists.

Expected validator codes (see expected-errors.json): STORY_GRAPH_REF_UNRESOLVED.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
