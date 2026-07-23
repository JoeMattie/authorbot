-- Keep chapter summaries in the operational projection.
--
-- The public publisher still reads chapter frontmatter at build time and
-- includes published chapters only. This column exists for authenticated
-- collaboration surfaces: they can list current draft/proposed summaries in
-- the same bounded D1 query as chapter metadata, without walking GitHub once
-- per chapter.
ALTER TABLE chapters ADD COLUMN summary TEXT;
