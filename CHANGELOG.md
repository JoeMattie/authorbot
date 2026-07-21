# Changelog

What changed in each release, and why it mattered. Written for the person
deciding whether to upgrade, not for the person who wrote the commit — so a
release that fixed something serious says what was broken and what it did to
you, rather than naming the function that changed.

Every published package shares this version. A tag builds, tests, and publishes
all of them together, so `@authorbot/cli@0.1.15` and `@authorbot/api@0.1.15` are
always the same commit.

## 0.1.16

- **`unpublish` and `teardown`.** `npx @authorbot/create unpublish` removes the
  Worker, the database and the GitHub App, leaving your repository and its
  history alone so `publish` can put the site back. `teardown` also deletes the
  remote repository, then tells you what to type to remove the local copy — it
  never deletes files on your own disk.
- **The wizard is drawn rather than printed**: boxed stage headings, an arrow
  for steps, and check/triangle/cross for outcomes — each degrading to plain
  ASCII under `NO_COLOR`, in a pipe, or on a dumb terminal.
- **A changelog**, here and inside every published package.

## 0.1.15

- **The wizard can tell whether your book can actually save anything.** It used
  to finish by checking that the API refused an anonymous caller, which a
  completely unusable deployment does just as correctly as a healthy one — see
  0.1.14. New `GET /v1/health` reports whether the GitHub App is usable, and
  `collaborate` refuses to switch a book's collaboration controls on when the
  answer is no.

## 0.1.14

- **Collaboration never worked on any book this wizard created.** The Worker
  needs three GitHub App credentials and received two: the app id was read,
  used to poll for the installation, and then dropped. With one missing it does
  no Git work at all — so chapters could not be saved, the projection never
  ran, and settings could not read the book's own `book.yml`, while every
  read-only page answered perfectly. If you set up a book before this release,
  re-run `create-authorbot collaborate`.
- **You can sign out.** There was no way to. Two routes created a session and
  none ended one, so a reader on a shared machine stayed signed in until the
  cookie expired.
- **An account strip in the site header** — sign in, sign out, and the way into
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
  API refused every anonymous read — and the site gives up and renders nothing
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
  still had the new hostname cached as non-existent — which the wizard's own
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
  ENOENT — including for the `directory: ./my-book` its own example config
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
