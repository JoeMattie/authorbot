# Phase 6 implementation contract — guided onboarding

Additive to Phase 0–5 contracts. (The design document's §23 Phase 6
"hardening" becomes **Phase 7**; getting authors through the door precedes
load-testing a system nobody can start.)

**Goal:** a novelist with a GitHub account and no command-line fluency gets a
validated book repository, a published reading site, and — if they want it — a
working collaboration API, by answering questions in a terminal.

The measure of success is not "a script exists". It is that someone who has
never heard of D1, UUIDv7, or a callback URL finishes with a working book and
understands what they now own.

## 1. Delivery

- Package `@authorbot/create` at `apps/create`, bin name `create-authorbot`.
- **Primary entry point is `npx`, not `curl | bash`:**
  `npx @authorbot/create` (documented alongside `pnpm dlx`). The toolchain
  already requires Node, so this costs nothing and avoids piping a remote
  script into a shell.
- A bootstrap one-liner is provided for discoverability, but it is a **thin,
  auditable shim**: it verifies Node ≥ 22 (pointing at nodejs.org if absent),
  then delegates to `npx @authorbot/create`. It must never be the only path,
  must be short enough to read in full, and the docs must show what it does.
  Never instruct users to pipe an unpinned script to `sudo`.
- Zero runtime dependencies beyond what the workspace already ships; the
  wizard must work offline for the parts that do not need the network.

## 2. Interaction rules

These are requirements, not style preferences — they are what separates a
wizard from a trap.

1. **Nothing destructive without explicit confirmation**, and never a default
   of yes for a destructive step. Existing files are never overwritten
   silently; the wizard shows a diff or backs up.
2. **Resumable.** Progress is journalled to `.authorbot-setup.json` in the
   book directory (gitignored). Re-running resumes; each step is idempotent
   and re-entrant. A failure at step 9 never means starting at step 1.
3. **Secrets are never echoed, logged, or written to the journal.** Prompts
   for secret values use hidden input; values are piped directly to their
   destination. The journal records *that* a secret was set, never its value.
4. **`--dry-run` prints the full plan** — every command, file, and remote
   resource — and changes nothing.
5. **`--non-interactive` with a config file** for scripted/CI use; it must
   fail loudly on anything that would otherwise prompt.
6. **Every externally-created resource is reported at the end**, with how to
   delete it. A user who abandons setup must be able to clean up.
7. **Explain before doing.** Each stage states in one or two plain sentences
   what it is about to do and why, in author-facing language ("a database to
   remember who commented" beats "provision D1").
8. Colour and Unicode degrade gracefully; respect `NO_COLOR`; never require a
   terminal wider than 80 columns.

## 2a. Prerequisite: same-origin only (ADR-0019)

Before the wizard is written, the cross-origin deployment path is removed:
CORS and `ALLOWED_ORIGINS` deleted, the session cookie fixed at
`SameSite=Lax`, `return_to` and `api_url` restricted to the API's own origin,
and **base-path support added** so a book can live at `example.com/my-book/`
with its API under the same prefix. CSRF origin checks stay.

This is a prerequisite rather than a side quest: the wizard's hardest question
to ask a novelist would have been "same-origin or split?", and the honest
answer is that there was only ever one right choice. Removing the fork removes
the question.

## 3. Stages

Each stage is independently runnable (`create-authorbot <stage>`) and the
default flow runs them in order, stopping wherever the user chooses.

### 3.1 `doctor` — prerequisites

Detect and report, with install guidance and without installing anything
unasked: Node ≥ 22, pnpm, git, `gh`, `wrangler`, and the auth state of `gh`
and `wrangler`. Offer to run `gh auth login` / `wrangler login` (which are
interactive and browser-driven) rather than attempting to script credentials.
`doctor` also runs standalone against an existing project to diagnose it.

### 3.2 `book` — create the book repository

Prompts: title, slug (offered, derived from title, editable), author name,
license (with a plain-language summary of each option, not just SPDX ids),
and whether to start from the template or an existing directory.

Generates: `book.yml` with a real UUIDv7, an empty `story/` scaffold,
`.github/workflows/`, `README.md`, `.gitignore`. Runs `authorbot validate`
and does not proceed until it passes. Initialises git and makes the first
commit.

**No chapters, and no sample content.** The wizard must never ask an author to
begin by hand-writing frontmatter or block markers — that is the job of the
"New chapter" button (§3.5). A book with zero chapters is a first-class state:
it validates, builds, and publishes, and the site says so plainly rather than
rendering a broken index. (Verified: a chapterless book already validates,
builds, and renders "No chapters published yet.")

`templates/book-repo` is corrected to match: it ships **blank** — empty
`nodes: []` outline, empty `events: []` timeline, no chapters, and therefore
no dangling references. (Today its story files reference its sample chapter,
so deleting that chapter makes the template invalid.) The rich worked example
stays at `examples/book-repo`, which is what tests and documentation use.

Offers to create the GitHub repository via `gh repo create` (asking public or
private, explaining the consequence for a work-in-progress novel).

### 3.3 `publish` — the reading site

Choose GitHub Pages (simplest) or Cloudflare (needed later for the API), with
the trade-off stated. Configures the chosen path: for Pages, enables it and
sets the source to Actions; for Cloudflare, creates the Worker config and
guides `CLOUDFLARE_API_TOKEN` creation. Pins `AUTHORBOT_REF` to the toolchain
commit the wizard itself ran, explaining why pinning matters. Triggers the
first deploy and **waits for it, reporting the live URL** — the stage is not
complete until the site actually loads.

### 3.4 `collaborate` — the API (optional)

Only offered after `publish` succeeds. States plainly what it adds and what it
costs (a Cloudflare account; free tier suffices).

- Creates the D1 database and applies migrations.
- **GitHub App via the manifest flow** (§4) — one browser click, no secret
  copy-pasting.
- Generates `SESSION_SECRET` locally with a CSPRNG and sets it without
  displaying it.
- Deploys the combined same-origin Worker; **verifies health** (`/v1/me`
  returns 401, the OAuth start redirects correctly, the project seeded with
  the user as maintainer) before declaring success.
- Sets `publication.api_url` and rebuilds **only after** health checks pass —
  never leaving sign-in buttons that lead nowhere.

### 3.5 The "New chapter" button — what setup hands you

Setup finishes at a **blank slate the author can sign into and start writing
in**. That requires one capability the collaboration phases deliberately did
not cover: authoring from nothing. Phases 2b–4 give a reader ways to *react*
to existing prose (annotate, vote, claim work). None of that helps an author
facing an empty book, and routing a book's own author through
annotation → vote → work item to write chapter one would be absurd — there is
nobody to vote.

So: a **direct authoring path for editors and maintainers**, which the design
already anticipates as `POST /v1/projects/{p}/chapter-submissions` (§15.2,
currently marked planned in the OpenAPI document).

- **API**: create a chapter (title, optional slug/order, body) and revise an
  existing one, requiring `submissions:write` plus the editor or maintainer
  role. The server generates the chapter id and block markers — an author
  writes prose, never UUIDs. It assigns `order` (last + 10), defaults
  `status: draft`, validates the result exactly as any other write, and
  commits through the same outbox and coordinator path with attribution.
  Every guarantee from earlier phases still applies: base-revision checks,
  one commit per logical mutation, no force updates.
- **UI**: a "New chapter" button in the site's collaboration islands, visible
  only to actors who may use it, opening a plain title-and-prose composer
  (Markdown, no frontmatter, no marker syntax). Saving creates a draft;
  publishing is a separate explicit action. Editing an existing chapter uses
  the same composer.
- Story documents (outline nodes, character files) get the same treatment
  where cheap; if effort forces a choice, **chapters come first** — an author
  with no outline can still write, but an author who cannot write is stuck.

This is what makes the wizard's promise true. Without it, setup produces a
book the author cannot add to except by editing files in a text editor, which
is the exact problem this phase exists to remove.

### 3.6 `agent` — invite an agent (optional)

Mints a scoped agent token, printing it exactly once with a plain warning, and
writes a ready-to-paste prompt for the user's coding agent that includes the
API base, the loop, and the untrusted-input rule. Points at
`examples/agent-workflow.mjs`.

## 4. GitHub App manifest flow

The wizard must not ask a user to copy a client secret out of a web page.

1. Start a **loopback HTTP server on 127.0.0.1** with an unpredictable path
   and a random `state`; bind to localhost only.
2. Open the browser to a page that POSTs a manifest to
   `https://github.com/settings/apps/new?state=<state>` — name, homepage and
   callback URLs, webhook URL and `webhook_secret`, requested permissions
   (`contents: write`, `metadata: read`), `push` event subscription, and
   `request_oauth_on_install`.
3. On approval GitHub redirects to the loopback callback with a temporary
   code; exchange it at `POST /app-manifests/{code}/conversions`, which
   returns the app id, **private key (PEM)**, **client id/secret**, and
   webhook secret.
4. Store them straight into Worker secrets (`wrangler secret put`, piped),
   never to disk, never to the journal, never to the terminal.
5. Send the user to the installation page to install the app on the book
   repository, and **poll until the installation exists**, capturing its id.
6. Verify `state`, enforce a timeout with a clear message, and shut the server
   down on every exit path including failure.

Because a GitHub App can authenticate users (user-to-server) *and* write to
the repository, this replaces the separate OAuth App. Requirements:

- The Phase 2 identity provider gains a **GitHub App user-to-server mode**
  alongside the existing OAuth App mode; both are supported and selected by
  configuration. Existing OAuth App deployments keep working unchanged —
  this deployment model is already in production and must not break.
- User-to-server tokens expire and refresh; the provider must handle that,
  or exchange them for an Authorbot session immediately and not rely on them
  afterwards (preferred — sessions are already the Phase 2 mechanism).

## 5. Failure handling

- Every network call has a timeout and a human-readable failure message
  naming the next action, never a bare stack trace.
- Partial failure prints exactly what exists, what does not, and the resume
  command.
- Known-hostile conditions are detected and explained rather than retried
  blindly: GitHub API outages (`/v1` 5xx or status page), rate limits,
  a callback URL mismatch, a Pages deploy that never starts, an
  already-taken Worker name, and an expired browser step.
- The wizard never leaves a *published* site in a worse state than it found
  it; deploys are verified before the previous state is considered replaced.

## 6. Testing

- Unit: prompt/state machine, journal resume, UUIDv7 generation, slug
  derivation, config rendering, redaction (a property test asserting no
  secret value ever reaches stdout, the journal, or an error message).
- Integration with **fakes**: `gh`, `wrangler`, and the GitHub API replaced by
  in-process fakes (extend the Phase 5 fake GitHub with the manifest
  conversion endpoint). Full happy path, plus: resume after an interrupt at
  each stage boundary, dry-run changes nothing, non-interactive mode,
  destructive-confirmation refusal, manifest-flow timeout and `state`
  mismatch.
- An end-to-end test that runs `book` for real in a temp directory and
  asserts the output validates with `authorbot validate` and builds.
- **Optional live test** (opt-in env var, never in CI) against a throwaway
  GitHub account and Cloudflare account.

## 7. Documentation

- `docs/getting-started.md` is restructured: the wizard becomes the primary
  path; the current manual instructions move to
  `docs/getting-started-manual.md` for people who want to understand or
  automate each step. Neither may drift — a test asserts the wizard's stage
  list and the manual guide's stage headings agree.
- README leads with the one-liner.

## 8. Exit criteria

1. On a clean machine with only Node and git, `npx @authorbot/create`
   produces a validated book repository and a live reading site, with no
   manual file editing and **without the author writing a single line of
   frontmatter, YAML, or Markdown**.
2. The end state is a working blank slate: the author signs in with GitHub,
   clicks **New chapter**, writes prose in a plain composer, saves, and the
   chapter exists as a draft — committed, attributed, and validated — having
   never seen a UUID or a block marker.
3. The collaborate stage produces a deployed API that passes its own health
   checks, with the operator never having typed or seen a secret.
4. Interrupting at any stage boundary and re-running resumes without
   duplicate resources.
5. `--dry-run` changes nothing; `--non-interactive` completes from a config
   file; both are tested.
6. Redaction property test passes: no secret reaches stdout, journal, or
   error output.
7. Existing OAuth-App deployments (the current production one) continue to
   work unchanged.
8. A chapterless book validates, builds, publishes, and renders a welcoming
   empty state; `templates/book-repo` ships blank and self-consistent.
9. No CORS header is emitted under any configuration; a book deployed under a
   base path works end to end (site, API, sign-in, and islands).
10. Workspace green; all Phase 0–5 suites, e2e, and regressions intact.
