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
- **Operator documentation**: runbook for the failure modes above, backup and
  restore, key rotation (session, webhook, GitHub App), and how to read the
  audit log.

## Exit criteria

1. Documented rate limits enforced and tested.
2. Restore drill passes as an automated test.
3. Security and accessibility reviews complete with findings fixed or
   explicitly accepted in writing.
4. Load tests hold under sustained fleet-shaped traffic; failure injection
   degrades reads-still-work, writes-refuse-clearly.
5. Runbook sufficient for an operator who did not build the system.
