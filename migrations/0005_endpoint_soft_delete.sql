-- Soft-delete endpoints. events.endpoint_id is ON DELETE CASCADE, so a hard
-- delete would wipe inbox history and replay_attempts. deleted_at keeps the
-- row (and events) while list/get/ingest ignore it.
ALTER TABLE endpoints ADD COLUMN deleted_at TEXT;

CREATE INDEX idx_endpoints_project_deleted_at ON endpoints(project_id, deleted_at);
