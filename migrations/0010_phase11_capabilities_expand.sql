-- Phase 11 slice 3A: expand agent-token authorization without changing the
-- meaning of any existing row. The currently deployed Worker names every
-- column it writes and ignores extra columns on SELECT *, so this migration is
-- safe to apply before the dual-read Worker deploys.

-- Legacy rows remain authoritative through `scopes` until a later release
-- backfills capabilities_v2 and, eventually, a maintainer explicitly converts
-- the token. NULL is therefore meaningful here: it is not an empty canonical
-- grant.
ALTER TABLE agent_tokens
  ADD COLUMN capabilities_v2 TEXT;

-- Existing rows and inserts from the prior Worker are legacy by default. New
-- canonical writes set this explicitly while retaining a conservative value
-- in `scopes` for rollback safety.
ALTER TABLE agent_tokens
  ADD COLUMN capability_mode TEXT NOT NULL DEFAULT 'legacy'
    CHECK (
      capability_mode = 'legacy'
      OR (capability_mode = 'canonical' AND capabilities_v2 IS NOT NULL)
    );
