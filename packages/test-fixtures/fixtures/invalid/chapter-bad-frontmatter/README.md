# Fixture: chapter-bad-frontmatter

Broken in exactly one way: the chapter frontmatter `status` is `simmering`, which is not one of draft|proposed|published|archived.

Expected validator codes (see expected-errors.json): CHAPTER_FRONTMATTER_INVALID.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.
