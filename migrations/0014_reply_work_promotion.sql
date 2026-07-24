-- Reply-specific Work promotion.
--
-- A promoted reply keeps the parent annotation as its target/context anchor,
-- but has its own durable source identity. This lets a maintainer promote one
-- reply without consuming or changing the annotation-level promotion.

ALTER TABLE decisions ADD COLUMN source_reply_id TEXT;
ALTER TABLE work_items ADD COLUMN source_reply_id TEXT;

DROP INDEX idx_decisions_idempotency;
DROP INDEX idx_decisions_one_work_item;

-- Annotation decisions and reply decisions occupy separate idempotency
-- domains. The partial indexes avoid SQLite's NULL-distinct unique behavior.
CREATE UNIQUE INDEX idx_decisions_annotation_idempotency
  ON decisions (source_annotation_id, action_type, rule_version)
  WHERE source_reply_id IS NULL;

CREATE UNIQUE INDEX idx_decisions_reply_idempotency
  ON decisions (source_reply_id, action_type, rule_version)
  WHERE source_reply_id IS NOT NULL;

-- At most one Work item per annotation-level promotion, and independently at
-- most one Work item for each individual reply.
CREATE UNIQUE INDEX idx_decisions_one_annotation_work_item
  ON decisions (source_annotation_id)
  WHERE action_type = 'create_work_item' AND source_reply_id IS NULL;

CREATE UNIQUE INDEX idx_decisions_one_reply_work_item
  ON decisions (source_reply_id)
  WHERE action_type = 'create_work_item' AND source_reply_id IS NOT NULL;

CREATE INDEX idx_work_items_source_reply
  ON work_items (source_reply_id)
  WHERE source_reply_id IS NOT NULL;
