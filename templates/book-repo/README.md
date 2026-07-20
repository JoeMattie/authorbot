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
└── .github/workflows/        # CI: validate on every change, publish to GitHub Pages
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

## Publishing

The repository publishes itself as a static reading site via GitHub Pages:

- `.github/workflows/validate.yml` runs `authorbot validate .` plus a
  build smoke test (nothing is deployed) on pull requests and pushes that
  touch book content or `.authorbot/` records, so a change that validates
  but cannot publish fails before it lands on `main`.
- `.github/workflows/publish.yml` runs on pushes to `main` that change public
  content (`book.yml`, `chapters/**`, `story/**`, releases) or the workflow
  itself. It validates, builds with `--base-url` set to the URL GitHub Pages
  resolves for your repository (project sites live under
  `https://<owner>.github.io/<repo>/`, and every internal link honors that
  prefix), and deploys `_site/` to GitHub Pages. The build refuses to publish
  a repository with validation errors, and the output includes
  `authorbot-build.json` recording the commit, chapter revisions, and build
  timestamp.

To enable it:

1. In your repository's **Settings → Pages**, set **Source** to
   **GitHub Actions**.
2. (Recommended) In **Settings → Secrets and variables → Actions →
   Variables**, set `AUTHORBOT_REF` to an exact commit SHA (or release tag)
   of `JoeMattie/authorbot`; both workflows use it. Without it they track
   that repository's `main` branch — which works out of the box, but pinning
   keeps builds reproducible; bump the ref deliberately, as its own commit.

Both workflows check out the Authorbot toolchain at that ref, build it with
pnpm, and run the `authorbot` CLI from that checkout — the book repository
itself needs no Node toolchain.

## First steps

1. Edit `book.yml`: title, slug, language, license, and a fresh `id`.
2. Rename `chapters/001-opening.md`, update its frontmatter (fresh `id`, your
   slug/title, your actor ref), and write prose with block markers.
3. Grow `story/outline.yml`, `story/timeline.yml`, and `story/characters/` as
   the story develops.
4. Set up publishing (previous section): enable GitHub Pages and pin the
   Authorbot ref in the workflows.
