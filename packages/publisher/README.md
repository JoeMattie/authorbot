# @authorbot/publisher

Read-only static-site publisher for Authorbot book repositories (Phase 1
contract §1–§4; design §16.1, §17.2). Builds the public reading site with
Astro 5 invoked programmatically and writes the `authorbot.build/v1`
manifest. The output contains **zero client JavaScript** — no `<script>`
tags anywhere.

## Public API

```ts
import { buildSite } from "@authorbot/publisher";

const manifest = await buildSite({
  repoPath: "path/to/book-repo",
  outDir: "_site",
  baseUrl: "https://example.org/books/my-book/", // optional
  commit: undefined,        // optional override; default: git detection
  includeDrafts: false,     // optional
});
```

`buildSite` returns (and writes to `<outDir>/authorbot-build.json`) the
build manifest: `{ schema: "authorbot.build/v1", commit, built_at,
publisher_version, base_url?, chapters: [{ id, slug, revision, title,
status }] }`. `commit` comes from `git rev-parse HEAD` when `repoPath` is
inside a git work tree, else `null`; an explicit `commit` option overrides
detection. The CLI wrapper is `authorbot build <repo> [--out <dir>]
[--base-url <url>] [--include-drafts] [--force]` (in `@authorbot/cli`),
which refuses to build when `authorbot validate` reports errors unless
`--force` is given.

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
