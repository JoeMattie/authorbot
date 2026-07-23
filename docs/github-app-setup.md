# Setting up the GitHub App

> **The Authorbot wizard handles this entire setup.** Start with
> `npx @authorbot/create`. It creates the GitHub App through GitHub's manifest
> flow and installs its credentials without asking you to copy a private key.
> This page remains only as a manual recovery and troubleshooting reference.
> We may remove it once those cases are covered elsewhere.

This is the operator's guide to giving an Authorbot deployment read and write
access to its book repository. Everything here is done in a browser and a
terminal - you do not need to read or change any source code.

**What it buys you.** Until the App is configured, the API runs *degraded but
correct*: people can log in, read the book, and file annotations, and those
annotations are recorded durably - but nothing is ever committed to the book
repository, and the chapter projection cannot be rebuilt from GitHub. Once the
App is installed and the three variables below are set, edits become real
commits and the projection tracks the repository.

**It is safe to stop halfway.** Credentials are all-or-nothing: with none of
them set the deployment reports `gitIntegration: "unconfigured"`, with *some*
of them set it reports `"incomplete"`, and with all three set but one of them
malformed it reports `"invalid"`. All three states do no Git work at all. A
half-configured App never half-works.

---

## Before you start

Collect these four facts about your deployment:

| Fact | Example | Where it comes from |
| --- | --- | --- |
| Book repository | `JoeMattie/causal-projector` | The GitHub repo holding `book.yml` and `chapters/` |
| API base URL | `https://causal-projector.joemattie.com` | Your deployed Worker |
| Default branch | `main` | The branch Authorbot commits to |
| Webhook secret | *(a long random string)* | The `WEBHOOK_SECRET` already set on your Worker |

If you do not know your webhook secret, generate a new one now - you will set
it on both GitHub and the Worker in step 3, so they only have to match each
other:

```bash
openssl rand -hex 32
```

> **The live deployment is same-origin.** The reading site and the API are
> served by one Cloudflare Worker (`causal-projector`), so the API base URL is
> the same host as the book - there is no separate `api.` subdomain, and the
> webhook URL below is on the same domain your readers use.

---

## Step 1 - Create the GitHub App

1. Go to **https://github.com/settings/apps** and click **New GitHub App**.
   (For an App owned by an organization instead of your personal account, use
   `https://github.com/organizations/YOUR-ORG/settings/apps` - the rest of this
   guide is identical.)

2. Fill in:

   - **GitHub App name** - anything unique, e.g. `authorbot-causal-projector`.
     This is cosmetic; nothing in the configuration refers to it.
   - **Homepage URL** - your API base URL is fine.

3. **Webhook** - leave **Active** checked, and set:

   - **Webhook URL**: your API base URL followed by `/v1/webhooks/github`, e.g.
     `https://causal-projector.joemattie.com/v1/webhooks/github`
   - **Webhook secret**: the webhook secret from the table above.

   The webhook is how Authorbot learns that somebody edited the book directly
   in GitHub. It is the only thing that triggers a projection refresh - the
   periodic alarm refreshes only when a webhook has marked the projection
   stale - so without it an edit made directly on GitHub is never picked up.

4. **Repository permissions** - set exactly these two, and leave every other
   permission at **No access**:

   | Permission | Access | Why |
   | --- | --- | --- |
   | **Contents** | **Read and write** | Commit annotations and applied edits; read the book |
   | **Metadata** | **Read-only** | Mandatory; GitHub selects it automatically |

   Do not grant anything else. Authorbot never opens issues or pull requests
   in this phase, and a token that cannot do a thing cannot be misused to do
   it.

5. **Subscribe to events** - check **Push**, and nothing else.

6. **Where can this GitHub App be installed?** - **Only on this account** is
   correct unless you are deliberately sharing the App.

7. Click **Create GitHub App**.

---

## Step 2 - Collect the three credentials

You are now on the App's settings page. You need three values.

### `GITHUB_APP_ID`

At the top of the App's **General** page, under **About**, is **App ID** - a
short number like `1234567`. That is `GITHUB_APP_ID`.

### `GITHUB_APP_PRIVATE_KEY`

On the same **General** page, scroll to **Private keys** and click **Generate
a private key**. Your browser downloads a `.pem` file. **This is the only copy
- GitHub will not show it again.**

GitHub's download is in PKCS#1 format, which begins:

```
-----BEGIN RSA PRIVATE KEY-----
```

Authorbot needs **PKCS#8**, which begins `-----BEGIN PRIVATE KEY-----` (no
`RSA`). Convert it:

```bash
openssl pkcs8 -topk8 -nocrypt \
  -in your-app-name.2026-07-20.private-key.pem \
  -out authorbot-key-pkcs8.pem
```

Check that it worked:

```bash
head -1 authorbot-key-pkcs8.pem
# -----BEGIN PRIVATE KEY-----
```

If it still says `BEGIN RSA PRIVATE KEY`, the conversion did not happen.
WebCrypto cannot import a PKCS#1 key, so the deployment will report
`gitIntegration: "invalid"` (step 5) and do no Git work.

> **Handling the key.** It is a credential equivalent to write access to your
> book. Do not commit it, do not paste it into a chat or an issue, and delete
> the local files once step 3 is done. If it ever leaks, return to **Private
> keys**, generate a new one, and delete the old - the old key stops working
> immediately.

### `GITHUB_INSTALLATION_ID`

Install the App on the book repository:

1. In the App's left sidebar, click **Install App**.
2. Click **Install** next to the account that owns the book repository.
3. Choose **Only select repositories**, pick your book repository, and click
   **Install**.

You land on a settings URL ending in a number:

```
https://github.com/settings/installations/87654321
                                           ^^^^^^^^
```

That trailing number is `GITHUB_INSTALLATION_ID`. If you navigated away, get
it back from **https://github.com/settings/installations** → **Configure** next
to the App, and read the number off the URL.

> Note that the **App ID** and the **Installation ID** are different numbers.
> Mixing them up is the most common setup error; the symptom is a `404` when
> the Worker tries to mint a token.

---

## Step 3 - Set the values on the Worker

> **Edit YOUR deployment's config, not `apps/api/wrangler.jsonc`.**
> `apps/api/wrangler.jsonc` is the repository's development/reference config.
> It declares `name: "authorbot-api"`, has no `assets` binding, and
> deliberately omits `AUTH_MODE`, `GITHUB_CLIENT_ID` and
> `GITHUB_REDIRECT_URI`. A real deployment is the **combined** config
> described in `docs/getting-started.md` §3b - the one that owns
> `assets: { "directory": "./_site" }`, `AUTH_MODE: "github"` and the OAuth
> vars, and whose `name` is your live Worker (`causal-projector` for this
> deployment). Deploying `apps/api/wrangler.jsonc` would either create a
> *second* Worker bound to the same production D1 that 500s on every request
> (`AUTH_MODE must be "dev" or "github"`), or - if you pointed it at the live
> Worker - replace the live vars set wholesale, wiping the static site and the
> auth/OAuth configuration. `wrangler deploy` replaces plain-text `vars`
> entirely; secrets survive, vars do not.
>
> Everywhere below, `--name YOUR-WORKER` targets the right Worker regardless
> of your current directory. Substitute your Worker's name.

Two of the three values are non-secret identifiers, and one is a secret.

```bash
# Secret - prompts for the value, or pipe the file in as shown below.
wrangler secret put GITHUB_APP_PRIVATE_KEY --name YOUR-WORKER < authorbot-key-pkcs8.pem

# Also set the webhook secret if you generated a new one in "Before you start".
wrangler secret put WEBHOOK_SECRET --name YOUR-WORKER

# And a SEPARATE secret for the CI publication callback (see below).
openssl rand -base64 48 | wrangler secret put PUBLICATION_SECRET --name YOUR-WORKER
```

#### Why `PUBLICATION_SECRET` is not `WEBHOOK_SECRET`

Two protocols verify HMACs against a shared secret: GitHub's `push` webhook,
and the book repository's CI reporting a finished deployment to
`POST /v1/publications`. They live in **different trust domains**.
`WEBHOOK_SECRET` is pasted into the GitHub App's webhook configuration;
`PUBLICATION_SECRET` goes into the book repository's **Actions secrets**, where
every workflow - and anyone who can get a workflow to run - is within reach of
it.

While the two were one value, whoever held the CI copy could forge `push`
webhooks (driving projection rebuilds at will), and whoever held GitHub's copy
could forge deployment reports. Setting both keeps each blast radius to its own
domain.

If `PUBLICATION_SECRET` is unset the API falls back to `WEBHOOK_SECRET`, so an
existing deployment keeps reporting while you rotate. To rotate: set
`PUBLICATION_SECRET` on the Worker, put the same value in the book repo's
Actions secrets, confirm a deployment reports, and you are done - the GitHub
webhook secret never has to change.

The two ids are ordinary variables. Add them to the `vars` block of **your
deployment's** wrangler config:

```jsonc
  "vars": {
    // ...existing entries - keep AUTH_MODE, the OAuth vars and everything
    // else that is already there; a deploy replaces this whole block ...
    "GITHUB_APP_ID": "1234567",
    "GITHUB_INSTALLATION_ID": "87654321"
  }
```

Check that `PROJECT_REPO` in the same `vars` block matches your book
repository exactly (`owner/name`), and that `DEFAULT_BRANCH` matches the branch
you want commits on.

> **`DEFAULT_BRANCH` after first boot.** The project row's branch is seeded
> from `DEFAULT_BRANCH` on the very first boot and is not updated afterwards.
> Authorbot reads and commits to the branch recorded on the project row, so
> changing `DEFAULT_BRANCH` later moves nothing on its own. To migrate the
> book to a different default branch, change it in the database as well.

While you are in this file, make sure the coordinator's maintenance cron is
present - it is what arms the periodic alarm that sweeps expired leases and
drains any backlog on a deployment that receives no webhooks yet:

```jsonc
  "triggers": {
    "crons": ["* * * * *"]
  }
```

Now delete your local key files:

```bash
rm your-app-name.*.private-key.pem authorbot-key-pkcs8.pem
```

---

## Step 4 - Apply database migrations, then deploy

**Order matters.** Apply migrations *before* deploying the new Worker code:
the project endpoint reads a table that the migration creates, so a Worker
deployed ahead of its schema will fail on that route.

```bash
wrangler d1 migrations apply authorbot --remote
wrangler deploy --name YOUR-WORKER
```

Deploy from the directory holding *your* combined config (see the box in step
3), never from `apps/api/`.

---

## Step 5 - Turn on committing

Configuration alone does not change behaviour: the deployment keeps queueing
mutations until you switch the mirror mode. This is deliberate, so you can
verify credentials before anything writes to your book.

First confirm the App is recognized. Open your project in the API:

```bash
curl -s https://causal-projector.joemattie.com/v1/projects/YOUR-PROJECT-ID \
  -H "Cookie: <your session cookie>" | jq .gitIntegration
```

- `"configured"` - all three values are present and structurally valid: two
  numeric ids and a PKCS#8 PEM. Continue.
- `"invalid"` - all three are present but at least one cannot work. The usual
  causes are a private key still in PKCS#1 form (see step 2) or the App ID
  pasted where the Installation ID belongs (see step 2). Fix and redeploy.
- `"incomplete"` - one or two of the three are set. Recheck step 3.
- `"unconfigured"` - none are set. The deploy did not pick up your changes.

This check is structural, not a live credential test: it proves the values are
shaped correctly, not that GitHub accepts them. Step 6 is what proves that.

Then set `MIRROR_MODE` to `durable` in the `vars` block of your deployment's
config and deploy again:

```jsonc
    "MIRROR_MODE": "durable",
```

```bash
wrangler deploy --name YOUR-WORKER
```

Queued mutations drain on the next coordinator alarm (every
`COORDINATOR_ALARM_SECONDS`, 60 by default), which the maintenance cron from
step 3 keeps armed - so a backlog accumulated while you were setting this up
commits on its own, and you do not need to replay anything. Without that cron
entry, nothing drains until the next mutation arrives.

---

## Step 6 - Verify

1. **A write becomes a commit.** File an annotation through the site, wait a
   few seconds, and look at the book repository's commit history. You should
   see a commit authored by *Authorbot* touching
   `.authorbot/annotations/<id>/annotation.md`, with trailers naming the
   operation, the annotation, and the human actor. The Git author is always
   the service - the human is credited in the commit trailers and in the
   `.authorbot/attribution/` records, not in the Git identity.

2. **A push is noticed.** Edit a chapter directly on GitHub and commit. Within
   a few seconds the site should reflect the change. In the App's **Advanced**
   tab, **Recent Deliveries** shows the `push` event and the response
   Authorbot returned - a `401` there means the webhook secret on GitHub and
   `WEBHOOK_SECRET` on the Worker do not match.

---

## Troubleshooting

**`gitIntegration` stays `"unconfigured"` after a deploy.**
`wrangler secret put` and `vars` edits both need a deploy to take effect for
the running Worker. Confirm with `wrangler secret list` (it shows names, never
values) that `GITHUB_APP_PRIVATE_KEY` is present.

**`gitIntegration` is `"incomplete"`.**
Exactly one or two of `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`,
`GITHUB_APP_PRIVATE_KEY` are set. Usually a `wrangler secret put` that was
never deployed, or a `vars` edit made in the wrong config file - see the box
in step 3.

**`gitIntegration` is `"invalid"`.**
All three are present but one is malformed. In order of likelihood: the
private key is still PKCS#1 (`BEGIN RSA PRIVATE KEY` - see step 2); the App ID
and the Installation ID were swapped; a value picked up stray characters when
it was pasted. Both ids must be digits only.

**Secrets or vars landed on the wrong Worker.**
A bare `wrangler secret put` or `wrangler deploy` acts on whatever config is
in the current directory, and may offer to create a *new* Worker. Always pass
`--name YOUR-WORKER`, and never deploy `apps/api/wrangler.jsonc` - see the box
in step 3.

**Nothing commits, but `gitIntegration` says `"configured"`.**
`MIRROR_MODE` is probably still `queue`. See step 5. The work is not lost;
switching the mode drains the backlog.

**Commits fail with a permissions error.**
The installation does not have **Contents: read and write** on this
repository, or the repository was never added to the installation. Go to
**https://github.com/settings/installations** → **Configure**, confirm the
book repository is selected, and re-check the App's permissions. Note that
changing an App's permissions after installation requires *accepting* the new
permissions on the installation - GitHub emails the owner a request, and the
old permissions apply until it is accepted.

**Commits fail on a protected branch.**
Authorbot commits directly to the default branch and never force-pushes. A
branch protection rule requiring pull requests or status checks will block it.
Either exempt the App from the rule, or relax the rule - pull-request mode is
a later phase.

**The webhook shows `401` in Recent Deliveries.**
The secrets do not match. Set the same string in both places: the App's
**Webhook secret** field and `wrangler secret put WEBHOOK_SECRET`.

**The project reports a divergence and refuses edits.**
Authorbot found the repository in a state it cannot reconcile - usually a
chapter's `revision` moved backwards, or block ids that annotations point at
have vanished. Reads keep working; only prose writes are refused. Fix the
repository, then have a maintainer clear the flag:

```bash
curl -X POST https://causal-projector.joemattie.com/v1/projects/YOUR-PROJECT-ID/divergence/clear \
  -H "Content-Type: application/json" \
  -H "Cookie: <maintainer session cookie>" \
  -d '{"reason": "restored chapter 004 revision after a bad manual edit"}'
```

By default this also re-reads the repository and re-projects from it. Pass
`"resync": false` if you have another reason to clear the flag without
accepting the repository's current state.

---

## Reference

### Variables

| Name | Kind | Required | Meaning |
| --- | --- | --- | --- |
| `GITHUB_APP_ID` | var | for Git integration | The App's numeric **App ID** |
| `GITHUB_INSTALLATION_ID` | var | for Git integration | The numeric id of the App's installation on the book repo |
| `GITHUB_APP_PRIVATE_KEY` | **secret** | for Git integration | PKCS#8 PEM private key |
| `WEBHOOK_SECRET` | **secret** | yes | Shared with GitHub's webhook config. Verifies `push` webhooks and nothing else |
| `PUBLICATION_SECRET` | **secret** | recommended | Shared with the book repository's CI. Verifies `POST /v1/publications` deployment reports. Falls back to `WEBHOOK_SECRET` when unset - see below |
| `PROJECT_REPO` | var | yes | `owner/name` of the book repository |
| `DEFAULT_BRANCH` | var | no (default `main`) | Branch Authorbot reads and commits to |
| `MIRROR_MODE` | var | no (default `queue`) | `durable` to commit through the coordinator |
| `COORDINATOR_ALARM_SECONDS` | var | no (default `60`) | Maintenance cadence: backlog drain, lease sweep, projection refresh |

### What Authorbot does with the credentials

- The private key signs a short-lived (9-minute) App JWT, which is exchanged
  for an installation token. Tokens are cached in memory only, for less than
  an hour, and refreshed automatically.
- **No installation token or private key is ever logged, stored in the
  database, or returned in any API response** - including error messages.
- Every ref update is sent with `force: false`. Authorbot cannot force-push,
  and a conflicting concurrent push produces a retry or a reported conflict,
  never an overwrite.
