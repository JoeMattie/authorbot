# Phase 0 implementation contract

This document pins the decisions that Phase 0 packages must agree on. It is
subordinate to `AUTHORBOT_PROJECT_DESIGN.md`; where the design document offers a
choice, this contract selects one. Changes here require updating every affected
package in the same change.

## 1. Workspace conventions

- Package manager: pnpm workspace (`apps/*`, `packages/*`). Node >= 22, ESM only
  (`"type": "module"`).
- Package names: `@authorbot/schemas`, `@authorbot/markdown`, `@authorbot/cli`
  (in `apps/cli`, bin name `authorbot`), `@authorbot/test-fixtures`.
- Each package: `src/` compiled to `dist/` with `tsc`; `tsconfig.json` extends
  `../../tsconfig.base.json`; `exports` map with `types` condition; scripts
  `build`, `test` (vitest), `typecheck` (`tsc --noEmit`).
- Validation library: Zod v4 (`import { z } from "zod"`). JSON Schemas are
  generated from the Zod schemas with `z.toJSONSchema` and written to
  `packages/schemas/json/` by a build step (checked in).
- Markdown parsing: unified / remark (`remark-parse`, `remark-frontmatter`,
  `yaml` for frontmatter payloads).
- The CLI uses hand-rolled argv parsing (no CLI framework). Human-readable
  output by default, `--json` for machine output. Exit codes: `0` valid,
  `1` validation findings, `2` usage or I/O error.

## 2. Identifier and reference formats

- Entity IDs (`book.id`, `chapter.id`, annotation, work item, decision,
  release IDs): UUIDv7, lowercase.
- Story node / timeline / bible IDs: `<kind>:<slug>` where kind is one of
  `premise|arc|part|chapter|scene|beat|event|character|location|concept|rule`
  and slug matches `[a-z0-9][a-z0-9-]*`.
- Actor references: `<namespace>:<identifier>` where namespace is one of
  `github|agent|system` (e.g. `github:octocat`, `system:rule-engine`).
- Slugs (`book.slug`, `chapter.slug`): `[a-z0-9][a-z0-9-]*`, no path
  separators, no leading dots (path-traversal safe by construction).
- Timestamps: RFC 3339 UTC (`2026-07-19T18:00:00Z`).

## 3. Markdown block markers

- Marker syntax, on its own line immediately before the block it identifies:
  `<!-- authorbot:block id="<uuidv7>" -->`
- One marker per semantic block (paragraph, heading, list item, blockquote
  paragraph, code block, table row). v0.1 requires markers on top-level
  paragraphs, headings, code blocks, and blockquotes in chapter files; list
  items and table rows are optional in Phase 0.
- Work-item original-text delimiters:
  `<!-- authorbot:original:start -->` … `<!-- authorbot:original:end -->`
  (exactly one balanced pair when the section is present).

## 4. Book repository artifact formats

Schema discriminators (the `schema` field) and locations:

| Artifact | Schema ID | Location |
|---|---|---|
| Book config | `authorbot.book/v1` | `book.yml` |
| Chapter | `authorbot.chapter/v1` | `chapters/*.md` frontmatter |
| Story graph | `authorbot.story-graph/v1` | `story/outline.yml` |
| Timeline | `authorbot.timeline/v1` | `story/timeline.yml` |
| Character | `authorbot.character/v1` | `story/characters/*.md` frontmatter |
| Annotation | `authorbot.annotation/v1` | `.authorbot/annotations/<id>/annotation.md` frontmatter |
| Reply | `authorbot.reply/v1` | `.authorbot/annotations/<id>/replies/<reply-id>.md` frontmatter |
| Decision | `authorbot.decision/v1` | `.authorbot/decisions/<id>.yml` |
| Work item | `authorbot.work-item/v1` | `.authorbot/work-items/<id>.md` frontmatter |
| Attribution | `authorbot.attribution/v1` | `.authorbot/attribution/<chapter-id>.yml` |
| Release | `authorbot.release/v1` | `.authorbot/releases/<id>.yml` |
| Instance config | `authorbot.instance/v1` | deployment config (not in book repo) |

Decisions selected from design §26.1:

- Work items use **stable paths** (`.authorbot/work-items/<id>.md`) with status
  in frontmatter. The status directories shown in design §8.1 are superseded
  (ADR).
- Block IDs are **mandatory** in chapter sources (no sidecar anchor map).

Field shapes follow design §8.2 (book), §8.3 (chapter), §8.5 (story graph),
§8.6 (timeline), §13 (work item), §10.1 (annotation target), §25 (instance
config). Where the design is silent:

- Chapter `status`: `draft|proposed|published|archived`; `revision`: integer
  >= 1; `authors`: non-empty list of `{ actor }`.
- Character frontmatter: `schema`, `id` (`character:<slug>`), `name`; optional
  `aliases`, `summary`, `status`.
- Story graph node `type`: `premise|arc|part|chapter|scene|beat|custom`;
  `order`: number; chapter nodes carry `chapter_id` (UUID of a chapter).
- Timeline event: `id` (`event:<slug>`), `sort_key` (number), `display_time`,
  `title`; optional `participants`, `locations`, `chapter_refs`, `facts`.
- Annotation frontmatter: `id`, `kind` (`comment|suggestion`), `scope`
  (`range|block|chapter`), `chapter_id`, `chapter_revision`, `author`,
  `status` (`open|work_item_created|accepted|resolved|rejected|withdrawn|`
  `superseded|orphaned|needs_reanchor`), `created_at`; `target` required for
  `range` (block_id + text_position + text_quote) and `block` (block_id) scopes.
- Work item `type`: `revise_range|revise_block|revise_chapter|write_chapter|`
  `resolve_conflict|planning`; `status`:
  `ready|leased|submitted|applying|completed|conflict|failed|cancelled`;
  `priority`: `low|normal|high`.
- Decision record: `id`, `source_annotation_id`, `rule`, `rule_version`,
  `metrics` (object of numbers), `result` (`create_work_item|rejected|`
  `support_changed|overridden`), optional `work_item_id`, `effective_at`,
  optional `override_reason`.
- Release: `id`, `created_at`, `chapters`: list of `{ chapter_id, revision }`,
  optional `notes`.
- Attribution: `chapter_id`, `entries`: list of `{ revision, actor,
  work_item_id?, commit? }`.

## 5. Validation error codes

`authorbot validate` findings carry a stable `code`. Invalid fixtures document
their expected codes in `expected-errors.json` (`{ "errors": ["CODE", ...] }`,
meaning: each listed code appears at least once; no other codes are asserted).

| Code | Meaning |
|---|---|
| `BOOK_CONFIG_MISSING` | `book.yml` absent or unreadable |
| `BOOK_CONFIG_INVALID` | `book.yml` fails schema |
| `CHAPTER_FRONTMATTER_INVALID` | chapter frontmatter fails schema |
| `CHAPTER_ID_DUPLICATE` | two chapters share an `id` |
| `CHAPTER_SLUG_DUPLICATE` | two chapters share a `slug` |
| `CHAPTER_ORDER_DUPLICATE` | two chapters share an `order` |
| `CHAPTER_REF_UNRESOLVED` | chapter `timeline_refs`/`character_refs` target missing records |
| `BLOCK_ID_MISSING` | required semantic block lacks a marker |
| `BLOCK_ID_DUPLICATE` | block ID appears more than once in the repository |
| `BLOCK_ID_INVALID` | malformed marker or non-UUIDv7 ID |
| `RAW_HTML_FORBIDDEN` | raw HTML in prose while `content.raw_html` is false (authorbot marker comments are exempt) |
| `URL_SCHEME_FORBIDDEN` | link/image URL scheme outside `http`, `https`, `mailto`, or relative |
| `STORY_GRAPH_INVALID` | `story/outline.yml` fails schema |
| `STORY_GRAPH_REF_UNRESOLVED` | node `parent`, link endpoint, or `chapter_id` unresolved |
| `TIMELINE_INVALID` | `story/timeline.yml` fails schema |
| `TIMELINE_REF_UNRESOLVED` | event participants/locations/chapter_refs unresolved |
| `CHARACTER_FILE_INVALID` | character frontmatter fails schema |
| `ANNOTATION_INVALID` | annotation or reply record fails schema |
| `ANNOTATION_REF_UNRESOLVED` | annotation chapter/block target unresolved |
| `WORK_ITEM_INVALID` | work item frontmatter fails schema |
| `WORK_ITEM_DELIMITER_INVALID` | unbalanced/duplicated original-text delimiters |
| `WORK_ITEM_REF_UNRESOLVED` | work item chapter/annotation reference unresolved |
| `DECISION_INVALID` | decision record fails schema |
| `DECISION_REF_UNRESOLVED` | decision annotation/work-item reference unresolved |
| `RELEASE_INVALID` | release manifest fails schema |
| `RELEASE_REF_UNRESOLVED` | release references unknown chapter/revision |
| `ATTRIBUTION_INVALID` | attribution record fails schema |
| `PATH_UNSAFE` | slug/path contains traversal or reserved names |

Unresolved-reference rules: `location:*` and `concept:*` references are
warnings (not errors) in Phase 0 unless the referenced collection exists;
`character:*`, `event:*`, chapter IDs, annotation IDs, and work-item IDs are
errors.

Finding shape (JSON output): `{ code, severity: "error"|"warning", path,
message, pointer? }` where `path` is repo-relative and `pointer` locates the
field or line.

## 6. Phase 0 exit criteria

1. `authorbot validate examples/book-repo` exits 0 with no errors.
2. Every fixture under `packages/test-fixtures/fixtures/invalid/*` fails with
   its documented codes.
3. `pnpm build`, `pnpm test`, `pnpm typecheck` pass at the workspace root.
4. `openapi/openapi.yaml` parses and covers the endpoint outline of design §15.
5. ADRs exist for the §26.1 defaults adopted by this contract.
