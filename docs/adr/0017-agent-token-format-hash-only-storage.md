# ADR 0017: Agent-token format and hash-only storage

## Status

Accepted (2026-07-19)

## Context

Agents authenticate with long-lived credentials that design §19.2 requires
to be named, scoped, revocable, expiring, and stored only as a cryptographic
hash. Phase 2 must pick a concrete wire format and storage scheme, and prove
in tests that no plaintext ever reaches the database or logs
(phase2-contract §3, §7.5; design §20.6).

## Decision

- **Format**: `authorbot_<43 chars base64url>` — 256 bits of CSPRNG output,
  base64url without padding (phase2-contract §3). The fixed `authorbot_`
  prefix makes tokens greppable for secret scanners and unambiguous in
  `Authorization: Bearer` headers.
- **Hash-only storage**: the `agent_tokens` row stores the SHA-256 digest of
  the full token string, never the plaintext (design §19.2). Lookup hashes
  the presented token and matches on the unique hash column
  (phase2-contract §2). Plain SHA-256 (no salt/KDF) is sufficient because
  the secret is 256 bits of entropy, not a human password — brute force is
  infeasible and the unique index needs a deterministic digest.
- **One-time disclosure**: the plaintext appears exactly once, in the mint
  response (`POST /v1/projects/{projectId}/agent-tokens`, maintainer-only);
  it is never retrievable, logged, or audited afterward
  (phase2-contract §3, §4).
- **Row fields**: `name`, `scopes[]`, `expires_at` (≤ 90 days, default 30),
  `created_by`, `revoked_at`, `last_used_at` — the latter updated at most
  once per minute to avoid a write per request (phase2-contract §3;
  design §19.2's last-used visibility).
- **Effective authority** = token `scopes` ∩ the owning membership's role
  bundle (design §19.3), so revoking or downgrading the membership caps
  every token it owns without touching token rows (phase2-contract §3).

## Consequences

- A database leak exposes no usable credentials: digests of 256-bit random
  secrets are not invertible in practice, and revocation/expiry are row
  flags checked on every request.
- Lost tokens cannot be re-shown — recovery is mint-a-new, revoke-the-old,
  which is the desired operational habit.
- The scope-intersection rule means token scopes may be provisioned broadly
  (e.g. editor scopes ahead of Phase 4, phase2-contract §3) without
  granting more than the membership allows today.
- Tests assert the invariant directly: after minting, the DB contains no
  token plaintext (phase2-contract §7.5), and test output must never print
  it either (standing rule, phase2-contract §3).
