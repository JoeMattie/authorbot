# Phase 7 implementation contract — hardening

Additive to Phase 0–6 contracts. This is design document §23 Phase 6,
renumbered when guided onboarding took that slot. It precedes Phase 8 (the
collaborator skill) deliberately: the service should survive a fleet before
one is invited.

## Scope

- **Rate limits** per actor and per token on every mutation, with
  `429` + `Retry-After` and documented ceilings. Voting, claiming, and
  submission endpoints first — they are the ones a fleet hits hardest.
- **Restore drill**, executed and documented: destroy a database, rebuild the
  projection from Git, confirm what returns and what does not (sessions,
  leases, and agent tokens do not). The drill is a test, not a paragraph.
- **Security review** of the whole surface, with the Phase 0–6 review lenses
  applied to the system rather than to a single phase: auth, tokens, CSRF,
  webhooks, injection, path handling, and the agent-facing untrusted-content
  boundary.
- **Accessibility review** of the published site and collaboration islands
  against the design's §16.6 list, including a screen-reader pass.
- **Load and failure testing**: sustained concurrent claims and submissions,
  a coordinator backlog, GitHub API rate limiting and outage, D1 errors.
  Failures must degrade honestly — reads keep working, writes refuse clearly.
- **Author-facing access control** (§ below) — the settings an author needs to
  vet, restrict, and revoke the people and agents working on their book.
- **Operator documentation**: runbook for the failure modes above, backup and
  restore, key rotation (session, webhook, GitHub App), and how to read the
  audit log.

## Author-facing access control

Phase 2 built memberships, roles, and revocable agent tokens; Phase 6 added a
settings view. Neither gave an author a way to *see* who can touch their book
or to stop them. Hardening a system that strangers and agent fleets can write
to means putting that control in the author's hands, not in a database
console.

All of the following live in the maintainer settings view, and every action is
recorded as an audit event.

### Seeing

- **Collaborators**: who has access, their role, when they joined, who added
  them, and when they last acted.
- **Agent tokens**: name, scopes, owning human, created and last-used times,
  expiry. Tokens are never re-displayable — only their metadata.
- **Recent activity**: a readable view of the audit log filtered by actor, so
  "who changed this and when" is answerable without a runbook. Vetting is
  guesswork without it, which is why it belongs here rather than in Phase 9.

### Restricting

- **Change a role** (reader / contributor / editor / maintainer), with the
  scope consequences stated in plain language rather than as scope names.
- **Book access mode**, a single obvious control:
  - `open` — any signed-in GitHub user may comment and suggest.
  - `invite-only` — only members may write. *(Default; already the Phase 2
    §19.7 behaviour, now visible and changeable.)*
  - `frozen` — no writes at all: no annotations, votes, claims, or
    submissions, from anyone including maintainers. **Reads are unaffected**
    and the site keeps serving. Intended for "something is wrong, stop
    everything while I look."
- **Pause agents**: suspend every agent token at once while leaving human
  collaborators working. Agents are the population most likely to misbehave
  at volume, and an author should be able to stop them without dismantling
  their human collaboration.

### Revoking

- **Remove a collaborator** or **revoke a token**, taking effect on the *next
  request* — not on session expiry. Specifically, revocation must:
  - invalidate that actor's sessions, not merely their membership;
  - release any lease they hold, returning the work item to `ready` so their
    departure does not strand work for up to four hours;
  - reject in-flight submissions from the revoked actor;
  - leave their prior contributions intact — attribution and history are
    permanent records, not access grants. Removing someone is not erasing
    them, and the interface must not imply otherwise.
- **Revoke all agent tokens** in one action, for a suspected leak.

Nothing here deletes content. An author who wants a contribution reverted uses
the normal editorial path; access control governs who may act next, not what
already happened.

## Exit criteria

1. Documented rate limits enforced and tested.
2. Restore drill passes as an automated test.
3. Security and accessibility reviews complete with findings fixed or
   explicitly accepted in writing.
4. Load tests hold under sustained fleet-shaped traffic; failure injection
   degrades reads-still-work, writes-refuse-clearly.
5. Runbook sufficient for an operator who did not build the system.
6. An author, signed in as maintainer and without touching a database or CLI,
   can list collaborators and tokens, read who did what, change a role, switch
   the book between open / invite-only / frozen, pause all agents, and revoke
   a collaborator or token.
7. Revocation is effective on the next request, releases held leases, rejects
   the revoked actor's in-flight submissions, invalidates their sessions, and
   preserves their existing attribution — each asserted by test.
8. `frozen` refuses every write path (including maintainer writes) while reads
   and the published site are provably unaffected.
