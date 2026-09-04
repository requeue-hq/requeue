import type { ApiKeyRow, EndpointRow, EventRow, EventStatus, ReplayAttemptRow } from "./types";

export async function findApiKeyByHash(db: D1Database, keyHash: string): Promise<ApiKeyRow | null> {
  return db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").bind(keyHash).first<ApiKeyRow>();
}

export async function insertEndpoint(
  db: D1Database,
  row: EndpointRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO endpoints (id, project_id, name, endpoint_key, target_url, secret, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.project_id,
      row.name,
      row.endpoint_key,
      row.target_url,
      row.secret,
      row.created_at,
    )
    .run();
}

export async function findEndpointByKey(
  db: D1Database,
  endpointKey: string,
): Promise<EndpointRow | null> {
  return db
    .prepare("SELECT * FROM endpoints WHERE endpoint_key = ?")
    .bind(endpointKey)
    .first<EndpointRow>();
}

export async function findEndpointForProject(
  db: D1Database,
  endpointId: string,
  projectId: string,
): Promise<EndpointRow | null> {
  return db
    .prepare("SELECT * FROM endpoints WHERE id = ? AND project_id = ?")
    .bind(endpointId, projectId)
    .first<EndpointRow>();
}

export async function insertEvent(db: D1Database, row: EventRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO events
        (id, endpoint_id, status, payload, content_type, headers, reason, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.endpoint_id,
      row.status,
      row.payload,
      row.content_type,
      row.headers,
      row.reason,
      row.source,
      row.created_at,
      row.updated_at,
    )
    .run();
}

export async function listEventsForProject(
  db: D1Database,
  projectId: string,
  status: EventStatus | undefined,
  limit: number,
): Promise<EventRow[]> {
  const query = status
    ? `SELECT e.* FROM events e
       INNER JOIN endpoints ep ON ep.id = e.endpoint_id
       WHERE ep.project_id = ? AND e.status = ?
       ORDER BY e.created_at DESC
       LIMIT ?`
    : `SELECT e.* FROM events e
       INNER JOIN endpoints ep ON ep.id = e.endpoint_id
       WHERE ep.project_id = ?
       ORDER BY e.created_at DESC
       LIMIT ?`;

  const stmt = status
    ? db.prepare(query).bind(projectId, status, limit)
    : db.prepare(query).bind(projectId, limit);

  const result = await stmt.all<EventRow>();
  return result.results ?? [];
}

export async function findEventForProject(
  db: D1Database,
  eventId: string,
  projectId: string,
): Promise<EventRow | null> {
  return db
    .prepare(
      `SELECT e.* FROM events e
       INNER JOIN endpoints ep ON ep.id = e.endpoint_id
       WHERE e.id = ? AND ep.project_id = ?`,
    )
    .bind(eventId, projectId)
    .first<EventRow>();
}

export async function listReplayAttempts(
  db: D1Database,
  eventId: string,
): Promise<ReplayAttemptRow[]> {
  const result = await db
    .prepare("SELECT * FROM replay_attempts WHERE event_id = ? ORDER BY attempted_at DESC")
    .bind(eventId)
    .all<ReplayAttemptRow>();
  return result.results ?? [];
}

export async function insertReplayAttempt(db: D1Database, row: ReplayAttemptRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO replay_attempts
        (id, event_id, attempted_at, success, status_code, response_body, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.event_id,
      row.attempted_at,
      row.success,
      row.status_code,
      row.response_body,
      row.error,
    )
    .run();
}

export async function updateEventStatus(
  db: D1Database,
  eventId: string,
  status: EventStatus,
  updatedAt: string,
): Promise<void> {
  await db
    .prepare("UPDATE events SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, updatedAt, eventId)
    .run();
}

export async function listPendingReplayEvents(db: D1Database, limit: number): Promise<EventRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM events
       WHERE status = 'pending_replay'
       ORDER BY updated_at ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<EventRow>();
  return result.results ?? [];
}

export async function findEndpointById(db: D1Database, endpointId: string): Promise<EndpointRow | null> {
  return db.prepare("SELECT * FROM endpoints WHERE id = ?").bind(endpointId).first<EndpointRow>();
}
