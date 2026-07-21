# Collaboration is switched on over an integration that cannot work

**Status:** in progress
**Found:** 2026-07-21, first end-to-end run of `npx @authorbot/create` on a real
book (`causal-projector`) by the maintainer.

## The headline

`collaborate` completes, prints "Collaboration is on", and leaves a book where
**no collaborative action can succeed**. Chapters cannot be written, settings
cannot be read, the work queue is permanently empty. The site says everything is
fine because nothing it renders depends on the part that is broken.

The cause is one dropped value, and everything else here is either a symptom of
it or something that hid it.

---

## 1. `GITHUB_APP_ID` is never set on the Worker — ROOT CAUSE

The Worker treats its three GitHub App credentials as all-or-nothing
(`worker.ts:94`): with any one missing it reports `gitIntegration: "incomplete"`
and does **no Git work at all**.

Deployed bindings on a wizard-created book:

```
GITHUB_APP_PRIVATE_KEY   ✓ (secret)
GITHUB_INSTALLATION_ID   ✓ (var)
GITHUB_APP_ID            ✗ MISSING
```

`collaborate.ts` reads `conversion.appId` from the manifest conversion, uses it
to poll for the installation, and then discards it — `ensureGitHubApp` returns
only `{ clientId, installationId }`. It is never journalled, never written to
`wrangler.jsonc`, never set as a secret.

**Every book this wizard has ever created has collaboration enabled over an
integration that cannot commit, cannot project, and cannot read its own
`book.yml`.**

Observed downstream, all from this one cause:

- New chapter: "Still syncing. Your text was accepted — reload the page in a
  moment to see where it landed", forever. Outbox rows sit at
  `status=pending, attempts=0` — never even attempted.
- Settings: "this book's book.yml has not been projected from its repository
  yet, so settings cannot be read or changed."
- Settings buttons (open/change policy) do nothing.
- Work queue: "no work items are ready" — correct, but only because nothing can
  ever reach it.

**Fix (done, unreleased):** thread `appId` from the conversion through
`AppCredentials` → journal (`collaborate.appId`, validated on read like every
other journal field) → `CollaborationSettings` → `GITHUB_APP_ID` in the
generated `wrangler.jsonc`. The reuse path recovers it from the journal.

**Still to do:** a test that the generated config carries all three credentials,
and a check in `collaborate` that refuses to report success when the API reports
`gitIntegration: "incomplete"` — see §7.

---

## 2. Nothing detected it

The wizard's final health check asks `/v1/me` for a 401 and stops there. A
Worker with no Git integration answers that perfectly. So the wizard verified
the half that worked and reported the whole thing good.

The coordinator already exposes `gitIntegration` via its `status` action. The
health check should assert it is not `"incomplete"` before switching the site
over.

---

## 3. Health check has no retry — false failures

`collaborate` deploys the Worker, then immediately checks `/v1/me`. The Worker
has not always propagated, so the check gets a 404 and the stage fails with
"The API ... answered 404 instead of refusing an anonymous caller (401)".

Cost so far: two failed runs for the maintainer, one for me on a previous book.
Every one passed on re-run with no code change.

**Fix:** poll for a few seconds before declaring failure, as `publish`'s wait
loop does.

---

## 4. Same DNS false-failure, one stage later

`publish` consults DNS-over-HTTPS before declaring a deploy failed (0.1.7),
because a brand-new hostname is often negatively cached locally — including by
the wizard's own domain-free check moments earlier. `collaborate`'s health check
was never given the same fallback, so the identical condition still produces a
false failure there.

**Fix:** share one "is this really unreachable, or just unresolvable from here"
helper between both stages.

---

## 5. The wizard does not exit

After a full interactive run the process prints everything, then hangs in
`ep_poll` with no children and no open sockets. `fd 0 → /dev/pts/N`: a readline
interface has left `process.stdin` referenced, so Node has nothing to do and
still will not exit. Ctrl-C is required.

Mirror image of the 0.1.7 bug, where an unref'd timer let the process exit too
*early*. Only the half in front of me got fixed.

**Attempted fix — UNVERIFIED.** `process.stdin.pause()` in a `finally` at the
end of `bin.ts`. Harmless, but the hypothesis did not survive testing: an
isolated `TtyPrompter` run under a pty exits cleanly **with and without** the
pause, so a readline-held stdin handle is *not* the cause. Whatever holds the
loop open is something else, and the hang has not been reproduced since.

Left in place because it costs nothing, but this item is **not fixed**. Next
step is a reproduction: full interactive run through `collaborate` (loopback
server, browser opener, installation polling) rather than a single prompt.

---

## 6. Signed-in state has almost no chrome

Separate from the root cause, and would still be wrong after it is fixed.

- **No sign-out. Anywhere.** The API has exactly two auth routes —
  `/v1/auth/github` and `/v1/auth/github/callback`. There is no logout endpoint
  and no session-revocation code, though `human_sessions` rows exist and are
  revocable. Once signed in, a reader cannot sign out on a shared machine.
- **No sign-in on an empty book.** `<authorbot-new-chapter>` deliberately
  renders nothing when signed out; the only "Sign in with GitHub" lives in the
  collab island, which only appears on chapter pages. A new book has no
  chapters, so there is no sign-in anywhere — and the wizard signs off by
  telling the author to "sign in with GitHub, and press New chapter".
  Direct URL that works: `/v1/auth/github?return_to=<url>`.
- **Settings and Work are unreachable.** Both return 200. `Base.astro:43-46`
  hardcodes three nav items — Outline, Timeline, Characters. Neither page is
  linked from anywhere.

These are one theme: auth and admin affordances were built for a reader looking
at a populated book, and no route into them exists for the states every book
passes through.

**Open design question for the maintainer:** a small authenticated header (who
you are · Sign out · Settings · Work), rendered once collaboration is on, rather
than patching each entry point separately.

---

## 7. Observability is off, so failures are unreadable

The generated `wrangler.jsonc` never enables observability. The wizard's own
failure text says "check the Worker's logs in the Cloudflare dashboard" — there
are none. Diagnosing §1 needed `wrangler tail` and direct D1 queries.

**Fix:** `"observability": { "enabled": true }` in the generated config.

---

## Order of work

1. **`GITHUB_APP_ID`** — done, needs tests (§1)
2. **Health check asserts `gitIntegration`** (§2) — so this class of failure can
   never again be reported as success
3. **Health check retry + shared DNS fallback** (§3, §4)
4. **Wizard exits** (§5)
5. **Observability on** (§7)
6. **Auth/admin chrome** (§6) — needs a design decision first

1–5 and 7 ship together. 6 waits on the maintainer.

## Not in scope

- Cloudflare's analytics beacon is blocked by the site's CSP. Real, harmless,
  unrelated.
- The GitHub App name renders as `the-causal-causal-projector` — GitHub
  slugifies `The Causal (causal-projector)`. Correct but redundant; fold the
  title/slug overlap into the name later.
- The e2e suite runs a real `npm install` and is no longer hermetic.
