# ADR 0003: Markdown + YAML frontmatter + mandatory HTML-comment block IDs

## Status

Accepted (2026-07-19)

## Context

Annotations, suggestions, and automated edits need stable anchors into prose
that survive editing (design §8.3, §10). Design §26.1 left open mandatory
in-source block IDs versus a sidecar anchor map.

## Decision

- Chapters are Markdown with YAML frontmatter (`schema: authorbot.chapter/v1`,
  design §8.3; field shapes per contract §4).
- Each semantic block is preceded by an HTML-comment marker on its own line:
  `<!-- authorbot:block id="<uuidv7>" -->` (contract §3). Ordinary Markdown
  renderers ignore it, keeping the repository portable (§3.4).
- Block IDs are **mandatory** in chapter sources - no sidecar anchor map
  (§26.1). v0.1 requires markers on top-level paragraphs, headings, code
  blocks, and blockquotes; list items and table rows are optional in Phase 0.
- Removing IDs in normal edits fails validation (`BLOCK_ID_MISSING`); a
  dedicated explicit repair command (publisher/CLI) adds missing IDs (§8.3).

## Consequences

- Anchors travel with the text through Git history; no sidecar to drift.
- Prose sources carry visible marker comments; editors must preserve them, and
  repair tooling is a hard requirement, not a nicety.
- Validation can enforce uniqueness repository-wide (`BLOCK_ID_DUPLICATE`) and
  well-formedness (`BLOCK_ID_INVALID`) deterministically.
