import { parseJson } from "./json";
import type { ApiKeyRow, EndpointRow, EventRow, ProjectRow, ReplayAttemptRow } from "./types";

export function publicProject(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
  };
}

export function publicApiKey(row: ApiKeyRow, token?: string) {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    key_prefix: row.key_prefix,
    created_at: row.created_at,
    ...(token ? { token } : {}),
  };
}

export function publicEndpoint(row: EndpointRow) {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    endpoint_key: row.endpoint_key,
    target_url: row.target_url,
    ingest_path: `/v1/ingest/${row.endpoint_key}`,
    has_secret: Boolean(row.secret),
    created_at: row.created_at,
  };
}

export function publicEvent(row: EventRow) {
  return {
    id: row.id,
    endpoint_id: row.endpoint_id,
    status: row.status,
    payload: parseJson(row.payload),
    content_type: row.content_type,
    headers: parseJson(row.headers),
    reason: row.reason,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
    retry_count: row.retry_count ?? 0,
    next_retry_at: row.next_retry_at ?? null,
  };
}

export function publicAttempt(row: ReplayAttemptRow) {
  return {
    id: row.id,
    event_id: row.event_id,
    attempted_at: row.attempted_at,
    success: Boolean(row.success),
    status_code: row.status_code,
    response_body: row.response_body,
    error: row.error,
  };
}
