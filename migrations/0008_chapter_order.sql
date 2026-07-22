-- Persist chapter order in the D1 projection.
--
-- Direct chapter creation needs max(existing order) + 10. Before this column,
-- the coordinator reread every committed chapter through GitHub to recover
-- that one number. On Workers Free, a modest book could spend the entire
-- 50-subrequest budget walking the same root tree once per chapter.
ALTER TABLE chapters ADD COLUMN chapter_order REAL;

-- Make existing books usable immediately, before their next projection
-- refresh. Path order is already the projection's stable chapter listing;
-- rank every project's rows at the normal ten-point spacing. This avoids
-- assuming that `001-foo.md` means frontmatter order 1 (the standard fixtures
-- use that path with order 10). The next projection refresh replaces these
-- transitional values with the authoritative frontmatter order.
UPDATE chapters AS chapter
SET chapter_order = 10 * (
  SELECT COUNT(*)
  FROM chapters AS ordered
  WHERE ordered.project_id = chapter.project_id
    AND (
      ordered.path < chapter.path
      OR (ordered.path = chapter.path AND ordered.id <= chapter.id)
    )
);
