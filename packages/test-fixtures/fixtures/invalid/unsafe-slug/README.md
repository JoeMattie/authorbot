# Fixture: unsafe-slug

Broken in exactly one way: the chapter's `slug` is `../escape`, a path-traversal attempt.

Expected validator codes (see expected-errors.json): PATH_UNSAFE.
Per the Phase 0 contract, each listed code must appear at least once; other
codes are not asserted.

Note: the slug also fails the slug pattern, so a validator may additionally emit CHAPTER_FRONTMATTER_INVALID; that code is deliberately not asserted here.
