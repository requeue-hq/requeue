-- Per-delivery replay overrides for edit-before-replay.
-- These columns are the outbox row's delivery body only. They do NOT replace
-- events.payload / events.headers, which remain the ingest audit corpse.
ALTER TABLE events ADD COLUMN delivery_payload TEXT;
ALTER TABLE events ADD COLUMN delivery_headers TEXT;
