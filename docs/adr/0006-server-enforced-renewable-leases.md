# ADR 0006: Server-enforced renewable work leases, 30-minute default

## Status

Accepted (2026-07-19)

## Context

Two actors must never hold the same work item, and abandoned work must return
to the queue without manual cleanup. A visual "claimed" flag enforces nothing;
concurrency must be explicit (design §3.6, §12).

## Decision

- A lease is a server-enforced capability, not a UI hint (design §12.1).
  Defaults: `duration: PT30M`, `renewal_prompt_before: PT5M`,
  `renewal_duration: PT30M`, `maximum_total_duration: PT4H`.
- Claim is a serialized compare-and-set (§12.2): exactly one of two
  simultaneous claims succeeds; the server stores only the hash of an opaque
  lease token returned once with the task bundle and base revision.
- Renewal requires the current token and cannot exceed the maximum total
  duration (§12.3).
- Expiration is enforced lazily on every relevant command and eagerly by a
  scheduled sweep/alarm (§12.4). Submissions are verified against holder,
  token, expiry, state, and base revision (§12.5); a lease does not freeze the
  chapter — conflicts follow §12.6.

## Consequences

- No submission is accepted on the strength of a client-side countdown.
- Agents and humans use the same claim/renew/submit endpoints (§3.1).
- Requires a single-writer coordinator per project (see ADR 0008) so claims
  serialize; lease state lives in the operational database (ADR 0002), never
  in Git.
