-- Dismiss without replay: status 'resolved' plus an optional operator note.
-- SQLite cannot ALTER a CHECK constraint, so rebuild events (and the
-- replay_attempts child that references it) and keep ON DELETE CASCADE.
-- Order matters with foreign keys enabled: copy both tables, drop the child,
-- drop events, then rename. Indexes are recreated on the new tables.

CREATE TABLE events_new (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'failed'
    CHECK (status IN ('failed', 'pending_replay', 'replayed', 'replay_failed', 'resolved')),
  payload TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/json',
  headers TEXT,
  reason TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  delivery_payload TEXT,
  delivery_headers TEXT,
  resolve_note TEXT
);

INSERT INTO events_new (
  id, endpoint_id, status, payload, content_type, headers, reason, source,
  created_at, updated_at, retry_count, next_retry_at, delivery_payload, delivery_headers
)
SELECT
  id, endpoint_id, status, payload, content_type, headers, reason, source,
  created_at, updated_at, retry_count, next_retry_at, delivery_payload, delivery_headers
FROM events;

CREATE TABLE replay_attempts_new (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events_new(id) ON DELETE CASCADE,
  attempted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  success INTEGER NOT NULL DEFAULT 0,
  status_code INTEGER,
  response_body TEXT,
  error TEXT
);

INSERT INTO replay_attempts_new (
  id, event_id, attempted_at, success, status_code, response_body, error
)
SELECT
  id, event_id, attempted_at, success, status_code, response_body, error
FROM replay_attempts;

DROP TABLE replay_attempts;
DROP TABLE events;

ALTER TABLE events_new RENAME TO events;
ALTER TABLE replay_attempts_new RENAME TO replay_attempts;

CREATE INDEX idx_events_endpoint_id ON events(endpoint_id);
CREATE INDEX idx_events_status ON events(status);
CREATE INDEX idx_events_created_at ON events(created_at);
CREATE INDEX idx_events_outbox ON events(status, next_retry_at);
CREATE INDEX idx_replay_attempts_event_id ON replay_attempts(event_id);
