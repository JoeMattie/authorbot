-- Phase 11 slice 2: chapter-navigation activity is derived from operational
-- rows in one bounded aggregate query. These covering prefixes keep that read
-- on indexed project/chapter/status paths as a book's collaboration history
-- grows; no chapter performs its own database or GitHub request.

CREATE INDEX idx_chapters_project_id
  ON chapters (project_id, id);

CREATE INDEX idx_annotations_project_chapter_activity
  ON annotations (project_id, chapter_id, status, kind, scope);

CREATE INDEX idx_replies_annotation_status
  ON replies (annotation_id, status, project_id);

CREATE INDEX idx_work_items_project_chapter_status
  ON work_items (project_id, chapter_id, status);
