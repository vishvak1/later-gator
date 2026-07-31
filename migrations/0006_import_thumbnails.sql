ALTER TABLE import_rows
  ADD COLUMN thumbnail_processed_at TEXT;

CREATE INDEX import_rows_thumbnail_work
  ON import_rows(import_id, thumbnail_processed_at, row_number);

UPDATE app_state
   SET schema_version = 6,
       updated_at = CURRENT_TIMESTAMP
 WHERE id = 1;
