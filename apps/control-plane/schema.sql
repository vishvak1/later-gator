PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  subject_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS control_sessions (
  session_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS control_sessions_owner
  ON control_sessions (owner_id, expires_at);

CREATE TABLE IF NOT EXISTS runtime_login_requests (
  request_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  callback_url TEXT NOT NULL,
  nonce TEXT NOT NULL,
  runtime_state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS runtime_login_requests_expiry
  ON runtime_login_requests (expires_at);

CREATE TABLE IF NOT EXISTS oauth_installer_requests (
  state_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  storage_mode TEXT NOT NULL CHECK (storage_mode IN ('kv', 'r2')),
  requested_scopes_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS oauth_installer_requests_owner
  ON oauth_installer_requests (owner_id, expires_at);

CREATE TABLE IF NOT EXISTS installer_authorizations (
  owner_id TEXT PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL UNIQUE,
  token_ciphertext TEXT NOT NULL,
  token_nonce TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  granted_scopes_json TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS installer_authorizations_account
  ON installer_authorizations (account_id);

CREATE TABLE IF NOT EXISTS installations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL UNIQUE REFERENCES owners(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL UNIQUE,
  storage_mode TEXT NOT NULL CHECK (storage_mode IN ('kv', 'r2')),
  requested_plan_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'authorized', 'provisioning', 'waiting_for_r2', 'ready', 'failed', 'cleanup_pending'
  )),
  current_step TEXT NOT NULL,
  safe_error_code TEXT,
  installed_release TEXT,
  desired_release TEXT NOT NULL DEFAULT '1.0.0',
  rollout_cohort INTEGER NOT NULL DEFAULT 0 CHECK (rollout_cohort BETWEEN 0 AND 99),
  update_status TEXT NOT NULL DEFAULT 'idle' CHECK (update_status IN (
    'idle', 'queued', 'migrating', 'uploading', 'health_check', 'promoting', 'complete', 'failed', 'paused'
  )),
  current_version_id TEXT,
  previous_version_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS installations_account
  ON installations (account_id);

CREATE TABLE IF NOT EXISTS provisioning_steps (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  step_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  resource_id TEXT,
  safe_error_code TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, step_code)
);

CREATE TABLE IF NOT EXISTS installation_resources (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN (
    'd1', 'oauth_kv', 'thumbnail_kv', 'thumbnail_r2', 'vectorize',
    'background_queue', 'thumbnail_queue', 'worker'
  )),
  resource_name TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_by_later_gator INTEGER NOT NULL CHECK (created_by_later_gator IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'cleanup_pending', 'deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, resource_type),
  UNIQUE (installation_id, resource_name)
);

CREATE TABLE IF NOT EXISTS runtime_release_history (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  release TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
  version_id TEXT,
  deployment_id TEXT,
  previous_version_id TEXT,
  time_travel_bookmark TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'migrating', 'uploaded', 'healthy', 'promoted', 'failed', 'rolled_back'
  )),
  safe_error_code TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (installation_id, release)
);

CREATE TABLE IF NOT EXISTS control_schema_migrations (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  migration_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  from_schema_version INTEGER NOT NULL,
  to_schema_version INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('expand', 'migrate', 'contract')),
  time_travel_bookmark TEXT,
  state TEXT NOT NULL CHECK (state IN ('running', 'complete', 'failed')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, migration_id)
);

CREATE TABLE IF NOT EXISTS rollout_campaigns (
  release TEXT PRIMARY KEY,
  cohort_ceiling INTEGER NOT NULL CHECK (cohort_ceiling BETWEEN 0 AND 100),
  state TEXT NOT NULL CHECK (state IN ('canary', 'rolling', 'paused', 'complete')),
  attempted_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  failure_threshold_percent INTEGER NOT NULL DEFAULT 10 CHECK (
    failure_threshold_percent BETWEEN 1 AND 100
  ),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS installation_runtime_metadata (
  installation_id TEXT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  worker_origin TEXT NOT NULL,
  current_release TEXT,
  health_status TEXT NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('unknown', 'ready', 'unavailable')),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS extension_connect_requests (
  request_hash TEXT PRIMARY KEY,
  redirect_uri TEXT NOT NULL,
  extension_state TEXT NOT NULL,
  extension_device_id TEXT NOT NULL,
  extension_device_name TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS extension_connect_requests_expiry
  ON extension_connect_requests (expires_at);

CREATE TABLE IF NOT EXISTS extension_pairing_grants (
  jti_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  extension_device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS control_audit_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES owners(id) ON DELETE SET NULL,
  event_code TEXT NOT NULL CHECK (event_code IN (
    'identity_login_succeeded',
    'identity_logout_succeeded'
  )),
  occurred_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS control_audit_events_owner
  ON control_audit_events (owner_id, occurred_at);
