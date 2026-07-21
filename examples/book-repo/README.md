# The Hollow Creek Anomaly

An example Authorbot book repository: a short science-fiction serial about a
metrology lab whose interferometer keeps reporting a small, patient, perfectly
periodic anomaly.

This repository is the Phase 0 reference fixture. It exercises every artifact
the contract defines, and `authorbot validate .` must exit 0 with no errors:

- `book.yml` - book identity and configuration.
- `chapters/` - three chapters (two `published`, one `draft`) with
  `authorbot:block` markers on every top-level paragraph, heading, code
  block, and blockquote.
- `story/outline.yml` - premise, part, chapter, and scene nodes plus links.
- `story/timeline.yml` - three events cross-referencing chapters, characters,
  and locations.
- `story/characters/` - two character records.
- `.authorbot/annotations/` - one range-scoped suggestion with a full target
  selector (block ID, text position, text quote) and one reply.
- `.authorbot/decisions/` - the rule decision that accepted the suggestion.
- `.authorbot/work-items/` - the resulting `revise_range` work item (stable
  path, status in frontmatter).
- `.authorbot/attribution/` - revision attribution for chapter 1.
- `.authorbot/releases/` - the release manifest pinning chapters 1-2.

Note: timeline events reference `location:*` IDs without a locations
collection; per the Phase 0 contract those resolve as warnings, not errors.
