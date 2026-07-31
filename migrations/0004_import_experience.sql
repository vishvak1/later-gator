ALTER TABLE import_sessions
  ADD COLUMN previous_owner_ai_paused INTEGER NOT NULL DEFAULT 0
  CHECK (previous_owner_ai_paused IN (0, 1));

ALTER TABLE import_rows ADD COLUMN existing_bookmark_id TEXT;

UPDATE app_state
   SET schema_version = 4,
       updated_at = CURRENT_TIMESTAMP
 WHERE id = 1;
