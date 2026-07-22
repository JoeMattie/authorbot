# Authorbot OpenAPI specification

`openapi.yaml` is the OpenAPI 3.1 description of the Authorbot v1
coordination-plane API, covering the endpoint outline of the design document
(§15.2), the agent task-bundle claim response (§15.3), the status-code table
(§15.4), and the SSE events feed (§15.5).

## Organization

Single-file spec, one path item per endpoint, grouped by tag:

- `identity` - `/v1/me`, project metadata, members, agent tokens.
- `chapters` - chapter projections, chapter submissions, story documents
  (outline, timeline, characters).
- `annotations` - annotations, replies, votes, withdraw, re-anchor.
- `work` - work items, claim (returns the task bundle), lease recovery/renew/release,
  work-item submissions.
- `operations` - Git operation status, the SSE event stream, and the GitHub
  webhook receiver.

Reusable pieces live under `components`:

- `schemas` - domain shapes (`Chapter`, `Annotation`, `Vote`, `Decision`,
  `WorkItem`, `Lease`, `Submission`, `Operation`, `TaskBundle`, `Problem`,
  plus shared primitives such as `Uuid`, `Timestamp`, `ActorRef`,
  `ContentHash`). Schemas are structural skeletons: shapes and enums are
  binding; per-field constraint details may still tighten during Phase 1.
- `parameters` - cursor pagination (`Cursor`, `Limit`), `Idempotency-Key`,
  `If-Match`, and common path ids.
- `responses` - one `application/problem+json` response per §15.4 error code.
- `securitySchemes` - `githubSession` (GitHub-OAuth-backed session cookie)
  and `agentToken` (bearer). The GitHub webhook endpoint is
  signature-authenticated instead and declares `security: []`.

Conventions (§15.1) are enforced spec-wide: paths carry the `/v1` prefix,
ids are UUIDv7, timestamps are RFC 3339 UTC, mutations require
`Idempotency-Key`, editable resources use `ETag`/`If-Match`, errors are RFC
9457 problem documents, lists use `cursor`/`nextCursor`, and asynchronous
commands return `202` with an `operationId` plus correlation ids.

## Versioning policy

- The URL prefix (`/v1`) is the compatibility contract. Within `/v1`,
  changes are additive only: new endpoints, new optional fields, new enum
  values where the schema documents that the set may grow. Removing or
  renaming fields, changing types, or tightening required-ness demands `/v2`.
- `info.version` is the spec artifact's own semver (currently a pre-release,
  `1.0.0-alpha.0`); it tracks editorial and additive changes to this file
  and is bumped in the change that edits the spec.
- The spec is the source of truth for the API surface; server and client
  code conform to it, not the other way around.

## Client generation

Per design §15.1 the project publishes OpenAPI 3.1 and generates a client
from it. Phase 0 deliberately ships no generator tooling in the workspace;
when a client package is added (Phase 1+), generate it from this file with
an OpenAPI-3.1-capable TypeScript generator (e.g. `openapi-typescript` for
types, or `@hey-api/openapi-ts` for a typed fetch client) as a build step in
that package - not here.

## Validating

The file must parse as YAML and stay a valid OpenAPI 3.1 document. Quick
parse check without workspace tooling:

```sh
node -e "import('yaml').then(y => y.parse(require('node:fs').readFileSync('openapi/openapi.yaml','utf8')) && console.log('ok'))"
```

(Requires a `yaml` package resolvable from the cwd; any YAML 1.2 parser or
`python3 -c 'import yaml,sys; yaml.safe_load(open("openapi/openapi.yaml"))'`
works equally well.)
