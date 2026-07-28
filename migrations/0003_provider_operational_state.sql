ALTER TABLE provider_settings ADD COLUMN operational_status TEXT NOT NULL DEFAULT 'ready'
  CHECK (operational_status IN ('ready', 'waiting'));
ALTER TABLE provider_settings ADD COLUMN last_safe_error_code TEXT;

UPDATE app_state
   SET schema_version = 3,
       updated_at = CURRENT_TIMESTAMP
 WHERE id = 1;
