# Local authoring

`authorbot dev` runs a complete Authorbot book on your machine. It needs Node
22.13 or newer and Git. It doesn't need a Cloudflare account, a GitHub
connection, or a network connection after the packages are installed.

Cloudflare is still the production runtime. Local authoring uses the same API,
database schema, publisher, browser UI, and Git commit path, but swaps D1 for
Node's built-in SQLite and the GitHub writer for a local worktree.

## Start it

From a book repository:

```sh
npx authorbot dev
```

Or point it at a book:

```sh
npx authorbot dev ../my-book --port 4321 --open
```

The server binds to `127.0.0.1` only. The browser URL is
`http://localhost:4321` by default. The terminal prints a one-use maintainer
sign-in URL and the path of the managed worktree.

Authorbot doesn't work in your main checkout. It creates:

- a branch named `authorbot/local/<book>-<id>`
- a persistent Git worktree in your OS state directory
- a private SQLite database, secrets, lock, and session manifest beside that
  worktree
- a private starter agent environment file

On Linux, the default state root is
`$XDG_STATE_HOME/authorbot/books/` or
`~/.local/state/authorbot/books/`. Directories use mode `0700`. The database,
secrets, token environment, and manifest use mode `0600`.

## The Git rule

The managed worktree is the book Authorbot is serving. You can edit Markdown
or YAML there with any editor. The preview sees those saves right away.

API writes pause while the worktree is dirty. Authorbot won't mix a browser or
agent write with files you haven't committed, and it won't commit your editor
saves for you. Commit the intended files yourself:

```sh
git -C /path/printed/by/authorbot status
git -C /path/printed/by/authorbot add chapters/001-example.md
git -C /path/printed/by/authorbot commit -m "Revise chapter opening"
```

Once the worktree is clean, Authorbot accepts the new forward-moving `HEAD`,
reconciles its projection, and resumes API writes. A detached `HEAD`, another
branch, or a backwards reset stops reconciliation. Authorbot reports the
problem instead of moving the branch for you.

## Humans and agents

The one-use sign-in URL creates the local maintainer session. Its actor uses
the portable `local:` namespace and the display name from `git user.name`.
The browser cookie has a per-book name, so two books on localhost don't sign
each other in.

The `/v1/dev/login` role picker isn't exposed by local authoring. It remains
available to the automated API test harness only. Logging out stays logged
out. Stop and restart `authorbot dev` when you want a new one-use sign-in URL.

Local mode also creates a `Local collaborator` token with the full editor
capability set (control-plane permissions aren't included). To load it into
an agent shell:

```sh
eval "$(authorbot dev agent-env)"
```

`agent-env` is intentionally explicit because it prints a credential. The
stored file stays in the private state directory, never in the book
repository. You can still create narrower, named tokens in Settings.

## Commands

```sh
authorbot dev [path]
authorbot dev status [path]
authorbot dev status [path] --json
authorbot dev agent-env [path]
authorbot dev reset [path] --yes
authorbot dev pr [path]
authorbot dev clean [path]
```

`status` reports the URL, PID, source version or commit, managed branch,
worktree, dirty state, projection state, build error, and local-state path.

`reset` deletes the local SQLite database, browser sessions, secrets, and
local tokens. It records Git state before and after, and refuses to report
success if Git changed. It doesn't reset, delete, or rewrite a Git file or
ref.

`pr` validates the book, makes a production static build, pushes the managed
book branch without force, and creates a draft pull request (or prints the
existing open one). It doesn't merge or deploy. The command needs an `origin`
remote and an authenticated `gh` CLI.

`clean` removes a worktree and branch only after Git proves the branch is
reachable from the configured base branch. It uses `git branch -d`, never a
force delete.

## Working on Authorbot itself

From an Authorbot source checkout:

```sh
pnpm dev:book -- ../causal-projector
```

A book can hand execution to another Authorbot checkout without changing its
package pins, lockfile, or Wrangler file:

```sh
authorbot dev ../causal-projector --authorbot-source ../authorbot
```

These source-dogfood sessions mark the book as a sandbox. `authorbot dev pr`
is disabled unless the session was started with `--promote-book`. Authorbot
source changes and book changes stay in separate repositories and branches.

## What runs in the browser

Astro and Vite are the only browser origin. They proxy `/v1` to a private
loopback API and map the stable production island asset names to their source
modules. CSS and UI source changes use Vite's normal reload path. Book changes
reload the data module. If a book reload fails, the terminal and local toolbar
show the error while the last good model stays in memory.

The local toolbar shows the branch, dirty state, projection state, build
state, sign-in link, and the agent setup command. Production builds don't
contain the toolbar or the development CSP changes.

## Safety boundaries

- The HTTP bridge rejects unexpected Host headers.
- One process lock owns each worktree and database pair.
- The state manifest binds the book ID, repository common directory, base
  SHA, managed branch, migration checksums, and Authorbot source identity.
- The API writer stages only the files for its operation.
- Dirty-tree, wrong-branch, and non-fast-forward failures stay recoverable.
- `dev pr` can only push the managed book branch. It doesn't know how to push
  the Authorbot source checkout.
- Operational SQLite state (sessions, leases, votes, and tokens) never enters
  a Git commit or pull request.
