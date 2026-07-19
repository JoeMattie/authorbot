# Fixture: chapter-missing-character-ref

Broken in exactly one way: the chapter's `character_refs` names `character:nobody`, and no such character record exists.

Expected validator codes (see expected-errors.json): CHAPTER_REF_UNRESOLVED.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
