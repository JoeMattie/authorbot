# ADR 0015: `IdentityProvider` interface with a dev-mode login provider

## Status

Accepted (2026-07-19)

## Context

Human login is GitHub OAuth (design §19.1), but Phase 2's authorization
matrix tests must exercise every endpoint as anonymous, reader, contributor,
maintainer, and various agent-token states (phase2-contract §7.2). Driving a
real OAuth web flow from vitest is slow, flaky, needs network and secrets,
and cannot mint arbitrary roles on demand. The exit criterion itself starts
with "dev-login" (phase2-contract §7.1), so a test-facing identity path is
load-bearing, not a convenience.

## Decision

- `apps/api` authenticates humans through an `IdentityProvider` interface
  with two implementations (phase2-contract §3):
  - **`github`**: the OAuth web flow, configured via
    `GITHUB_CLIENT_ID/SECRET` env (phase2-contract §6); implemented in this
    phase but exercised only when configured.
  - **`dev`**: active only when `AUTH_MODE=dev`; `POST /v1/dev/login
    {login, role}` creates or loads the actor and membership and issues a
    normal session.
- The dev route is **never mounted** when `AUTH_MODE=github` - mode
  selection happens at router construction, so in github mode the route
  does not exist to be misconfigured, and requests to it 404
  (phase2-contract §3, §4).
- Everything downstream of the provider is shared: both providers issue the
  same opaque 256-bit, HMAC-signed (`SESSION_SECRET`), HttpOnly/Secure/
  SameSite=Lax session cookie backed by a `human_sessions` row with 7-day
  expiry (phase2-contract §3). Authorization, auditing, and scope bundles
  (design §19.3) see no difference between providers.

## Consequences

- Testability: the full authorization matrix and the Phase 2 exit test run
  offline and deterministically - any role is one `POST /v1/dev/login`
  away - while still exercising the real session, scope, and audit code
  paths, because only the identity *source* is faked.
- The dev provider is a deliberate authentication bypass, contained by
  construction (route not mounted in github mode) rather than by a runtime
  check that could be skipped; deployment config must still never set
  `AUTH_MODE=dev` in production (phase2-contract §6).
- The GitHub provider ships behind the same interface, so swapping or
  adding an OpenID provider later (design §19.1) touches one implementation,
  not the session or authorization layers.
- Session and provider logic must uphold the standing rule: token/session
  plaintext is never logged or stored (phase2-contract §3; design §20.6).
