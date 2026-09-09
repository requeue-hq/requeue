-- Marketing waitlist (unauthenticated POST /v1/waitlist).
-- Emails are stored lowercase; UNIQUE so re-submits stay idempotent.
CREATE TABLE waitlist (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  product TEXT,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_waitlist_created_at ON waitlist(created_at);

-- Light per-client rate-limit windows (D1 only; no KV).
CREATE TABLE waitlist_rate_windows (
  client_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_key, window_start)
);

CREATE INDEX idx_waitlist_rate_windows_window_start ON waitlist_rate_windows(window_start);
