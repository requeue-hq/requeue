-- Requeue core schema (Cloudflare D1 / SQLite)
-- Tables: projects, endpoints, events, replay_attempts, api_keys

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE endpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  endpoint_key TEXT NOT NULL UNIQUE,
  target_url TEXT NOT NULL,
  secret TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_endpoints_project_id ON endpoints(project_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'failed'
    CHECK (status IN ('failed', 'pending_replay', 'replayed', 'replay_failed')),
  payload TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/json',
  headers TEXT,
  reason TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_events_endpoint_id ON events(endpoint_id);
CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_events_created_at ON events(created_at);

-- Audit log + D1-backed outbox history for each delivery attempt.
CREATE TABLE replay_attempts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  attempted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  success INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER,
  response_body TEXT,
  error TEXT
);

CREATE INDEX idx_replay_attempts_event_id ON replay_attempts(event_id);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_api_keys_project_id ON api_keys(project_id);

-- Demo tenant + hashed management key (see README).
-- Plaintext: rq_demo_local_dev_only_do_not_use_in_prod
INSERT INTO projects (id, name) VALUES ('prj_demo', 'Demo project');

INSERT INTO api_keys (id, project_id, name, key_hash, key_prefix)
VALUES (
  'key_demo',
  'prj_demo',
  'Demo management key',
  'ea489957fc62094c0071d21898c261e18b9c04daedb39bc2f8392137fd6a6ccb',
  'rq_demo_'
);
