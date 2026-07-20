# @authorbot/publisher

Static-site publisher for Authorbot book repositories (Phase 1 contract
§1–§4; Phase 2b contract §1–§4; design §16.1–16.2, §17.2). Builds the public
reading site with Astro 5 invoked programmatically and writes the
`authorbot.build/v1` manifest. Without an API base the output contains
**zero client JavaScript** — no `<script>` tags anywhere, byte-identical to
a pre-collaboration build. With one (`apiUrl` option / `--api-url` /
`publication.api_url`), chapter pages additionally mount the framework-free
collaboration islands (see below).

## Public API

```ts
import { buildSite } from "@authorbot/publisher";

const manifest = await buildSite({
  repoPath: "path/to/book-repo",
  outDir: "_site",
  baseUrl: "https://example.org/books/my-book/", // optional
  commit: undefined,        // optional override; default: git detection
  includeDrafts: false,     // optional
  apiUrl: undefined,        // optional; enables the collaboration islands
                            // (overrides publication.api_url in book.yml)
  devLogin: false,          // optional; surface the dev-login form —
                            // programmatic only, never exposed via the CLI
});
```

`buildSite` returns (and writes to `<outDir>/authorbot-build.json`) the
build manifest: `{ schema: "authorbot.build/v1", commit, built_at,
publisher_version, base_url?, chapters: [{ id, slug, revision, title,
status }] }`. `commit` comes from `git rev-parse HEAD` when `repoPath` is
inside a git work tree, else `null`; an explicit `commit` option overrides
detection. The CLI wrapper is `authorbot build <repo> [--out <dir>]
[--base-url <url>] [--api-url <url>] [--include-drafts] [--force]` (in
`@authorbot/cli`), which refuses to build when `authorbot validate` reports
errors unless `--force` is given.

## How repository data reaches Astro

The Astro project root is the `site/` directory shipped inside this package
(`site/src/pages/*.astro`). Repository content never touches the Astro
project on disk; instead:

1. `loadSiteModel()` loads the repo with `@authorbot/schemas` (frontmatter
   and record validation) and `@authorbot/markdown` (mdast AST + the
   contract's block-marker scan), pre-renders all prose to sanitized HTML
   (`render.ts`), and produces a fully **JSON-serializable site model**.
2. `buildSite()` calls Astro's programmatic `build()` with an inline Vite
   plugin that serves a **virtual module** (`virtual:authorbot-site`) whose
   source is `export const site = <JSON.stringify(model)>;`.
3. Every `.astro` template does `import { site } from
   "virtual:authorbot-site"` and renders from that model only. Pre-rendered
   prose is injected with `set:html`; everything else goes through Astro's
   own escaping.

The virtual module was chosen over `globalThis` injection because it is the
mechanism Vite/Astro document for build-time data, it keeps the data flow
explicit and importable from every template, it cannot leak across
concurrent processes, and it forces the model to be plain JSON (no live
objects smuggled into templates).

During the Astro build the process cwd is temporarily switched to the
`site/` directory: when `outDir` lies outside the cwd, Astro stages its
intermediate server bundle in `<cwd>/.astro`, and only a cwd inside this
package lets Node resolve Astro's own dependencies from a pnpm workspace.
The staging directory is removed by Astro after the build.

## Rendering safety (contract §4)

Chapter and character Markdown is rendered to HTML by `render.ts` directly
from the mdast AST — no HTML serializer library, every byte escaped at one
boundary:

- All text and attribute values are HTML-escaped.
- Marked semantic blocks carry `id="b-<block-uuid>"` anchors, associated by
  the same `extractBlocks` scan the validator uses.
- Authorbot marker comments are stripped from output.
- When `content.raw_html` is false (the default), raw HTML nodes are
  rendered as **escaped text**, never as markup.
- Links/images with URL schemes outside `http`/`https`/`mailto`/relative
  are not rendered as links: link text survives as plain text, images
  collapse to their alt text.
- Meta `description` attributes additionally have `<`/`>` stripped, so no
  literal `<script` substring can appear even inside a quoted attribute.

## Page inventory (contract §2)

- `index.html` — book title + chapter index (title, order, summary).
- `chapters/<slug>/index.html` — prose with block anchors, prev/next nav by
  `order`, footer with revision/authors when `publication.show_revision` /
  `show_attribution` are true, draft banner (and `noindex`) on
  draft/proposed chapters.
- `story/index.html` — outline tree, nodes nested by parent, ordered.
- `story/timeline/index.html` — table sorted by `sort_key` showing
  `display_time`, title, participants (linked to character pages),
  locations, chapter links.
- `story/characters/index.html` and `story/characters/<slug>/index.html` —
  character index and detail (frontmatter fields, rendered body, chapters
  whose `character_refs` mention the character).

One shared stylesheet (`site/src/styles/site.css`, emitted as a single
hashed file), ~65ch measure, `prefers-color-scheme` dark mode, skip link,
landmarks, `lang` from `book.yml`. No CSS framework, no icons, no client
bundle.

## Collaboration islands (`api_url`, Phase 2b contract §1–§4)

Enabled by an API base — `buildSite({ apiUrl })` / CLI `--api-url <url>`
overrides the durable `publication.api_url` in `book.yml`. Accepted forms
(`resolveCollab` in `src/load.ts`): an absolute http(s) URL (its origin goes
into the CSP `connect-src`) or a root-relative path for same-origin
deployment (the recommended production setup; covered by `'self'`). Anything
else fails the build. Without an API base, `SiteModel.collab` is `null` and
the output stays byte-identical script-free — regression-tested.

When enabled, **chapter pages only** gain four insertions (index, story, and
character pages are untouched):

- a CSP `<meta>` tag: `default-src 'self'; connect-src 'self' <api-origin>;
  img-src 'self' data:` (contract §3; no `'unsafe-inline'` needed — the
  islands touch styles via the CSSOM only);
- a `<link>` to `_astro/authorbot-collab.css`;
- the mount element (see contract below);
- a `<script type="module">` for `_astro/authorbot-collab.js`.

The islands are **framework-free custom elements** (ADR-0018) in
`site/src/islands/`, bundled by an explicit Vite step (`buildIslands()`) run
only when enabled, with stable asset names — deliberately outside Astro's
script pipeline, which would emit chunks even into disabled builds. No
runtime dependencies; ~8 KB gzipped JS + ~2 KB CSS against the contract's
35 KB budget. Annotation/reply bodies render as plain text (`textContent` +
`white-space: pre-wrap`; the bundle contains no `innerHTML` — asserted by
test); no client-side Markdown.

Features (contract §2): `/v1/me` auth state with a GitHub sign-in link
carrying `return_to`; annotation gutter cards (≥960 px, collision-stacked)
or a bottom drawer below that; card↔block focus sync and highlighting;
text-selection Comment/Suggest with single-block enforcement and a
keyboard-accessible per-block "Annotate" button; range selectors
`{ blockId, textPosition, textQuote(exact, prefix≤32, suffix≤32) }` computed
against normalized block text (DOM mirror of `@authorbot/markdown`
normalization, parity-tested on that package's fixtures); threaded replies;
author-only two-step withdraw; `pending_git` shown as "syncing" with bounded
operation polling (max 5, backoff) then a refresh hint. Accessibility per
contract §4: full keyboard path, labeled card regions, outline+background
highlights, reduced-motion, ≥44 px coarse-pointer targets, reading column
unchanged.

Mount contract (for e2e/tooling):

```html
<authorbot-collab
  data-api-base="…"          <!-- configured API base, no trailing slash -->
  data-project="…"           <!-- book slug (API accepts slug or UUID) -->
  data-chapter-id="…" data-chapter-revision="…"
  data-show-public="…"       <!-- publication.show_public_annotations -->
  [data-dev-login]           <!-- only from buildSite({ devLogin: true }) -->
></authorbot-collab>
```

Assets live at `${base}_astro/authorbot-collab.js|.css`. Key selectors:
`.ab-signin`, `.ab-devlogin`, `.ab-annotate`, `.ab-seltool`, `.ab-composer`,
`.ab-card`, `.ab-drawer-toggle`, `.ab-marker`, `.ab-target`.

`data-dev-login` exists for local testing only: it is a programmatic
`buildSite` option, not a CLI flag, and is never emitted otherwise. API-side
pairing (`ALLOWED_ORIGINS`, CSRF, `return_to` validation) is documented in
`apps/api/README.md`; the end-to-end local recipe is in the root `README.md`.

## Chapter selection

`status: published` is included by default; `--include-drafts` adds
`draft` and `proposed` chapters (flagged `isDraft`, banner shown);
`archived` is never published. Prev/next navigation and the index follow
`order` among the included chapters.

## Contract ambiguities resolved here

- **Index vs. drafts**: contract §2 shows the index as "published only";
  with `--include-drafts` the index lists all *included* chapters, drafts
  visibly labeled — otherwise draft pages would be unreachable.
- **Manifest chapter list**: `chapters` records the chapters *included in
  the build* (what was actually published), not every file in the repo.
- **Raw HTML under `--force`**: "never emitted" is implemented as
  escape-to-text rather than silent dropping, so forced builds remain
  honest about their sources while staying inert.
- **`--out` default**: `_site`, resolved against the process cwd (matches
  the CI workflow's `--out _site`).
- **`publication.show_revision`/`show_attribution` absent**: default false.
- **Excluded chapters referenced by the timeline**: shown as plain-text
  titles, never links, so internal links always resolve.
