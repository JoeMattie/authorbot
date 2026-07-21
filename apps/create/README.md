# @authorbot/create

Guided setup for an [Authorbot](https://github.com/JoeMattie/authorbot) book
project — a Git-backed editorial control plane and collaboration protocol for
serial books.

```sh
npx @authorbot/create
```

Answer three questions and you get a book repository that validates, a live
reading site, and — if you want it — a collaboration API where you write
chapters in your browser.

> Authorbot manages authorship. It does not perform authorship.

## What it does

Each stage runs on its own (`create-authorbot <stage>`), and you can stop
after any of them:

| Stage | What you get |
|---|---|
| `doctor` | checks Node, git, `gh`, `wrangler` and offers to log you in |
| `book` | a book repository — title, address, licence, and the files Authorbot needs |
| `publish` | a live reading site on Cloudflare, verified before it says so |
| `collaborate` | sign-in, annotations, votes, and a work queue on the same address |
| `agent` | a scoped token so a software agent can contribute |
| `upgrade` | moves an existing book to a newer Authorbot, as a pull request |

**No chapters are created.** A book starts empty on purpose: you write the
first chapter in the browser, with a title and a box for prose, and Authorbot
writes the identifiers and structure. You should never have to hand-write
frontmatter.

## What it asks of you

A GitHub account, and for the collaboration stage a Cloudflare account — free
tiers cover a book of this size. You bring your own accounts and your own
repository; nothing is hosted for you, and there is no service to depend on.

## How it treats your machine

- **Nothing destructive without asking**, and never a default of yes.
- **Resumable.** Progress is journalled, so a failure at step nine does not
  mean starting at step one.
- **Secrets are never echoed, logged, or written to disk.** The GitHub App is
  created through GitHub's manifest flow, so its credentials go straight into
  your Worker's secrets — you never see or type them.
- `--dry-run` prints the whole plan and changes nothing.
- Everything it creates in your accounts is listed at the end, with how to
  remove it.

## Documentation

- [Getting started](https://github.com/JoeMattie/authorbot/blob/main/docs/getting-started.md)
- [How it works](https://github.com/JoeMattie/authorbot/blob/main/docs/how-it-works.md)
- [Source and issues](https://github.com/JoeMattie/authorbot)

MIT licensed.
