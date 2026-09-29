-- Optional https URL notified when ingest stores a new failed event.
-- Nullable: omit means no alert. Ingest must not depend on the POST succeeding.
ALTER TABLE endpoints ADD COLUMN alert_url TEXT;
