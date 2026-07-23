# @authorbot/api

Phase 2 API (contract §3-§6): a Hono 4 app targeting Cloudflare Workers with
all business wiring runtime-agnostic - the same `createApp(deps)` serves under
`wrangler dev` (D1) and in Node tests (better-sqlite3).

## Layout

| Path | What |
|---|---|
| `src/app.ts` | `createApp(deps)` / `createApi(deps)` - routes, auth, idempotency, command flow |
| `src/worker.ts` | Worker entry: builds deps from bindings, lazy first-boot seed |
| `src/auth.ts` | Bearer agent tokens + signed session cookies, scope guard |
| `src/idempotency.ts` | `Idempotency-Key` claim / replay / 409-on-mismatch |
| `src/projection/` | `BookRepoReader`, `rebuildProjection`, in-memory block index |
| `src/projection/local-fs.ts` | Node-only local FS reader (`@authorbot/api/local`) |
| `src/mirror.ts` | Inline repo-coordinator wiring (`@authorbot/api/local`) |
| `src/seed.ts` | Idempotent first-boot seed (project + initial maintainer) |
| `src/dev-server.ts` | Node dev entry: full wiring incl. `BOOK_REPO_PATH` (`@authorbot/api/local`) |
| `scripts/smoke.sh` | Smoke test against a running `wrangler dev` |
| `test/integration/` | Contract §7 exit-criteria suite (real git clone + LocalGitAdapter) |

## Local dev (wrangler + local D1)

```sh
# 0. one-time: local secrets for wrangler dev (.dev.vars is gitignored)
cp apps/api/.dev.vars.example apps/api/.dev.vars

# 1. apply migrations to the local D1 database
pnpm --filter @authorbot/api migrate:local     # wrangler d1 migrations apply authorbot --local

# 2. start the worker (AUTH_MODE=dev; secrets come from .dev.vars)
pnpm --filter @authorbot/api dev               # http://127.0.0.1:8787

# 3. smoke it
pnpm --filter @authorbot/api smoke
```

Dev-login and first requests by hand:

```sh
# login as a maintainer (dev mode only; the route does not exist in github
# mode). Like every cookie-minting/cookie-authed mutation it requires an
# Origin header matching an allowed origin or the API's own origin (CSRF).
curl -c /tmp/authorbot.jar -X POST http://127.0.0.1:8787/v1/dev/login \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:8787' \
  -d '{"login":"joe","role":"maintainer"}'

curl -b /tmp/authorbot.jar http://127.0.0.1:8787/v1/me

# {projectId} accepts the project UUID or its slug
curl -b /tmp/authorbot.jar http://127.0.0.1:8787/v1/projects/hollow-creek-anomaly/chapters

# mint an agent token (plaintext appears exactly once in this response).
# Cookie-authed mutations need an Origin header (CSRF check, contract 2b §3):
curl -b /tmp/authorbot.jar -X POST \
  http://127.0.0.1:8787/v1/projects/hollow-creek-anomaly/agent-tokens \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -H 'Origin: http://127.0.0.1:8787' \
  -d '{"name":"my-agent","scopes":["chapters:read","annotations:read","annotations:write"]}'

# use it
curl -H "Authorization: Bearer authorbot_..." \
  http://127.0.0.1:8787/v1/projects/hollow-creek-anomaly/chapters
```

### Story bible reads for agents

A credential with exactly `chapters:read` can read the validated planning
documents configured by `book.yml` without repository credentials or guessed
paths:

```sh
curl -H "Authorization: Bearer authorbot_..." \
  http://127.0.0.1:8787/v1/projects/hollow-creek-anomaly/story/outline
curl -H "Authorization: Bearer authorbot_..." \
  http://127.0.0.1:8787/v1/projects/hollow-creek-anomaly/story/timeline
curl -H "Authorization: Bearer authorbot_..." \
  'http://127.0.0.1:8787/v1/projects/hollow-creek-anomaly/story/characters?limit=20'
```

Outline and timeline are single validated documents. Characters are cursor
paginated, with at most 20 repository blobs read per request. Follow
`nextCursor` until it is `null`. Each work-item claim also includes
`context.storyApi` with these canonical same-origin paths; `storyRefs` remain
stable story ids to look up in the returned documents. The API never accepts a
caller-supplied repository path here: it uses `planning.outline`,
`planning.timeline`, and `planning.characters_glob` from projected `book.yml`
(or their canonical defaults), rejects traversal, and refuses invalid or
unsafe committed documents rather than returning partial canon.

**Worker limitation:** under `wrangler dev` the app runs reader-less - the
Worker has no book-repository access until the Phase 5 GitHub reader/writer,
so the chapters projection is empty, webhook pushes are recorded `ignored`,
and `MIRROR_MODE` is effectively queue-only. To exercise book-repo content
locally, use the Node dev entry, which implements contract §6's
`BOOK_REPO_PATH` binding (reader + inline `LocalGitAdapter` mirror + local
SQLite):

```sh
pnpm --filter @authorbot/api build
BOOK_REPO_PATH=$PWD/examples/book-repo AUTH_MODE=dev DEV_LOGIN_ENABLED=true \
SESSION_SECRET=dev WEBHOOK_SECRET=dev PROJECT_SLUG=hollow-creek-anomaly \
PROJECT_REPO=JoeMattie/causal-projector INITIAL_MAINTAINER=github:JoeMattie \
pnpm --filter @authorbot/api dev:node          # http://127.0.0.1:8788
# optional: SQLITE_PATH=/tmp/authorbot-dev.sqlite (default is in-memory),
#           MIRROR_MODE=queue, PORT=8788,
#           API_BASE_PATH=/my-book (only when the book is served under a
#           subpath - see below)
```

Note: mutations commit to the work tree at `BOOK_REPO_PATH` - point it at a
throwaway clone (e.g. `git clone examples/book-repo /tmp/book-repo-dev`)
rather than your checkout if you don't want dev commits in it.

Configuration (contract §6): vars in `wrangler.jsonc` (`AUTH_MODE`,
`PROJECT_SLUG`, `PROJECT_REPO`, `INITIAL_MAINTAINER`, `DEFAULT_BRANCH`,
`MIRROR_MODE`, `API_BASE_PATH`); secrets via `wrangler secret put
SESSION_SECRET` / `WEBHOOK_SECRET` / `GITHUB_CLIENT_SECRET` (github mode adds
`GITHUB_CLIENT_ID`, `GITHUB_REDIRECT_URI`). `.dev.vars` holds throwaway
dev-only values.

## Site ↔ API pairing: same-origin + CSRF (ADR-0019)

A site built with `authorbot build --api-url <path>` (or `publication.api_url`
in `book.yml`) mounts annotation islands on chapter pages that call this API
with `credentials: "include"` - see the root `README.md` for the end-to-end
local-dev recipe and `packages/publisher/README.md` for the build side.

**There is exactly one supported deployment shape: same origin.** The
published site and this API are served from one host, and `api_url` is a
root-relative path. Consequently:

- **No CORS.** No `Access-Control-*` header is emitted under any
  configuration, and there is no `ALLOWED_ORIGINS` variable. A cross-origin
  browser request fails at the browser, which is the correct outcome
  (ADR-0019 §1).
- **Session cookie** is always `HttpOnly; Secure; SameSite=Lax` - the
  `SameSite=None` path is gone, so the weaker posture is unreachable by
  configuration (§2).
- **OAuth `return_to`**: `GET /v1/auth/github?return_to=<url>` accepts only
  absolute http(s) URLs within this API's own origin (exact origin prefix
  match; `javascript:` and open-redirect shapes are rejected with 400) and
  redirects there after the callback (§4).

### Base path (`API_BASE_PATH`)

A book may live under a subpath: `API_BASE_PATH=/my-book` serves every route
under `/my-book/v1/*`, matching a site published at `example.com/my-book/`
with `publication.api_url: "/my-book"`. Absent (or `/`) mounts the API at the
origin root, which is what the live deployment does. The value is normalized
and validated at boot - an absolute URL, a dot segment, or a stray query
string throws rather than serving the API where the site will never look
(ADR-0019 §6).

### CSRF (retained)

Same-origin is not the same as no CSRF risk, so the origin check stays:
cookie-authenticated mutations - and `POST /v1/dev/login`, which mints the
cookie - must send an `Origin` (or `Referer`) header matching this API's own
origin; missing or foreign origins get a 403 `csrf-origin-mismatch` problem.
Browsers send `Origin` automatically; non-browser cookie clients (curl) must
add it explicitly. JSON routes additionally require
`Content-Type: application/json`, so cross-site `text/plain` "simple
requests" never reach a handler. Bearer-token requests are exempt (no
ambient credential).

**Public annotation reads**: set `PUBLIC_ANNOTATIONS=true` (the API-side
mirror of the book's `publication.show_public_annotations`) to serve the
annotation and reply list GETs to credential-less requests, read-only.
Default off: anonymous reads get 401. Requests presenting a credential
always go through the full auth/membership/scope checks.

## Deps contract

```ts
createApp(deps: AppDeps): Hono            // contract-shaped entry point
createApi(deps: AppDeps): AuthorbotApi    // + { repos, index, bootstrap(), rebuild() }

interface AppDeps {
  db: SqlDatabase;                        // @authorbot/database (D1 or better-sqlite3)
  config: AppConfig;
  identityProvider: IdentityProvider;     // createDevIdentityProvider() | createGitHubIdentityProvider(...)
  clock?: Clock;
  reader?: BookRepoReader;                // LocalFsBookRepoReader (Node) / Phase 5 GitHub reader
  onMutationCommitted?: (projectId: string) => Promise<void>; // repo-coordinator hook
}
```

`onMutationCommitted` fires after any mutation that enqueued an outbox row
(annotation create, reply create, withdraw). It is optional, a rejection is
swallowed - the operation stays observable at
`GET /v1/projects/{projectId}/operations/{operationId}` - and it is **not**
called when `config.mirrorMode === "queue"`: queue mode records outbox rows
for a later drain (the Phase 5 Durable Object alarm, or a manual
`InlineMirror.drain`).

### Inline mirroring (`MIRROR_MODE=inline`, Node only)

`@authorbot/api/local` exports the repo-coordinator wiring used by dev/tests:

```ts
import { createInlineMirror, LocalFsBookRepoReader } from "@authorbot/api/local";

const mirror = createInlineMirror({ db, workTreePath }); // LocalGitAdapter inside
const deps: AppDeps = {
  db,
  config: { ...config, mirrorMode: "inline" },
  identityProvider: createDevIdentityProvider(),
  reader: new LocalFsBookRepoReader(workTreePath),
  onMutationCommitted: mirror.onMutationCommitted,   // drains after each 202
};
```

Drains are serialized per project (the processor assumes a single drainer);
`mirror.drain(projectId)` runs the same serialized drain on demand, which is
how queue-mode rows are flushed in tests. The Worker keeps
`MIRROR_MODE=queue` - it cannot spawn `git`, and its outbox is drained out of
process from Phase 5 on.

## Contract ambiguities resolved here

1. **`{projectId}` match** - the path segment accepts the project UUID *or*
   its slug (both unambiguous in a single-project deployment); anything else
   is 404.
2. **Block existence check without repo access** - valid block ids are
   persisted on the `chapters` projection row (`block_ids` JSON column,
   populated by every rebuild), so contract §4's "blockId exists in that
   revision" check is enforced strictly from the database alone - including
   on reader-less instances (the Worker before Phase 5) sharing a DB that a
   reader-ful instance rebuilt. Unknown block → 422 `unknown-block`.
3. **Agent identity for minted tokens** - each mint creates an `agent` actor
   (`agent:<actorId>`, owned by the minter) with a pinned `editor` membership:
   token scopes are the effective control and an agent can never reach
   `tokens:manage`/`members:manage` through scope intersection.
4. **Withdraw state at command time** - withdraw queues a Git operation for
   the frontmatter update and flips the record to `withdrawn` only in the
   processor's post-commit sync batch (contract §5: records reflect Git). A
   failed operation leaves the record `open` and the withdraw retryable; a
   second withdraw is rejected 409 while one is in flight. `pending_git`
   records cannot be withdrawn (409 `state-conflict`) until their create
   commit lands.
5. **Idempotent mint replay never re-exposes the token** - the stored replay
   body is redacted (`tokenRedacted: true`); the plaintext exists only in the
   first 201 response (contract §3).
6. **Idempotency storage** - only 2xx responses are stored for replay; a
   request that failed (4xx) or died mid-flight re-executes under the same
   key (same-hash check still applies; different hash → 409).
7. **Rebuild preserves operational rows in place** - `pending_git` rows are
   accepted commands not yet in Git and are never deleted (not even ones
   accepted concurrently while a rebuild runs); a `pending_git` annotation
   whose chapter left the repository becomes `orphaned` (its git operation
   and outbox row are cancelled) instead of being dropped. Everything else is
   replaced by the repository's truth via id-keyed upserts.
8. **Webhook events** - only `push` triggers a rebuild; other events (and
   pushes on deployments without a reader) are recorded and marked `ignored`.
   Signature: `X-Hub-Signature-256` HMAC over the raw body, timing-safe
   compare; dedupe on `X-GitHub-Delivery` - except deliveries whose rebuild
   FAILED: redelivering the same delivery id retries the rebuild.
9. **Read-scope map** - project/members/chapters/operations reads require
   `chapters:read`; annotation reads require `annotations:read`; every
   endpoint requires an unrevoked membership (403 otherwise, 401 when
   unauthenticated).

## Tests

```sh
pnpm --filter @authorbot/api test        # Node + better-sqlite3, no wrangler needed
```

`test/*.test.ts` are unit/route tests over an in-memory DB and a fake reader.
`test/integration/*.test.ts` are the contract §7 exit-criteria suite: a temp
book repository `git clone`d from `examples/book-repo`, the real
`LocalGitAdapter` + inline processor, `LocalFsBookRepoReader`, dev auth -
including the §7.1 survival proof (create → commit → same-DB restart →
fresh-DB projection rebuild), the authorization matrix, idempotency
replay/mismatch, the webhook trio, and the no-plaintext DB scan. `git` must
be on PATH.
