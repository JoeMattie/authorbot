-- Phase 11 slice 4: immutable chapter and metadata proposals with an explicit
-- maintainer review lifecycle. This is an expand-only migration: the Worker
-- already deployed before this migration does not know this table exists.

-- A whole-chapter claimant receives the exact source it is revising. Retain
-- that snapshot until submission so a proposal can still show its real base
-- after the repository head moves. It is removed once copied into the
-- immutable proposal; abandoned lease snapshots can be purged with leases.
CREATE TABLE lease_document_snapshots (
  lease_id              TEXT PRIMARY KEY REFERENCES leases (id) ON DELETE CASCADE,
  project_id            TEXT NOT NULL REFERENCES projects (id),
  chapter_id            TEXT NOT NULL,
  base_revision         INTEGER NOT NULL CHECK (base_revision >= 1),
  base_content_hash     TEXT NOT NULL,
  source                TEXT NOT NULL,
  created_at            TEXT NOT NULL
);

CREATE INDEX idx_lease_document_snapshots_project
  ON lease_document_snapshots (project_id, created_at);

CREATE TABLE revision_proposals (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects (id),
  chapter_id            TEXT NOT NULL,
  proposal_type         TEXT NOT NULL
    CHECK (proposal_type IN ('chapter_replacement', 'chapter_summary')),
  origin                TEXT NOT NULL
    CHECK (origin IN ('work_submission', 'direct_edit', 'summary_proposal')),
  -- Work-backed proposals retain the existing submission and Work identities.
  -- Direct edits and standalone summary proposals deliberately leave both
  -- NULL; approval still uses the same Git/validation path.
  work_item_id          TEXT,
  submission_id         TEXT,
  author_actor_id       TEXT NOT NULL REFERENCES actors (id),
  base_revision         INTEGER NOT NULL CHECK (base_revision >= 1),
  base_content_hash     TEXT NOT NULL,
  -- Snapshots are retained with the proposal so a review never needs one Git
  -- request per diff row and still shows exactly what the author compared.
  base_content          TEXT NOT NULL,
  proposed_content      TEXT NOT NULL,
  change_summary        TEXT,
  notes                 TEXT,
  status                TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN (
      'pending_review', 'applying', 'approved', 'rejected', 'conflicted',
      'withdrawn'
    )),
  reviewed_by_actor_id  TEXT REFERENCES actors (id),
  reviewed_at           TEXT,
  review_reason         TEXT,
  git_operation_id      TEXT REFERENCES git_operations (id),
  resulting_revision    INTEGER CHECK (resulting_revision IS NULL OR resulting_revision >= 1),
  commit_sha            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  CHECK (
    (origin = 'work_submission' AND work_item_id IS NOT NULL AND submission_id IS NOT NULL)
    OR
    (origin <> 'work_submission' AND work_item_id IS NULL AND submission_id IS NULL)
  ),
  CHECK (
    (status = 'pending_review'
      AND reviewed_by_actor_id IS NULL AND reviewed_at IS NULL
      AND review_reason IS NULL AND git_operation_id IS NULL
      AND resulting_revision IS NULL AND commit_sha IS NULL)
    OR status <> 'pending_review'
  )
);

CREATE UNIQUE INDEX idx_revision_proposals_submission
  ON revision_proposals (submission_id)
  WHERE submission_id IS NOT NULL;

CREATE INDEX idx_revision_proposals_project_status
  ON revision_proposals (project_id, status, id);

CREATE INDEX idx_revision_proposals_chapter
  ON revision_proposals (project_id, chapter_id, id);

CREATE INDEX idx_revision_proposals_work_item
  ON revision_proposals (work_item_id, id)
  WHERE work_item_id IS NOT NULL;

-- Proposal authorship and compared text are immutable. Review/apply state is
-- intentionally mutable, but no later command may change what was reviewed.
CREATE TRIGGER revision_proposals_immutable_payload
BEFORE UPDATE ON revision_proposals
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.chapter_id IS NOT OLD.chapter_id
  OR NEW.proposal_type IS NOT OLD.proposal_type
  OR NEW.origin IS NOT OLD.origin
  OR NEW.work_item_id IS NOT OLD.work_item_id
  OR NEW.submission_id IS NOT OLD.submission_id
  OR NEW.author_actor_id IS NOT OLD.author_actor_id
  OR NEW.base_revision IS NOT OLD.base_revision
  OR NEW.base_content_hash IS NOT OLD.base_content_hash
  OR NEW.base_content IS NOT OLD.base_content
  OR NEW.proposed_content IS NOT OLD.proposed_content
  OR NEW.change_summary IS NOT OLD.change_summary
  OR NEW.notes IS NOT OLD.notes
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'revision proposal payload is immutable');
END;
