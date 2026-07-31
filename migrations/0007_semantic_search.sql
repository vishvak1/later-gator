-- Semantic search support: track which bookmark revision has been embedded
-- into Vectorize so a backlog query can find bookmarks needing (re)embedding.
ALTER TABLE bookmarks ADD COLUMN embedded_revision INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_bookmarks_embed_backlog
  ON bookmarks (modified_at DESC)
  WHERE deleted_at IS NULL AND embedded_revision != revision;
