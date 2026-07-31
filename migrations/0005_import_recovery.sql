ALTER TABLE import_rows
  ADD COLUMN processing_token TEXT;

ALTER TABLE import_rows
  ADD COLUMN processing_started_at TEXT;

CREATE INDEX import_rows_import_processing
  ON import_rows(import_id, processing_token, processing_started_at, row_number);
