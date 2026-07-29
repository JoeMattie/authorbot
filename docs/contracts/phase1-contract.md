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
├── _headers                      # no-transform: blocks edge beacon injection
├── authorbot-build.json          # build manifest (authorbot.build/v1)
├── authorbot-site.json           # site data for custom pages (authorbot.site/v1); base-path nested
├── chapters/<slug>/index.html    # chapter pages per publication.chapter_url
├── <public/**>                   # book-owned static assets, copied verbatim
├── _astro/authorbot-cover-*.webp # cover thumbnails (publication.cover_images)
├── _astro/authorbot-character-*.webp # character portrait thumbnails (character `image`)
└── story/
    ├── index.html                # outline tree
    ├── timeline/index.html       # timeline table
    └── characters/index.html     # character index
        └── <slug>/index.html     # character detail
```

- A book-owned `public/` directory is copied verbatim into the output root
  (0.1.49). `publication.cover_images` names ordered images under it; the
  build renders masthead thumbnails (generated WebP under `_astro/`, named by
  content hash) that open a script-free `:target` lightbox. Both are optional:
  a book without them emits exactly the tree above.
- A character record's optional `image` (0.1.50) names a portrait under
  `public/` the same way. The character index cards and the detail page's
  right gutter render a generated WebP thumbnail (never the full-size
  original) that opens the same script-free lightbox; characters without an
  image render plainly (no avatar).

### Site data JSON (`authorbot.site/v1`) and book-defined nav links (0.1.51)

- Every build writes `authorbot-site.json` next to `index.html` (so it nests
  under the base path with the page URLs, unlike `authorbot-build.json`,
  which stays at the deploy root for deploy tooling). Its shape is the page
  model the generated site embeds - `book`, `basePath`, `chapters` (with
  rendered prose HTML), `outline`, `timeline`, `characters`,
  `planningDocuments`, `collab` - minus the dev-only `localDev` key, plus a
  `schema` discriminator. This makes book-authored custom pages under
  `public/` first-class: a page at `public/<name>/index.html` fetches
  `../authorbot-site.json` relatively (base-path agnostic) and renders
  whatever views it likes, with no toolchain involvement.
- Versioning policy: additive changes keep `authorbot.site/v1`; a breaking
  change bumps the discriminator to `authorbot.site/v2`. The exported
  `SiteModel` TypeScript type in `@authorbot/publisher` is the authoritative
  shape.
- `--include-drafts` builds include drafts in the JSON exactly as the pages
  do; `authorbot dev` serves the drafts-inclusive model at the same URL.
- The generated file is written after the Astro copy, so it always wins over
  a book-supplied `public/authorbot-site.json`; the name is reserved and the
  validate gate warns about the shadowing.
- `publication.nav_links` (`[{label, href}]`) renders plain anchors after
  the built-in nav items on every generated page - the intended front door
  for those custom pages. Hrefs are book-relative paths (leading `/`, safe
  segments, no traversal, no schemes); unsafe hrefs are validation errors
  enforced in the shared schema, so `validate` and the build reject
  identically. The publisher prefixes the base path at build time; custom
  links never carry `aria-current`. Generated pages still ship zero
  JavaScript.

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
- The Cloudflare `_headers` file preserves request-level traffic analytics but
  opts the static site out of response rewriting, including automatic browser
  analytics-beacon injection.

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
