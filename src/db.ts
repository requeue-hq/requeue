import type {
  ApiKeyRow,
  EndpointRow,
  EventRow,
  EventStatus,
  ProjectRow,
  ReplayAttemptRow,
  WaitlistRow,
} from "./types";

export async function findApiKeyByHash(db: D1Database, keyHash: string): Promise<ApiKeyRow | null> {
  return db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").bind(keyHash).first<ApiKeyRow>();
}

export async function insertProject(db: D1Database, row: ProjectRow): Promise<void> {
  await db
    .prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)")
    .bind(row.id, row.name, row.created_at)
    .run();
}

export async function insertApiKey(db: D1Database, row: ApiKeyRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO api_keys (id, project_id, name, key_hash, key_prefix, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.project_id, row.name, row.key_hash, row.key_prefix, row.created_at)
    .run();
}

export async function listApiKeysForProject(db: D1Database, projectId: string): Promise<ApiKeyRow[]> {
  const result = await db
    .prepare("SELECT * FROM api_keys WHERE project_id = ? ORDER BY created_at DESC")
    .bind(projectId)
    .all<ApiKeyRow>();
  return result.results ?? [];
}

export async function findApiKeyForProject(
  db: D1Database,
  keyId: string,
  projectId: string,
): Promise<ApiKeyRow | null> {
  return db
    .prepare("SELECT * FROM api_keys WHERE id = ? AND project_id = ?")
    .bind(keyId, projectId)
    .first<ApiKeyRow>();
}

export async function deleteApiKey(db: D1Database, keyId: string, projectId: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM api_keys WHERE id = ? AND project_id = ?")
    .bind(keyId, projectId)
    .run();
  return (result.meta.changes ?? 0) > 0;
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

export async function listEndpointsForProject(db: D1Database, projectId: string): Promise<EndpointRow[]> {
  const result = await db
    .prepare("SELECT * FROM endpoints WHERE project_id = ? ORDER BY created_at DESC")
    .bind(projectId)
    .all<EndpointRow>();
  return result.results ?? [];
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
  endpointId?: string,
): Promise<EventRow[]> {
  const conditions = ["ep.project_id = ?"];
  const binds: Array<string | number> = [projectId];

  if (status) {
    conditions.push("e.status = ?");
    binds.push(status);
  }
  if (endpointId) {
    conditions.push("e.endpoint_id = ?");
    binds.push(endpointId);
  }

  const query = `SELECT e.* FROM events e
       INNER JOIN endpoints ep ON ep.id = e.endpoint_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY e.created_at DESC
       LIMIT ?`;
  binds.push(limit);

  const result = await db.prepare(query).bind(...binds).all<EventRow>();
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
  if (status === "replayed") {
    await db
      .prepare("UPDATE events SET status = ?, updated_at = ?, next_retry_at = NULL WHERE id = ?")
      .bind(status, updatedAt, eventId)
      .run();
    return;
  }

  await db
    .prepare("UPDATE events SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, updatedAt, eventId)
    .run();
}

export async function markEventPendingReplay(
  db: D1Database,
  eventId: string,
  updatedAt: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE events
       SET status = 'pending_replay', updated_at = ?, retry_count = 0, next_retry_at = ?
       WHERE id = ?`,
    )
    .bind(updatedAt, updatedAt, eventId)
    .run();
}

export async function updateEventReplaySchedule(
  db: D1Database,
  eventId: string,
  fields: {
    status: EventStatus;
    updatedAt: string;
    retryCount: number;
    nextRetryAt: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE events
       SET status = ?, updated_at = ?, retry_count = ?, next_retry_at = ?
       WHERE id = ?`,
    )
    .bind(fields.status, fields.updatedAt, fields.retryCount, fields.nextRetryAt, eventId)
    .run();
}

export async function listPendingReplayEvents(
  db: D1Database,
  limit: number,
  now: string,
): Promise<EventRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM events
       WHERE status = 'pending_replay'
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY COALESCE(next_retry_at, updated_at) ASC
       LIMIT ?`,
    )
    .bind(now, limit)
    .all<EventRow>();
  return result.results ?? [];
}

export async function findEndpointById(db: D1Database, endpointId: string): Promise<EndpointRow | null> {
  return db.prepare("SELECT * FROM endpoints WHERE id = ?").bind(endpointId).first<EndpointRow>();
}

export async function upsertWaitlistSignup(db: D1Database, row: WaitlistRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO waitlist (id, email, product, source, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         product = COALESCE(excluded.product, waitlist.product),
         source = COALESCE(excluded.source, waitlist.source)`,
    )
    .bind(row.id, row.email, row.product, row.source, row.created_at)
    .run();
}
