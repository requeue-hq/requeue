-- Optional automatic retry of captured failures. Off by default.
-- Cron already scans events.status = 'pending_replay'. auto_retry = 1
-- makes ingest and a failed relay put the new row on that same outbox.
-- retry_max_attempts / retry_base_delay_seconds are the outbox budget for
-- every queued delivery to this endpoint (auto-retry and manual enqueue).
ALTER TABLE endpoints ADD COLUMN auto_retry INTEGER NOT NULL DEFAULT 0;
ALTER TABLE endpoints ADD COLUMN retry_max_attempts INTEGER NOT NULL DEFAULT 6;
ALTER TABLE endpoints ADD COLUMN retry_base_delay_seconds INTEGER NOT NULL DEFAULT 60;
