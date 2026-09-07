-- Per-endpoint ingest rate-limit windows (D1 only; no KV / Queues).
CREATE TABLE ingest_rate_windows (
  endpoint_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (endpoint_id, window_start)
);

CREATE INDEX idx_ingest_rate_windows_window_start ON ingest_rate_windows(window_start);

-- Automatic outbox retry / backoff for failed replay attempts.
ALTER TABLE events ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN next_retry_at TEXT;

CREATE INDEX idx_events_outbox ON events(status, next_retry_at);
