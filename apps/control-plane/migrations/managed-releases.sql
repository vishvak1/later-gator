ALTER TABLE installer_authorizations ADD COLUMN revoked_at INTEGER;
ALTER TABLE installations ADD COLUMN installed_release TEXT;
ALTER TABLE installations ADD COLUMN desired_release TEXT NOT NULL DEFAULT '1.0.0';
ALTER TABLE installations ADD COLUMN rollout_cohort INTEGER NOT NULL DEFAULT 0;
ALTER TABLE installations ADD COLUMN update_status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE installations ADD COLUMN current_version_id TEXT;
ALTER TABLE installations ADD COLUMN previous_version_id TEXT;

CREATE TABLE IF NOT EXISTS installation_resources (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_by_later_gator INTEGER NOT NULL,
  status TEXT NOT NULL,
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
  schema_version INTEGER NOT NULL,
  version_id TEXT,
  deployment_id TEXT,
  previous_version_id TEXT,
  time_travel_bookmark TEXT,
  state TEXT NOT NULL,
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
  phase TEXT NOT NULL,
  time_travel_bookmark TEXT,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, migration_id)
);

CREATE TABLE IF NOT EXISTS rollout_campaigns (
  release TEXT PRIMARY KEY,
  cohort_ceiling INTEGER NOT NULL,
  state TEXT NOT NULL,
  attempted_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  failure_threshold_percent INTEGER NOT NULL DEFAULT 10,
  updated_at INTEGER NOT NULL
);
