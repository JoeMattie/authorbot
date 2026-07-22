# Changelog

What changed in each release, and why it mattered. Written for the person
deciding whether to upgrade, not for the person who wrote the commit - so a
release that fixed something serious says what was broken and what it did to
you, rather than naming the function that changed.

Every published package shares this version. A tag builds, tests, and publishes
all of them together, so `@authorbot/cli@0.1.15` and `@authorbot/api@0.1.15` are
always the same commit.

## 0.1.33

- **Collaboration state now stays coherent across the whole site.** Account,
  chapter, annotation, reply, vote, Work, operation, and lease state share one
  lazily loaded browser store. Writes update the page immediately, reconcile
  against authoritative responses and events, and roll back honestly when a
  request fails.
- **New Work claims can recover without persisting lease secrets.** A client
  that loses an in-memory lease token can rotate it through a new
  credential-bound recovery endpoint. Only the exact browser session or agent
  token that made the claim can recover it, and recovery cannot renew or revive
  an expired lease. Claims already live when a book upgrades have no credential
  binding; release and claim them again before relying on recovery.
- **Live collaboration uses fewer requests and exposes less state.** Concurrent
  reads are coalesced, event streams restart when authorization changes, and
  anonymous or signed-in nonmember event polling receives only explicitly
  reviewed public event types and payload fields.
- Background synchronization no longer tears down a sign-in form or editor
  while someone is using it. Optimistic voting, replies, notes, drafts, and
  Work actions retain focus and settle against the same shared state.
- The collaborator skill documents lost-token recovery and safe retry behavior.
  No book-format migration or D1 database migration is required for this
  release.

## 0.1.32

- **Chapter navigation shows the work around each chapter.** Signed-in
  collaborators now see separate, accessible counts for open suggestions,
  block or range comments, whole-chapter comments, replies, and active Work on
  the chapter list, current chapter, previous and next links, and Draft rows.
  The counts come from one indexed database read instead of one request per
  chapter.
- **Any open note can become Work with one click.** Maintainers can promote
  suggestions and comments at chapter, block, or range scope without entering
  a reason. Accepted cards settle into a compact green state, and Previous and
  Next controls move through a chapter's notes without manual scrolling.
- **Upgrades repair their own lockfile.** `authorbot upgrade` now aligns the CLI
  and API packages, refreshes `package-lock.json` with scripts disabled, checks
  the resolved versions, and fails before changing the repository if npm cannot
  produce a safe lockfile.
- The collaboration UI now has its first project-scoped `zustand/vanilla`
  store for shared session and chapter-summary reads. Optimistic mutation and
  event reconciliation remain explicitly staged as the next Phase 11
  increment.
- This release includes database migration `0009_chapter_activity.sql`, which
  adds indexes for the chapter activity aggregate. No book-format migration is
  required.

## 0.1.31

- **Suggestion cards take you back to the prose they reference.** Clicking a
  suggestion now scrolls its anchored section into view, with unit and browser
  coverage for the complete interaction.
- **Configured books cannot silently skip D1 migrations.** Publish workflows
  now use the standard `DB` binding whenever `@authorbot/api` is installed and
  fail before deployment if that binding is missing or invalid. Static-only
  books still skip the step cleanly.
- Existing generated publish workflows receive that safety fix through the
  `0001-fail-safe-d1-migrations` book-format migration during
  `authorbot upgrade`.
- Agent setup instructions now include `AUTHORBOT_PROJECT`, so collaborators
  can target the book without probing the API for its project slug.
- No D1 database migration is required for this release.

## 0.1.30

- **Agents can create chapter drafts without guessing the API.** The
  collaborator skill now documents the direct draft schema, includes a
  dependency-free Python client, and sets a descriptive user agent so
  Cloudflare does not reject Python `urllib` requests before they reach the
  book.
- **Draft creation no longer runs out of Worker subrequests on larger books.**
  Chapter order is projected into D1 instead of rereading every chapter through
  GitHub whenever an agent starts a draft.
- **Notes and replies get out of the way as soon as they are submitted.** Their
  forms clear and close immediately, with the exact draft restored if the
  request fails. The desktop notes rail now shares the page's vertical scroll
  instead of trapping the wheel or trackpad inside a second scrollbar.
- **Agent bylines use the token name.** Published chapters keep the durable
  actor reference in frontmatter while showing the readable agent token name.
- This release includes database migration `0008_chapter_order.sql`. Book CI
  applies it before deploying the new Worker. No book-format migration is
  required.

## 0.1.29

- **The chapter edit box stays aligned with the reading column.** It no longer
  stretches across the full browser width at the bottom of a chapter.
- No book-format migration or database migration is required for this release.

## 0.1.28

- **Review draft can read the chapter in deployed books again.** The redesigned
  Drafts view could list a draft from the database, but opening it asked the
  Worker for repository text through a reader that is intentionally absent in
  production. Chapter editing and Work task bundles now read through the
  project coordinator that owns GitHub access.
- No book-format migration or database migration is required for this release.

## 0.1.27

- **The reading site and author console have been redesigned together.** The
  reader now has clearer book navigation, chapter context, responsive story
  views, and exact inline annotation highlights. Authors get focused Work,
  Settings, and Access consoles with honest conflict handling, accessible
  controls, and account-aware navigation.
- Outline, Timeline, and Characters now expose the book's planning structure
  directly, including the planning method selected in `book.yml`.
- No book-format migration or database migration is required for this release.

## 0.1.26

- Removed every em-dash and en-dash from the tool's output, docs, and code. No
  behaviour change; the wizard, error messages, and generated files now use
  plain hyphens.

## 0.1.25

- **The collaborator skill.** `npx skills add JoeMattie/authorbot` installs a
  skill that teaches an agent to contribute to an Authorbot book - the loop,
  the safety rules, per-role guidance, and the full API reference - into Claude
  Code and any other supported agent tooling. Also installable as a Claude Code
  plugin (`/plugin marketplace add JoeMattie/authorbot`). The `agent` stage now
  points at it.

## 0.1.24

- **`collaborate` commits and pushes what it writes.** It used to ask you to do
  it "when you are ready" - and until that push lands, the API cannot project
  your book, so the settings page reports that it cannot read its own
  configuration, with nothing connecting the two.
- **The agent stage stopped asking for a maintainer bearer token.** No author
  has one; the question could only ever be answered by an operator supplying a
  credential from elsewhere. `AUTHORBOT_API_TOKEN` still works for that case,
  and everyone else is sent to the button on the settings page.
- Declining an optional step no longer tells you to run that step "to
  continue", which made every optional thing look unfinished - `upgrade` most
  of all, on a book far too new to need it.

## 0.1.23

- **Every hint under every question came back.** Moving prompts to clack
  dropped them silently five releases ago: the explanatory line under each
  text and confirm question stopped being shown, so questions arrived without
  the sentence that made them answerable.

## 0.1.22

- **You can create an agent token from your book's settings.** Until now
  nothing in Authorbot could make one: the API needs a maintainer session,
  which only a browser holds, and the settings page could list and revoke
  tokens but not create them - while the setup wizard asked for a bearer token
  no author has ever been issued. The control sits under Agent tokens, shows
  the value once, and defaults to the narrowest scopes an agent needs to read
  chapters, claim work, and submit a draft.

## 0.1.21

- **Installing the GitHub App no longer lands you on a 404.** GitHub was asked
  to run its OAuth flow during installation, which redirected to a callback
  that cannot exist yet - the Worker's config needs the installation id that
  installing is in the middle of producing. It now returns you to your book's
  own site.
- **The agent stage stopped asking for a credential nobody has.** It wanted "a
  maintainer token you already hold"; signing in gives you a session cookie and
  nothing in Authorbot issues bearer tokens. It now prints a request you can
  actually run from your signed-in site. (A create control on the settings page
  is the real fix and is still to come.)
- Colour is drawn with chalk, so it adapts to what your terminal supports.

## 0.1.20

- **The GitHub App key was stored in a format the Worker cannot read.** GitHub's
  manifest hands back a PKCS#1 key; WebCrypto, which is all a Cloudflare Worker
  has, can only import PKCS#8. So every book reported its integration as
  `invalid` and did no Git work at all - chapters could not be saved, the
  projection never ran, settings could not read `book.yml` - with all three
  credentials present and correct. **Books set up before this release need
  their GitHub App deleted and `collaborate` run again**, because the key was
  stored once and cannot be re-read.
- The check meant to catch exactly that missed it: it listed the bad statuses
  and `invalid` was not among them. It now accepts only `configured`.
- Pressing Esc at a prompt exits instead of hanging until Ctrl-C.
- `teardown` names the Cloudflare API token it cannot delete for you, and links
  the GitHub App deletion straight to the page with the button on it.

## 0.1.19

- Spinners with an elapsed timer on the steps that take minutes - installing
  the toolchain, waiting for a site to answer, checking the API. Silence for
  four minutes reads as a hang.
- The mark is centred on the terminal's true width.
- `npx authorbot` with no arguments now points at `npx @authorbot/create`
  instead of listing validate/build/upgrade and stopping.

## 0.1.18

- The wizard opens with the Authorbot mark, drawn in the logo's own orange and
  teal, degrading to one plain line under `NO_COLOR`, in a pipe, or on a narrow
  terminal.

## 0.1.17

- **`npm install` failed for everyone who started the documented way.** npx
  exports its own configuration as `npm_config_*`, the wizard's `npm install`
  inherited it, and resolved against npx's cache directory instead of your
  book - so the install failed and you were left without a
  `package-lock.json`, which both generated workflows refuse to run without. It
  worked fine for anyone running the built binary directly, which is why it
  looked like a problem with the machine.
- A failed install now shows npm's actual error and offers to try again.
- Prompts are drawn with `@clack/prompts`: arrow-key selection, a secret field
  masked with asterisks instead of showing nothing, and Ctrl-C that leaves
  cleanly with the summary of what was created.

## 0.1.16

- **`unpublish` and `teardown`.** `npx @authorbot/create unpublish` removes the
  Worker, the database and the GitHub App, leaving your repository and its
  history alone so `publish` can put the site back. `teardown` also deletes the
  remote repository, then tells you what to type to remove the local copy - it
  never deletes files on your own disk.
- **The wizard is drawn rather than printed**: boxed stage headings, an arrow
  for steps, and check/triangle/cross for outcomes - each degrading to plain
  ASCII under `NO_COLOR`, in a pipe, or on a dumb terminal.
- **A changelog**, here and inside every published package.

## 0.1.15

- **The wizard can tell whether your book can actually save anything.** It used
  to finish by checking that the API refused an anonymous caller, which a
  completely unusable deployment does just as correctly as a healthy one - see
  0.1.14. New `GET /v1/health` reports whether the GitHub App is usable, and
  `collaborate` refuses to switch a book's collaboration controls on when the
  answer is no.

## 0.1.14

- **Collaboration never worked on any book this wizard created.** The Worker
  needs three GitHub App credentials and received two: the app id was read,
  used to poll for the installation, and then dropped. With one missing it does
  no Git work at all - so chapters could not be saved, the projection never
  ran, and settings could not read the book's own `book.yml`, while every
  read-only page answered perfectly. If you set up a book before this release,
  re-run `create-authorbot collaborate`.
- **You can sign out.** There was no way to. Two routes created a session and
  none ended one, so a reader on a shared machine stayed signed in until the
  cookie expired.
- **An account strip in the site header** - sign in, sign out, and the way into
  Settings and the work queue. Previously a book with no chapters had no
  sign-in anywhere, and `/settings/` and `/work/` were linked from nowhere.
- The API health check polls instead of judging on its first answer, which was
  reporting live deployments as failures.
- Worker logs are switched on in generated configs, so a failure can be read
  rather than guessed at.
- The GitHub App is named `authorbot-<slug>`, not `<title> (<slug>)`, which
  GitHub slugified into the same words twice.
- The toolchain install has fifteen minutes rather than five, and says up front
  that it is slow.

## 0.1.13

- **A book with collaboration on showed no sign-in and no annotations.**
  `book.yml` said annotations were public; the Worker was never told, so the
  API refused every anonymous read - and the site gives up and renders nothing
  when its first read fails, removing the very control that would have fixed
  it.

## 0.1.12

- **The collaboration deploy could not bundle.** The SQLite stub was aliased by
  a bare path, which a bundler reads as a package name. This was the last step
  of the last stage, reached only after both browser steps.

## 0.1.11

- **The GitHub App step could never succeed.** The manifest carried a key
  GitHub does not permit, so it was rejected on GitHub's own page before any
  app was created.

## 0.1.10

- **Every upgrade opened a pull request whose CI could not pass.** The
  toolchain bump moved `package.json` without its lockfile, and `npm ci` exists
  to refuse exactly that.

## 0.1.9

- **`publish` left the configuration it wrote uncommitted**, so CI deployed a
  Worker config that did not mention your custom domain, and `upgrade` refused
  to run against the dirty tree.

## 0.1.8

- **A new book's first push failed CI**, before its credentials existed. The
  first thing an author saw about their book was a failure email about a deploy
  that was already succeeding elsewhere.

## 0.1.7

- **A successful deploy was reported as a failure** when the local resolver
  still had the new hostname cached as non-existent - which the wizard's own
  domain check made near-certain.
- Every "run this to carry on" hint named `create-authorbot`, a binary `npx`
  never installs.

## 0.1.6

- **A custom domain could take over a hostname that was already serving a
  site**, with no warning and nothing to agree to. It now checks, says what
  stops being reachable, and defaults to no.
- `publish` exited silently at its last step, leaving no way to tell whether
  the deploy had worked.
- The Cloudflare API token instructions name the D1 permission and both
  resource scopes the template leaves out.

## 0.1.5

- Pointing the wizard at a directory that did not exist yet failed with a bare
  ENOENT - including for the `directory: ./my-book` its own example config
  prints.
- The pinned GitHub Actions moved off a deprecated line.

## 0.1.4

- **A brand-new book was reported as invalid.** The toolchain it pins was never
  installed, so validation fell through to something that could not run, and
  its refusal was read as the book's own failure.
- `authorbot` on npm is a real alias for `@authorbot/cli` again, released
  together, rather than a hand-published 0.0.2 three releases behind.

## 0.1.3

- **The setup wizard discarded every answer** and re-asked its first question
  forever, so `npx @authorbot/create` could not get past the book title.

## 0.1.2

- `--version` reported the wrong version. First release published through npm
  trusted publishing.

## 0.1.1

- First release of `@authorbot/create`, the setup wizard.

## 0.1.0

- Initial release.
