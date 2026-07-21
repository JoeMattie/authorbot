# Phase 1 implementation contract - read-only publisher

Subordinate to `AUTHORBOT_PROJECT_DESIGN.md` (§16.1, §17.2, §23 Phase 1, §24
Epic B) and additive to `docs/phase0-contract.md`. Where the design offers a
choice, this contract selects one.

## 1. Shape

- Package `@authorbot/publisher` at `packages/publisher`. Astro 5 static
  output (design §1.1), invoked programmatically; no client JavaScript is
  emitted in Phase 1 (islands arrive with collaboration mode, Phase 2+).
- Public API: `buildSite({ repoPath, outDir, baseUrl?, commit?,
  includeDrafts? })` returning the build manifest.
- CLI: `authorbot build <repo> [--out <dir>] [--base-url <url>]
  [--include-drafts] [--force]` added to `apps/cli` as a thin wrapper.
- Build refuses to run when `validate` reports errors (warnings allowed);
  `--force` overrides with a prominent warning.

## 2. Output contract

```text
<out>/
├── index.html                    # book title + chapter index (published only)
├── authorbot-build.json          # build manifest (authorbot.build/v1)
├── chapters/<slug>/index.html    # chapter pages per publication.chapter_url
└── story/
    ├── index.html                # outline tree
    ├── timeline/index.html       # timeline table
    └── characters/index.html     # character index
        └── <slug>/index.html     # character detail
```

- Chapters with `status: published` are included by default; `--include-drafts`
  adds `draft`/`proposed` chapters with a visible draft banner. `archived` is
  never published.
- Previous/next navigation follows `order` among included chapters.
- Rendered semantic blocks carry `id="b-<block-uuid>"` anchors (future
  annotation targets).
- `publication.show_revision` / `show_attribution` control a chapter footer
  showing revision number and author actors.
- Reading pages are fully usable without JavaScript (design §16.1); semantic
  HTML with landmarks, skip link, `lang` from `book.yml`, readable measure.

## 3. Build manifest

New schema `authorbot.build/v1` in `@authorbot/schemas`:
`{ schema, commit: string|null, built_at, publisher_version, base_url?,
chapters: [{ id, slug, revision, title, status }] }` - design §17.2.

## 4. Rendering safety

- Markdown renders through the `@authorbot/markdown` AST. Raw HTML is never
  emitted when `content.raw_html` is false (marker comments stripped); URL
  schemes outside the Phase 0 allow-list are not rendered as links.
- All text is HTML-escaped at the template boundary.

## 5. CI wiring

- `templates/book-repo/.github/workflows/publish.yml` becomes a working
  GitHub Pages deployment: checkout book repo, checkout `JoeMattie/authorbot`
  at a pinned ref, `pnpm install && pnpm build`, `authorbot validate .`,
  `authorbot build . --out _site`, deploy via `actions/deploy-pages`.
- Path filters per design §7.4.

## 6. Exit criteria

1. `authorbot build examples/book-repo --out <tmp>` exits 0; output contains
   index, both published chapter pages (draft excluded), story views, and a
   manifest whose chapters match the repo.
2. e2e tests assert: internal links resolve, block anchors present, no
   `<script>` in output, draft exclusion, sanitization (hostile fixture
   content never reaches output unescaped).
3. Workspace `pnpm build`, `pnpm typecheck`, `pnpm test` stay green.
