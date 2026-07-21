# @authorbot/git-github

GitHub integration for Authorbot (Phase 5 contract). **Worker-compatible
only**: WebCrypto instead of `node:crypto`, `fetch` instead of `node:http`.
Nothing under `src/` may import a `node:` module - `test/worker-compat.test.ts`
enforces it, including for `src/testing/`.

Two entry points:

| Import | Contents |
| --- | --- |
| `@authorbot/git-github` | GitHub API constants and real git object hashing. Shared by the auth layer, reader and writer. |
| `@authorbot/git-github/testing` | The deterministic fake GitHub API. Tests only; production bundles never pull it in. |

**Credential rule for every module added here:** installation tokens and app
private keys are never logged, never persisted, and never returned in any
response, error message or artifact (design §19.5, §20.6).

## This step: the fake GitHub API

`src/testing/` is the fake the reader and writer are built against. It is an
in-process object with a `fetch`-shaped handler - no ports, no server, no
filesystem, no timers - so it runs unchanged in a Worker and needs no network
in the default suite.

### Real git object hashing

Object ids are **genuine git SHAs**: SHA-1 over the loose object encoding
`"<type> <byteLength>\0" + payload`, with git's tree entry ordering (trees
sort as `name + "/"`) and git's mode encoding (`40000`, not `040000`). A blob
written into the fake therefore has the same SHA it would have in a real
clone, so fixtures are comparable with `git hash-object` / `git cat-file`.
`test/git-objects.test.ts` pins the fixtures against SHAs produced by real
`git`, including the empty blob (`e69de29…`) and empty tree (`4b825dc…`).

### Content model

`FakeRepoState` is the mutable repository:

```
refs:    branch name -> commit sha
commits: sha -> { tree, parents, message, author, committer }
trees:   sha -> TreeEntry[]      // one level; subtrees are entries
blobs:   sha -> bytes
```

`createTree(baseTree, changes)` implements GitHub's `base_tree` merge:
entries the change set does not name are preserved byte-for-byte (untouched
subtrees are not even expanded, so their SHAs carry over), nested paths create
intermediate trees, `sha: null` deletes a path, and a directory emptied by a
deletion disappears as it does in git.

`updateRef(branch, sha)` enforces the real fast-forward rule by walking commit
ancestry: a non-fast-forward without `force` is a 422 and the ref does not
move. `force` exists so tests can set up state, but nothing in the writer path
may use it.

### Surface

```ts
import { createFakeGitHub } from "@authorbot/git-github/testing";

const fake = await createFakeGitHub({
  owner: "JoeMattie",
  repo: "causal-projector",
  defaultBranch: "main",
  files: bookRepoFiles,        // path -> string | Uint8Array
});

const token = /* POST /app/installations/{id}/access_tokens */;
const writer = new GitHubBookRepoWriter({ fetchImpl: fake.fetch, /* … */ });
```

Endpoints implemented (everything else answers `404`, so an unimplemented call
fails loudly rather than appearing to work):

```
POST   /app/installations/{id}/access_tokens
GET    /repos/{owner}/{repo}
GET    /repos/{owner}/{repo}/git/ref/heads/{branch}      (branch may contain "/")
POST   /repos/{owner}/{repo}/git/refs                    (create a branch)
PATCH  /repos/{owner}/{repo}/git/refs/heads/{branch}
POST   /repos/{owner}/{repo}/git/blobs                   (utf-8 or base64)
GET    /repos/{owner}/{repo}/git/blobs/{sha}             (base64, or raw media type)
POST   /repos/{owner}/{repo}/git/trees                   (base_tree merge)
GET    /repos/{owner}/{repo}/git/trees/{sha}[?recursive=1]
POST   /repos/{owner}/{repo}/git/commits
GET    /repos/{owner}/{repo}/git/commits/{sha}
```

Fidelity details that exist to catch client bugs:

- `GET /git/blobs/{sha}` returns base64 **wrapped at 60 characters**, exactly
  as the real API does. A client that decodes without stripping whitespace
  fails here rather than in production. `decodeBase64` (exported from the main
  entry point) tolerates the wrapping.
- Repository requests require a live installation token (`Bearer`/`token`).
  Expired or revoked tokens answer `401`. Disable with `requireAuth: false`
  only when the test is not about auth.
- The token endpoint requires an `Authorization` that looks like an app JWT
  (three dot-separated segments), catching a client that presents an
  installation token to mint another one. Disable with `requireAppJwt: false`.
- `now` is injectable, so token expiry is testable without waiting.

### Seeding

The fake never reads the filesystem. The caller assembles the content:

- `seedFiles(map, opts)` / `createFakeGitHub({ files })` - a
  `path -> string | Uint8Array` map. Use this for `examples/book-repo`: read
  the directory in your test, pass the map in.
- `seedDirectory(tree, opts)` / `createFakeGitHub({ directory })` - a nested
  plain object, e.g. `{ chapters: { "001.md": "…" } }`.
- `externalCommit(files, opts)` - an out-of-band push, as an external actor
  would make. Reconciliation tests use this directly.

### Fault injection

Every fault is an explicit, typed, named option with a firing budget
(`times`, default 1) - no magic branch names or sentinel paths. After the
budget is spent the fake behaves correctly again, which is what makes bounded
retry testable: the assertion is that the *next* attempt succeeds.

| Fault | Effect |
| --- | --- |
| `movedHead` | After a successful `GET .../git/ref/heads/{branch}`, commits `files` onto that branch out of band. The client's subsequent non-force `PATCH` is a genuine non-fast-forward - a real race, not a synthesized status. |
| `truncatedTree` | `GET /git/trees` answers `truncated: true` with a clipped entry list (`keepEntries`). |
| `unauthorized` | Repository requests answer `401 Bad credentials` even with a valid token, forcing a token refresh. Fires before token validation. |
| `nonFastForward` | `PATCH /git/refs/heads/{branch}` answers `422 Update is not a fast forward` regardless of real ancestry. Optionally scoped with `branch`. Use it to drive the retry bound to exhaustion. |
| `rateLimited` | `403` with `x-ratelimit-*` headers and optional `retry-after`; `secondary: true` for the secondary-limit message. Fires before authentication. |
| `installationTokenFailure` | The token mint fails with `status` (default 401); use `404` for a revoked installation. |

Budget-consumption is guarded by the fault's own predicate: a fault scoped to
one branch is *not* burned by a request touching another branch.

```ts
fake.injectFault("movedHead", { branch: "main", files: { "ch.md": "…" } });
// … exercise the writer …
fake.assertAllFaultsFired();   // throws if an armed fault never fired
fake.faults.remaining("movedHead");
```

`assertAllFaultsFired()` is the guard against a test that passes vacuously
because the fault's code path was never reached.

### Observation helpers

- `fake.state` - the raw `FakeRepoState` for direct assertions
  (`getRef`, `getCommit`, `listTree`, `readFile`, `readFiles`, `history`).
- `fake.fileAtHead(path, branch?)` - file text at the branch head, or `null`.
- `fake.requests` - every request in arrival order (`sequence`, `method`,
  `pathname`, `search`, `at`), for call-count and concurrency assertions.
- `fake.countRequests(method, pathnamePredicate)`.
- `fake.issuedTokenCount()`, `fake.revokeAllTokens()`.

## Verify

```
pnpm --filter @authorbot/git-github build
pnpm --filter @authorbot/git-github test
pnpm --filter @authorbot/git-github typecheck
```
