CREATE TABLE thumbnail_jobs (
  id TEXT PRIMARY KEY,
  bookmark_id TEXT NOT NULL UNIQUE REFERENCES bookmarks(id) ON DELETE CASCADE,
  state TEXT NOT NULL
    CHECK (state IN (
      'pending_dispatch',
      'queued',
      'running',
      'completed',
      'cancelled',
      'failed'
    )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  last_safe_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX thumbnail_jobs_ready
  ON thumbnail_jobs(state, next_attempt_at, created_at);

UPDATE app_state
   SET schema_version = 8,
       updated_at = CURRENT_TIMESTAMP
 WHERE id = 1;
