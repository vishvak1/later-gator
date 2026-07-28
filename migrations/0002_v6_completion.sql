ALTER TABLE encrypted_credentials ADD COLUMN service_ciphertext TEXT;
ALTER TABLE encrypted_credentials ADD COLUMN service_nonce TEXT;

ALTER TABLE import_rows ADD COLUMN source_id TEXT;
ALTER TABLE import_rows ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0
  CHECK (favorite IN (0, 1));
ALTER TABLE import_rows ADD COLUMN excerpt TEXT;

CREATE TABLE login_attempts (
  client_hash TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  blocked_until TEXT
);

CREATE TABLE provider_candidates (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL CHECK (provider IN ('workers-ai', 'openai', 'anthropic')),
  model TEXT NOT NULL,
  tested_at TEXT NOT NULL,
  safe_status TEXT NOT NULL CHECK (safe_status IN ('passed', 'failed')),
  safe_error_code TEXT
);

CREATE INDEX bookmark_relationships_left
  ON bookmark_relationships(left_bookmark_id, right_bookmark_id);
CREATE INDEX bookmark_relationships_right
  ON bookmark_relationships(right_bookmark_id, left_bookmark_id);

CREATE INDEX capture_credentials_active
  ON capture_credentials(token_hash, revoked_at);

UPDATE app_state
   SET schema_version = 2,
       updated_at = CURRENT_TIMESTAMP
 WHERE id = 1;
