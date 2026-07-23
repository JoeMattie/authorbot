-- Phase 11 slice 3B: backfill the canonical projection of legacy agent-token
-- authority after the slice 3A dual-write Worker has been deployed.
--
-- RELEASE GATE: DO NOT package or apply this migration until the slice 3A
-- dual-read and dual-write Worker (v0.1.35) is deployed and healthy. Author CI
-- applies a release's migrations before its Worker, so 0013 must ship in a
-- release after the writer gate, never in that gate release itself. An older
-- Worker can still read the ordinary legacy scopes retained below, but an
-- older writer could insert a new NULL capabilities_v2 row after this
-- one-shot backfill had passed it.
--
-- This is the backfill step only. It deliberately does not perform slice 3C:
-- legacy rows remain in capability_mode='legacy', and the scopes column stays
-- authoritative for their compatibility behavior.

-- Materialize the complete transformation before changing agent_tokens so the
-- audit row and both authorization representations are derived from the same
-- input. The staging table is dropped before the migration completes and its
-- setup is safe to repeat after an interrupted local application.
CREATE TABLE IF NOT EXISTS _phase11_capabilities_backfill (
  token_id             TEXT PRIMARY KEY,
  sanitized_scopes     TEXT NOT NULL,
  translated_caps      TEXT NOT NULL,
  removed_scopes       TEXT NOT NULL,
  malformed_scope_set  INTEGER NOT NULL CHECK (malformed_scope_set IN (0, 1))
);

DELETE FROM _phase11_capabilities_backfill;

WITH decoded AS (
  SELECT
    id AS token_id,
    CASE
      WHEN json_type(CASE WHEN json_valid(scopes) THEN scopes ELSE 'null' END) = 'array'
       AND NOT EXISTS (
         SELECT 1
           FROM json_each(CASE WHEN json_valid(scopes) THEN scopes ELSE '[]' END)
          WHERE type <> 'text'
       )
      THEN scopes
      ELSE '[]'
    END AS valid_scopes,
    CASE
      WHEN json_type(CASE WHEN json_valid(scopes) THEN scopes ELSE 'null' END) = 'array'
       AND NOT EXISTS (
         SELECT 1
           FROM json_each(CASE WHEN json_valid(scopes) THEN scopes ELSE '[]' END)
          WHERE type <> 'text'
       )
      THEN 0
      ELSE 1
    END AS malformed_scope_set
  FROM agent_tokens
  WHERE capability_mode = 'legacy'
), normalized AS (
  SELECT
    token_id,
    valid_scopes,
    malformed_scope_set,
    COALESCE(
      (
        SELECT json_group_array(value)
          FROM (
            SELECT value
              FROM json_each(decoded.valid_scopes)
             WHERE value IN (
               'chapters:read',
               'annotations:read',
               'annotations:write',
               'work:read',
               'work:claim',
               'submissions:write',
               'votes:write'
             )
             ORDER BY CAST(key AS INTEGER)
          )
      ),
      '[]'
    ) AS sanitized_scopes,
    COALESCE(
      (
        SELECT json_group_array(value)
          FROM (
            -- Report each stripped name once, in its first-occurrence order.
            SELECT value, MIN(CAST(key AS INTEGER)) AS first_position
              FROM json_each(decoded.valid_scopes)
             WHERE value NOT IN (
               'chapters:read',
               'annotations:read',
               'annotations:write',
               'work:read',
               'work:claim',
               'submissions:write',
               'votes:write'
             )
             GROUP BY value
             ORDER BY first_position
          )
      ),
      '[]'
    ) AS removed_scopes
  FROM decoded
)
INSERT INTO _phase11_capabilities_backfill
  (token_id, sanitized_scopes, translated_caps, removed_scopes,
   malformed_scope_set)
SELECT
  token_id,
  sanitized_scopes,
  COALESCE(
    (
      SELECT json_group_array(capability)
        FROM (
          -- Keep this in the canonical EDITORIAL_CAPABILITIES order. No
          -- prerequisite or later-slice capability is synthesized.
          SELECT 1 AS ordinal, 'chapters:read' AS capability
           WHERE EXISTS (
             SELECT 1 FROM json_each(normalized.valid_scopes)
              WHERE value = 'chapters:read'
           )
          UNION ALL
          SELECT 2, 'comments:read'
           WHERE EXISTS (
             SELECT 1 FROM json_each(normalized.valid_scopes)
              WHERE value = 'annotations:read'
           )
          UNION ALL
          SELECT 3, 'suggestions:read'
           WHERE EXISTS (
             SELECT 1 FROM json_each(normalized.valid_scopes)
              WHERE value = 'annotations:read'
           )
          UNION ALL
          SELECT 4, 'comments:write'
           WHERE EXISTS (
             SELECT 1 FROM json_each(normalized.valid_scopes)
              WHERE value = 'annotations:write'
           )
          UNION ALL
          SELECT 5, 'suggestions:write'
           WHERE EXISTS (
             SELECT 1 FROM json_each(normalized.valid_scopes)
              WHERE value = 'annotations:write'
           )
          UNION ALL
          SELECT 6, 'replies:write'
           WHERE EXISTS (
             SELECT 1 FROM json_each(normalized.valid_scopes)
              WHERE value = 'annotations:write'
           )
          UNION ALL
          SELECT 8, 'suggestions:vote'
           WHERE EXISTS (
             SELECT 1 FROM json_each(normalized.valid_scopes)
              WHERE value = 'votes:write'
           )
          UNION ALL
          SELECT 9, 'feedback:withdraw-own'
           WHERE EXISTS (
             SELECT 1 FROM json_each(normalized.valid_scopes)
              WHERE value = 'annotations:write'
           )
          UNION ALL
          SELECT 11, 'work:read'
           WHERE EXISTS (
             SELECT 1 FROM json_each(normalized.valid_scopes)
              WHERE value = 'work:read'
           )
          UNION ALL
          SELECT 13, 'work:claim'
           WHERE EXISTS (
             SELECT 1 FROM json_each(normalized.valid_scopes)
              WHERE value = 'work:claim'
           )
          UNION ALL
          SELECT 14, 'work:submit'
           WHERE EXISTS (
             SELECT 1 FROM json_each(normalized.valid_scopes)
              WHERE value = 'submissions:write'
           )
          UNION ALL
          SELECT 17, 'chapters:write'
           WHERE EXISTS (
             SELECT 1 FROM json_each(normalized.valid_scopes)
              WHERE value = 'submissions:write'
           )
          UNION ALL
          SELECT 18, 'chapters:publish'
           WHERE EXISTS (
             SELECT 1 FROM json_each(normalized.valid_scopes)
              WHERE value = 'submissions:write'
           )
          ORDER BY ordinal
        )
    ),
    '[]'
  ) AS translated_caps,
  removed_scopes,
  malformed_scope_set
FROM normalized;

-- Stripping a control-plane or unknown name is an intentional reduction of
-- stored authority. Surface one system-authored audit event per affected token
-- before updating the row. Structurally invalid sets are also reset fail-closed
-- and called out separately. Once scopes are sanitized, a direct rerun cannot
-- create another event.
INSERT INTO audit_events
  (id, project_id, actor_id, action, target_type, target_id, correlation_id,
   metadata, created_at)
SELECT
  lower(
    substr(printf('%012x', CAST(strftime('%s', 'now') AS INTEGER) * 1000), 1, 8)
    || '-'
    || substr(printf('%012x', CAST(strftime('%s', 'now') AS INTEGER) * 1000), 9, 4)
    || '-7' || substr(hex(randomblob(2)), 2, 3)
    || '-8' || substr(hex(randomblob(2)), 2, 3)
    || '-' || hex(randomblob(6))
  ),
  token.project_id,
  NULL,
  'agent_token.legacy_scopes.sanitized',
  'agent_token',
  token.id,
  'phase11-3b-capability-backfill:' || token.id,
  json_object(
    'migration', '0013_phase11_capabilities_backfill.sql',
    'capabilityMode', 'legacy',
    'reason', CASE
      WHEN staged.malformed_scope_set = 1 THEN 'invalid-legacy-scope-set'
      ELSE 'control-plane-or-unknown-scope'
    END,
    'removedScopes', json(staged.removed_scopes),
    'retainedScopes', json(staged.sanitized_scopes)
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM agent_tokens AS token
JOIN _phase11_capabilities_backfill AS staged
  ON staged.token_id = token.id
WHERE token.capability_mode = 'legacy'
  AND (
    staged.malformed_scope_set = 1
    OR staged.removed_scopes <> '[]'
  );

-- Preserve mode and every lifecycle field. Legacy `scopes` continues to drive
-- compatibility authorization; capabilities_v2 is a populated projection for
-- a future, separately gated retirement release.
UPDATE agent_tokens
   SET scopes = (
         SELECT sanitized_scopes
           FROM _phase11_capabilities_backfill
          WHERE token_id = agent_tokens.id
       ),
       capabilities_v2 = COALESCE(
         capabilities_v2,
         (
           SELECT translated_caps
             FROM _phase11_capabilities_backfill
            WHERE token_id = agent_tokens.id
         )
       )
 WHERE capability_mode = 'legacy'
   AND id IN (SELECT token_id FROM _phase11_capabilities_backfill);

DROP TABLE _phase11_capabilities_backfill;
