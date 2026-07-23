# Book repository template

This is a **blank** Authorbot book repository: valid, publishable, and
containing no prose. Copy it, put your own title and `id` in `book.yml`, and
`authorbot validate .` passes from the first commit.

It ships with no chapters on purpose. A book with zero chapters is a
first-class state - it validates, builds, and publishes, and the site says
"No chapters published yet." rather than rendering a broken index. Nothing
here references content that does not exist, so you never have to delete a
sample chapter and then repair the story files that pointed at it.

Want to see a filled-in book? `examples/book-repo` in the Authorbot
repository is the worked example: real chapters, a populated outline and
timeline, characters, annotations, decisions, and a release.

A book repository stays legible without a running Authorbot instance: prose is
Markdown, everything else is YAML.

## Layout

```text
book-repo/
├── book.yml                  # book identity and configuration (authorbot.book/v1)
├── package.json              # pins the Authorbot toolchain version (nothing else)
├── package-lock.json         # the exact, checksummed toolchain CI installs
├── wrangler.jsonc            # Cloudflare Worker that serves the built site
├── chapters/                 # one Markdown file per chapter (empty: see below)
├── story/
│   ├── outline.yml           # story graph: premise/part/chapter/scene nodes (empty)
│   ├── timeline.yml          # sortable events with display labels (empty)
│   └── characters/           # one Markdown file per character (empty)
├── .authorbot/               # durable collaboration records (managed by Authorbot)
│   ├── annotations/          # annotation bodies and replies
│   ├── decisions/            # rule-evaluation decision records
│   ├── work-items/           # work-item specs, stable path per item ID
│   ├── attribution/          # per-chapter revision attribution
│   ├── releases/             # release manifests
│   └── exports/              # optional vote/event exports
└── .github/workflows/        # CI: validate on every change, publish to Cloudflare
```

The `.gitkeep` files exist only to keep empty directories in Git. Delete them
once a directory has real content.

## Conventions that matter

- **IDs are permanent.** `book.id`, chapter `id`s, and every
  `authorbot:block` marker use lowercase UUIDv7. Generate them once; never
  edit or reuse them.
- **Block markers.** Every top-level paragraph, heading, code block, and
  blockquote in a chapter is preceded by
  `<!-- authorbot:block id="<uuidv7>" -->` on its own line. Annotations anchor
  to these IDs, so deleting or duplicating one breaks anchors and fails
  validation.
- **Slugs** (`book.slug`, chapter `slug`) match `[a-z0-9][a-z0-9-]*` - no
  dots, no slashes.
- **Story references.** Story nodes, events, and characters use
  `<kind>:<slug>` IDs (`event:opening-event`, `character:protagonist`).
  Chapter frontmatter may reference them via `timeline_refs` and
  `character_refs`; references must resolve - which is why the empty outline
  and timeline shipped here are empty rather than pre-populated.
- **Timestamps** are RFC 3339 UTC (`2026-07-19T18:00:00Z`).
- **`.authorbot/` is written by Authorbot.** The directories are scaffolded
  here so the layout is visible; the service (or its CLI) creates the records.
- **No secrets.** Tokens, webhook secrets, and deployment credentials never
  belong in this repository.

## Publishing

The supported deployment is **GitHub for the repository, Cloudflare for
hosting** (ADR-0020). There is no second host to choose between, and no
GitHub Pages path: a static-only host can serve your prose but never the
annotations, votes, or work queue, because the collaboration API must be
served from the same origin as the site (ADR-0019). Cloudflare's free tier
covers a book of this size.

- `.github/workflows/validate.yml` runs `authorbot validate .` plus a build
  smoke test (nothing is deployed) on pull requests and pushes that touch book
  content or `.authorbot/` records, so a change that validates but cannot
  publish fails before it lands on `main`.
- `.github/workflows/publish.yml` runs on pushes to `main` that change public
  content (`book.yml`, `chapters/**`, `story/**`, releases), `wrangler.jsonc`,
  or the workflow itself. It validates, builds to `_site/`, and deploys the
  Worker described by `wrangler.jsonc`. The build refuses to publish a
  repository with validation errors, and the output includes
  `authorbot-build.json` recording the commit, chapter revisions, and build
  timestamp.

To enable it:

1. In `wrangler.jsonc`, set `name` to the Worker name you want. It becomes
   part of your default URL (`https://<name>.<subdomain>.workers.dev`), and
   renaming later creates a second Worker rather than moving the first.
2. Create a Cloudflare API token using the **Edit Cloudflare Workers**
   template. In **Settings → Secrets and variables → Actions → Secrets**, add
   it as `CLOUDFLARE_API_TOKEN` and add your account id as
   `CLOUDFLARE_ACCOUNT_ID`.
3. Run `npm install` once and **commit `package-lock.json`**. Both workflows
   run `npm ci`, which refuses to install without a lockfile - deliberately,
   because an install without one is an unpinned install.
4. **Only if** your book lives under a sub-path of a larger site (for example
   `https://example.com/my-book/`), set the `AUTHORBOT_BASE_URL` repository
   variable to that path or URL. Both workflows pass it to `authorbot build
   --base-url` so every internal link and the stylesheet carry the prefix.
   Leave it unset for a book at the root of its own hostname.

## How the toolchain is pinned

Both workflows install the published `@authorbot/cli` package and run its
binary. They do not clone the Authorbot repository and do not compile
TypeScript, so publishing a chapter takes seconds rather than minutes.

The version that runs is the one in this repository's `package.json`, locked
with integrity hashes by `package-lock.json`. That is the whole pin - there is
no `AUTHORBOT_REF` repository variable any more, and if you are migrating an
older book, delete it once nothing reads it.

Keeping the pin in a file rather than a repository setting is what makes it
reviewable: the version appears in your history, an upgrade shows up as a diff
in a pull request next to whatever content migration it carries, and
`git revert` undoes both together. A repository variable is invisible in
history and cannot be rolled back with the content it was paired with.

To upgrade, run `npx authorbot upgrade`, which opens a pull request rather
than pushing (ADR-0021 §3). To do it by hand:
`npm install --save-dev @authorbot/cli@<version>` and commit both files.

The command checks its own version before it changes anything. If
`node_modules` is stale, or the upgrade needs migrations that only exist in
the target release, it hands the operation to that exact CLI release. It uses
an exact matching local install first and otherwise asks npm to acquire one in
a throwaway directory, never inside the book. That release aligns the direct
`@authorbot/cli` and existing `@authorbot/api` pins, regenerates
`package-lock.json`, and verifies all resolved versions before it branches. If
the release is unavailable while offline, the command stops with the
repository unchanged. Do not install or save the target into this book's
`package.json`. Reconnect to npm or populate its cache, then use the exact
transient command printed by the error:
`npx --yes @authorbot/cli@<target> upgrade ...`.

If the installed helper is from before self-bootstrap support existed, give
npm the package explicitly once:
`npx --yes @authorbot/cli@<target> upgrade --to <target>`. After that upgrade,
the normal `npx authorbot upgrade` command handles stale installs itself.

The safety net is unaffected. This adds two small files to a repository that
is otherwise prose; the book is still Markdown and YAML that reads perfectly
well with no tooling at all.

**Deploy through CI, not from your laptop.** `_site` is build output (and is
gitignored). A local `wrangler deploy` publishes whatever happens to be in
that directory, and a stale one quietly replaces your live book with an older
version.

Turning on collaboration later - sign-in, annotations, votes, the work queue -
upgrades this same Worker in place: same name, same origin, same URL, with the
API served at `/v1/*`. See stage 3 of the Authorbot `docs/getting-started.md`.

## First steps

1. Edit `book.yml`: title, slug, language, license, and a fresh `id`
   (a lowercase UUIDv7 - generate one, and never change it afterwards).
2. Set up publishing (previous section) and push. You get a live site that
   says it has no chapters yet, which is the correct thing for it to say.
3. Write chapter one. Once collaboration is switched on, the site's
   **New chapter** button gives you a plain title-and-prose composer and
   generates the frontmatter and block markers for you - you never hand-write
   a UUID. To do it by hand instead, copy a chapter from
   `examples/book-repo/chapters/` and replace every `id` with a fresh UUIDv7.
4. Grow `story/outline.yml`, `story/timeline.yml`, and `story/characters/` as
   the story develops. Each file carries a commented example of its shape.
