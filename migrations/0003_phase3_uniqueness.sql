-- Migration 0003: close the Phase 3 governance-uniqueness gaps that the
-- `(source_annotation_id, action_type, rule_version)` idempotency index in
-- 0002 leaves open for work-item creation.
--
-- A rule crossing records its create_work_item decision with rule_version >= 1;
-- a maintainer force-create records ANOTHER create_work_item decision with
-- rule_version 0 (contract §4). Because their rule_versions differ, the 0002
-- index does not collapse a force-create racing a rule crossing across
-- isolates, so both could commit — two decisions, two work items, two Git
-- artifacts for one annotation (contract §4 backstop / exit criterion 1).
--
-- This partial unique index gives work-item creation ONE uniqueness domain per
-- annotation regardless of rule_version: at most one create_work_item decision
-- can exist per source annotation. The loser of a cross-isolate race sees a
-- UNIQUE violation, its batch rolls back atomically, and it proceeds as
-- already-decided. Reject/reopen/cancel override decisions (different
-- action_type) are unaffected — a legal reject → reopen → force-create history
-- still records both a reject_suggestion and a create_work_item decision.
CREATE UNIQUE INDEX idx_decisions_one_work_item
  ON decisions (source_annotation_id)
  WHERE action_type = 'create_work_item';
