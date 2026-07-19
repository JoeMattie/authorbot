# Book repository template

This is a minimal, valid Authorbot book repository. Copy it, replace the
placeholder IDs and text, and `authorbot validate .` should pass from the
first commit.

A book repository stays legible without a running Authorbot instance: prose is
Markdown, everything else is YAML.

## Layout

```text
book-repo/
├── book.yml                  # book identity and configuration (authorbot.book/v1)
├── chapters/                 # one Markdown file per chapter
│   └── 001-opening.md        # YAML frontmatter + prose with block markers
├── story/
│   ├── outline.yml           # story graph: premise/part/chapter/scene nodes
│   ├── timeline.yml          # sortable events with display labels
│   └── characters/           # one Markdown file per character
├── .authorbot/               # durable collaboration records (managed by Authorbot)
│   ├── annotations/          # annotation bodies and replies
│   ├── decisions/            # rule-evaluation decision records
│   ├── work-items/           # work-item specs, stable path per item ID
│   ├── attribution/          # per-chapter revision attribution
│   ├── releases/             # release manifests
│   └── exports/              # optional vote/event exports
└── .github/workflows/        # commented CI skeletons: validate + publish
```

## Conventions that matter

- **IDs are permanent.** `book.id`, chapter `id`s, and every
  `authorbot:block` marker use lowercase UUIDv7. Generate them once; never
  edit or reuse them.
- **Block markers.** Every top-level paragraph, heading, code block, and
  blockquote in a chapter is preceded by
  `<!-- authorbot:block id="<uuidv7>" -->` on its own line. Annotations anchor
  to these IDs, so deleting or duplicating one breaks anchors and fails
  validation.
- **Slugs** (`book.slug`, chapter `slug`) match `[a-z0-9][a-z0-9-]*` — no
  dots, no slashes.
- **Story references.** Story nodes, events, and characters use
  `<kind>:<slug>` IDs (`event:opening-event`, `character:protagonist`).
  Chapter frontmatter may reference them via `timeline_refs` and
  `character_refs`; references must resolve.
- **Timestamps** are RFC 3339 UTC (`2026-07-19T18:00:00Z`).
- **`.authorbot/` is written by Authorbot.** The directories are scaffolded
  here so the layout is visible; the service (or its CLI) creates the records.
- **No secrets.** Tokens, webhook secrets, and deployment credentials never
  belong in this repository.

## First steps

1. Edit `book.yml`: title, slug, language, license, and a fresh `id`.
2. Rename `chapters/001-opening.md`, update its frontmatter (fresh `id`, your
   slug/title, your actor ref), and write prose with block markers.
3. Grow `story/outline.yml`, `story/timeline.yml`, and `story/characters/` as
   the story develops.
4. Uncomment and adapt the workflows under `.github/workflows/` when the
   Authorbot CLI is available to your CI.
