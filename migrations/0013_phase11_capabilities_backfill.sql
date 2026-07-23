-- Phase 11 slice 3B: backfill and maintain the canonical projection of legacy
-- agent-token authority.
--
-- v0.1.35 is the intended predecessor, but a book can skip releases or roll
-- its Worker back. Author CI also applies migrations before deploying the
-- matching Worker. Persistent triggers are therefore installed before the
-- one-shot update: even a pre-v0.1.35 writer cannot create a post-backfill NULL
-- or stale projection. Keep those triggers until slice 3C retires legacy mode.
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

-- One persistent definition drives both the one-shot backfill and the trigger
-- shield. That prevents the SQL translation used during a direct version skip
-- from drifting from the translation applied to existing rows.
CREATE VIEW IF NOT EXISTS _phase11_legacy_token_projection AS
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
        SELECT json_group_array(scope)
          FROM (
            -- Match parseLegacyScopes: de-duplicate known names and store
            -- them in LEGACY_EDITORIAL_SCOPES order, independent of the old
            -- writer's input order.
            SELECT 1 AS ordinal, 'chapters:read' AS scope
             WHERE EXISTS (
               SELECT 1 FROM json_each(decoded.valid_scopes)
                WHERE value = 'chapters:read'
             )
            UNION ALL
            SELECT 2, 'annotations:read'
             WHERE EXISTS (
               SELECT 1 FROM json_each(decoded.valid_scopes)
                WHERE value = 'annotations:read'
             )
            UNION ALL
            SELECT 3, 'annotations:write'
             WHERE EXISTS (
               SELECT 1 FROM json_each(decoded.valid_scopes)
                WHERE value = 'annotations:write'
             )
            UNION ALL
            SELECT 4, 'work:read'
             WHERE EXISTS (
               SELECT 1 FROM json_each(decoded.valid_scopes)
                WHERE value = 'work:read'
             )
            UNION ALL
            SELECT 5, 'work:claim'
             WHERE EXISTS (
               SELECT 1 FROM json_each(decoded.valid_scopes)
                WHERE value = 'work:claim'
             )
            UNION ALL
            SELECT 6, 'submissions:write'
             WHERE EXISTS (
               SELECT 1 FROM json_each(decoded.valid_scopes)
                WHERE value = 'submissions:write'
             )
            UNION ALL
            SELECT 7, 'votes:write'
             WHERE EXISTS (
               SELECT 1 FROM json_each(decoded.valid_scopes)
                WHERE value = 'votes:write'
             )
            ORDER BY ordinal
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

-- Shield direct upgrades from pre-v0.1.35 Workers. An AFTER trigger is atomic
-- with the statement that fired it, so the legacy writer never exposes an
-- unprojected row after its INSERT returns. The UPDATE trigger also covers a
-- rollback or any older writer that edits scopes. Its WHEN clause makes the
-- trigger convergent even when recursive_triggers is enabled.
CREATE TRIGGER IF NOT EXISTS agent_tokens_phase11_legacy_insert
AFTER INSERT ON agent_tokens
WHEN NEW.capability_mode = 'legacy'
 AND EXISTS (
   SELECT 1
     FROM _phase11_legacy_token_projection AS projected
    WHERE projected.token_id = NEW.id
      AND (
        NEW.scopes IS NOT projected.sanitized_scopes
        OR NEW.capabilities_v2 IS NOT projected.translated_caps
      )
 )
BEGIN
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
    NEW.project_id,
    NULL,
    'agent_token.legacy_capabilities.projected',
    'agent_token',
    NEW.id,
    'phase11-3b-capability-guard:' || NEW.id || ':' || lower(hex(randomblob(4))),
    json_object(
      'migration', '0013_phase11_capabilities_backfill.sql',
      'capabilityMode', 'legacy',
      'reason', CASE
        WHEN NEW.capabilities_v2 IS NULL THEN 'missing-projection'
        ELSE 'stale-projection'
      END,
      'capabilities', json(projected.translated_caps)
    ),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM _phase11_legacy_token_projection AS projected
  WHERE projected.token_id = NEW.id
    AND NEW.capabilities_v2 IS NOT projected.translated_caps;


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
    NEW.project_id,
    NULL,
    'agent_token.legacy_scopes.sanitized',
    'agent_token',
    NEW.id,
    'phase11-3b-capability-guard:' || NEW.id || ':' || lower(hex(randomblob(4))),
    json_object(
      'migration', '0013_phase11_capabilities_backfill.sql',
      'capabilityMode', 'legacy',
      'reason', CASE
        WHEN projected.malformed_scope_set = 1 THEN 'invalid-legacy-scope-set'
        ELSE 'control-plane-or-unknown-scope'
      END,
      'removedScopes', json(projected.removed_scopes),
      'retainedScopes', json(projected.sanitized_scopes)
    ),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM _phase11_legacy_token_projection AS projected
  WHERE projected.token_id = NEW.id
    AND (
      projected.malformed_scope_set = 1
      OR projected.removed_scopes <> '[]'
    );

  UPDATE agent_tokens
     SET scopes = (
           SELECT sanitized_scopes
             FROM _phase11_legacy_token_projection
            WHERE token_id = NEW.id
         ),
         capabilities_v2 = (
           SELECT translated_caps
             FROM _phase11_legacy_token_projection
            WHERE token_id = NEW.id
         )
   WHERE id = NEW.id
     AND capability_mode = 'legacy';
END;

CREATE TRIGGER IF NOT EXISTS agent_tokens_phase11_legacy_update
AFTER UPDATE OF scopes, capabilities_v2, capability_mode ON agent_tokens
WHEN NEW.capability_mode = 'legacy'
 AND EXISTS (
   SELECT 1
     FROM _phase11_legacy_token_projection AS projected
    WHERE projected.token_id = NEW.id
      AND (
        NEW.scopes IS NOT projected.sanitized_scopes
        OR NEW.capabilities_v2 IS NOT projected.translated_caps
      )
 )
BEGIN
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
    NEW.project_id,
    NULL,
    'agent_token.legacy_capabilities.projected',
    'agent_token',
    NEW.id,
    'phase11-3b-capability-guard:' || NEW.id || ':' || lower(hex(randomblob(4))),
    json_object(
      'migration', '0013_phase11_capabilities_backfill.sql',
      'capabilityMode', 'legacy',
      'reason', CASE
        WHEN NEW.capabilities_v2 IS NULL THEN 'missing-projection'
        ELSE 'stale-projection'
      END,
      'capabilities', json(projected.translated_caps)
    ),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM _phase11_legacy_token_projection AS projected
  WHERE projected.token_id = NEW.id
    AND NEW.capabilities_v2 IS NOT projected.translated_caps;


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
    NEW.project_id,
    NULL,
    'agent_token.legacy_scopes.sanitized',
    'agent_token',
    NEW.id,
    'phase11-3b-capability-guard:' || NEW.id || ':' || lower(hex(randomblob(4))),
    json_object(
      'migration', '0013_phase11_capabilities_backfill.sql',
      'capabilityMode', 'legacy',
      'reason', CASE
        WHEN projected.malformed_scope_set = 1 THEN 'invalid-legacy-scope-set'
        ELSE 'control-plane-or-unknown-scope'
      END,
      'removedScopes', json(projected.removed_scopes),
      'retainedScopes', json(projected.sanitized_scopes)
    ),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM _phase11_legacy_token_projection AS projected
  WHERE projected.token_id = NEW.id
    AND (
      projected.malformed_scope_set = 1
      OR projected.removed_scopes <> '[]'
    );

  UPDATE agent_tokens
     SET scopes = (
           SELECT sanitized_scopes
             FROM _phase11_legacy_token_projection
            WHERE token_id = NEW.id
         ),
         capabilities_v2 = (
           SELECT translated_caps
             FROM _phase11_legacy_token_projection
            WHERE token_id = NEW.id
         )
   WHERE id = NEW.id
     AND capability_mode = 'legacy';
END;

INSERT INTO _phase11_capabilities_backfill
  (token_id, sanitized_scopes, translated_caps, removed_scopes,
   malformed_scope_set)
SELECT
  token_id,
  sanitized_scopes,
  translated_caps,
  removed_scopes,
  malformed_scope_set
FROM _phase11_legacy_token_projection;

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
       capabilities_v2 = (
         SELECT translated_caps
           FROM _phase11_capabilities_backfill
          WHERE token_id = agent_tokens.id
       )
 WHERE capability_mode = 'legacy'
   AND id IN (SELECT token_id FROM _phase11_capabilities_backfill);

DROP TABLE _phase11_capabilities_backfill;
