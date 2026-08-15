CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  setup_status TEXT NOT NULL CHECK (setup_status IN ('setup_incomplete', 'ready')),
  setup_completed_at TEXT,
  owner_ai_paused INTEGER NOT NULL DEFAULT 0 CHECK (owner_ai_paused IN (0, 1)),
  owner_pause_reason TEXT,
  organization_generation INTEGER NOT NULL DEFAULT 1,
  browser_blocked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO app_state (id, setup_status, created_at, updated_at)
VALUES (1, 'setup_incomplete', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  personal_instructions TEXT,
  timezone TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('permanent', 'system')),
  sort_order INTEGER NOT NULL UNIQUE,
  is_ai_destination INTEGER NOT NULL CHECK (is_ai_destination IN (0, 1))
);

INSERT OR IGNORE INTO folders (id, slug, name, kind, sort_order, is_ai_destination) VALUES
  ('folder_social_posts', 'social-posts', 'Social Posts', 'permanent', 10, 1),
  ('folder_articles', 'articles', 'Articles', 'permanent', 20, 1),
  ('folder_videos_talks', 'videos-talks', 'Videos & Talks', 'permanent', 30, 1),
  ('folder_code', 'code', 'Code', 'permanent', 40, 1),
  ('folder_docs_reference', 'docs-reference', 'Docs & Reference', 'permanent', 50, 1),
  ('folder_papers', 'papers', 'Papers', 'permanent', 60, 1),
  ('folder_websites_apps', 'websites-apps', 'Websites & Apps', 'permanent', 70, 1),
  ('folder_need_review', 'need-review', 'Need for Review', 'permanent', 80, 1),
  ('folder_unsorted', 'unsorted', 'Unsorted', 'system', 90, 0);

CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  hostname TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  note TEXT,
  folder_id TEXT NOT NULL REFERENCES folders(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
  source_type TEXT NOT NULL CHECK (source_type IN ('dashboard', 'extension', 'ios', 'raindrop_csv', 'linked')),
  organization_policy TEXT NOT NULL CHECK (organization_policy IN ('full', 'preserve', 'none')),
  ai_state TEXT NOT NULL CHECK (ai_state IN (
    'pending', 'processing', 'waiting_provider', 'paused_owner', 'complete', 'review', 'failed'
  )),
  ai_managed_description INTEGER NOT NULL DEFAULT 0 CHECK (ai_managed_description IN (0, 1)),
  source_created_at TEXT NOT NULL,
  added_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  deleted_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  embedded_revision INTEGER NOT NULL DEFAULT 0,
  thumbnail_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS bookmarks_active_normalized_url_unique
  ON bookmarks(normalized_url) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS bookmarks_folder_modified ON bookmarks(folder_id, modified_at DESC, id);
CREATE INDEX IF NOT EXISTS bookmarks_added ON bookmarks(added_at DESC, id);
CREATE INDEX IF NOT EXISTS bookmarks_source_created ON bookmarks(source_created_at DESC, id);
CREATE INDEX IF NOT EXISTS bookmarks_hostname ON bookmarks(hostname, id);
CREATE INDEX IF NOT EXISTS bookmarks_favorite ON bookmarks(favorite, id);
CREATE INDEX IF NOT EXISTS bookmarks_ai_state ON bookmarks(ai_state, id);
CREATE INDEX IF NOT EXISTS bookmarks_deleted ON bookmarks(deleted_at, id);
CREATE INDEX IF NOT EXISTS bookmarks_embed_backlog
  ON bookmarks(modified_at DESC) WHERE deleted_at IS NULL AND embedded_revision != revision;

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  normalized_name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_by TEXT NOT NULL CHECK (created_by IN ('seed', 'user', 'ai', 'import')),
  usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  created_at TEXT NOT NULL,
  retired_at TEXT
);

CREATE TABLE IF NOT EXISTS bookmark_tags (
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('user', 'ai', 'import')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (bookmark_id, tag_id)
);

CREATE INDEX IF NOT EXISTS bookmark_tags_by_tag ON bookmark_tags(tag_id, bookmark_id);

CREATE TABLE IF NOT EXISTS bookmark_relationships (
  id TEXT PRIMARY KEY,
  left_bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  right_bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL DEFAULT 'related' CHECK (relationship_type = 'related'),
  created_at TEXT NOT NULL,
  CHECK (left_bookmark_id < right_bookmark_id),
  UNIQUE (left_bookmark_id, right_bookmark_id, relationship_type)
);

CREATE INDEX IF NOT EXISTS bookmark_relationships_left
  ON bookmark_relationships(left_bookmark_id, right_bookmark_id);
CREATE INDEX IF NOT EXISTS bookmark_relationships_right
  ON bookmark_relationships(right_bookmark_id, left_bookmark_id);

CREATE TABLE IF NOT EXISTS thumbnails (
  id TEXT PRIMARY KEY,
  bookmark_id TEXT NOT NULL UNIQUE REFERENCES bookmarks(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  source_type TEXT NOT NULL CHECK (source_type IN ('import_cover', 'page_metadata', 'screenshot', 'favicon', 'user')),
  source_url_hash TEXT,
  etag TEXT,
  state TEXT NOT NULL CHECK (state IN ('ready', 'stale', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS background_jobs (
  id TEXT PRIMARY KEY,
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL DEFAULT 'process_bookmark' CHECK (job_type = 'process_bookmark'),
  state TEXT NOT NULL CHECK (state IN (
    'pending_dispatch', 'queued', 'running', 'waiting_provider', 'paused_owner',
    'completed', 'review', 'cancelled', 'failed'
  )),
  expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
  organization_generation INTEGER NOT NULL CHECK (organization_generation > 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  quality_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (quality_attempt_count >= 0),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  next_attempt_at TEXT,
  last_safe_error_code TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  browser_rendered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS background_jobs_one_active_per_bookmark
  ON background_jobs(bookmark_id)
  WHERE state IN ('pending_dispatch', 'queued', 'running', 'waiting_provider', 'paused_owner');
CREATE INDEX IF NOT EXISTS background_jobs_ready
  ON background_jobs(state, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS thumbnail_jobs (
  id TEXT PRIMARY KEY,
  bookmark_id TEXT NOT NULL UNIQUE REFERENCES bookmarks(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN (
    'pending_dispatch', 'queued', 'running', 'completed', 'cancelled', 'failed'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  last_safe_error_code TEXT,
  candidate_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS thumbnail_jobs_ready
  ON thumbnail_jobs(state, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS auth_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  kdf_name TEXT NOT NULL,
  kdf_iterations INTEGER NOT NULL,
  salt TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  wrap_nonce TEXT NOT NULL,
  verifier_ciphertext TEXT NOT NULL,
  verifier_nonce TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  encrypted_data_key TEXT NOT NULL,
  data_key_nonce TEXT NOT NULL,
  csrf_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(idle_expires_at, absolute_expires_at);

CREATE TABLE IF NOT EXISTS encrypted_credentials (
  id TEXT PRIMARY KEY,
  credential_type TEXT NOT NULL UNIQUE,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  service_ciphertext TEXT,
  service_nonce TEXT,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL CHECK (provider IN ('workers-ai', 'openai', 'anthropic')),
  model TEXT NOT NULL,
  operational_status TEXT NOT NULL DEFAULT 'ready' CHECK (operational_status IN ('ready', 'waiting')),
  last_safe_error_code TEXT,
  ai_gateway_id TEXT,
  retry_after TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO provider_settings (id, provider, model, updated_at)
VALUES (1, 'workers-ai', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS provider_candidates (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL CHECK (provider IN ('workers-ai', 'openai', 'anthropic')),
  model TEXT NOT NULL,
  tested_at TEXT NOT NULL,
  safe_status TEXT NOT NULL CHECK (safe_status IN ('passed', 'failed')),
  safe_error_code TEXT
);

CREATE TABLE IF NOT EXISTS capture_credentials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS capture_credentials_active
  ON capture_credentials(token_hash, revoked_at);

CREATE TABLE IF NOT EXISTS mcp_connections (
  id TEXT PRIMARY KEY,
  oauth_grant_id TEXT NOT NULL UNIQUE,
  client_id_hash TEXT NOT NULL,
  client_type TEXT NOT NULL CHECK (client_type IN ('chatgpt', 'claude', 'other')),
  display_name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope = 'library:read'),
  connected_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS mcp_connections_active
  ON mcp_connections(revoked_at, connected_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_records (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE TABLE IF NOT EXISTS login_attempts (
  client_hash TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  blocked_until TEXT
);

CREATE TABLE IF NOT EXISTS import_sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('committing', 'committed', 'cancelled', 'expired')),
  option TEXT NOT NULL CHECK (option IN ('reorganize', 'preserve')),
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size >= 0),
  file_sha256 TEXT NOT NULL,
  total_rows INTEGER NOT NULL DEFAULT 0,
  valid_rows INTEGER NOT NULL DEFAULT 0,
  invalid_rows INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  committed_rows INTEGER NOT NULL DEFAULT 0,
  failed_rows INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  committed_at TEXT
);

CREATE INDEX IF NOT EXISTS import_sessions_status ON import_sessions(status, expires_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  subject_id TEXT,
  safe_outcome TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_created ON audit_events(created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS bookmarks_fts USING fts5(
  bookmark_id UNINDEXED,
  title,
  description,
  note,
  hostname,
  url
);

CREATE TRIGGER IF NOT EXISTS bookmarks_fts_insert AFTER INSERT ON bookmarks BEGIN
  INSERT INTO bookmarks_fts (bookmark_id, title, description, note, hostname, url)
  VALUES (new.id, new.title, COALESCE(new.description, ''), COALESCE(new.note, ''), new.hostname, new.url);
END;

CREATE TRIGGER IF NOT EXISTS bookmarks_fts_update
AFTER UPDATE OF title, description, note, hostname, url ON bookmarks BEGIN
  DELETE FROM bookmarks_fts WHERE bookmark_id = old.id;
  INSERT INTO bookmarks_fts (bookmark_id, title, description, note, hostname, url)
  VALUES (new.id, new.title, COALESCE(new.description, ''), COALESCE(new.note, ''), new.hostname, new.url);
END;

CREATE TRIGGER IF NOT EXISTS bookmarks_fts_delete AFTER DELETE ON bookmarks BEGIN
  DELETE FROM bookmarks_fts WHERE bookmark_id = old.id;
END;
