import { hmacSha256Hex, newId } from "./crypto";
import {
  findEndpointById,
  findEndpointForProject,
  insertReplayAttempt,
  updateEventStatus,
} from "./db";
import { ApiError } from "./errors";
import { nowIso, truncate } from "./json";
import type { EndpointRow, EventRow, ReplayAttemptRow } from "./types";

export type ReplayResult = {
  attempt: ReplayAttemptRow;
  eventStatus: EventRow["status"];
};

export async function replayEvent(
  db: D1Database,
  event: EventRow,
  endpoint: EndpointRow,
): Promise<ReplayResult> {
  const attemptedAt = nowIso();
  const attemptId = newId("rpl");

  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let error: string | null = null;
  let success = false;

  try {
    const headers = await buildReplayHeaders(event, endpoint);
    const response = await fetch(endpoint.target_url, {
      method: "POST",
      headers,
      body: event.payload,
    });
    statusCode = response.status;
    responseBody = truncate(await response.text());
    success = response.ok;
  } catch (err) {
    error = err instanceof Error ? err.message : "Replay request failed";
  }

  const eventStatus = success ? "replayed" : "replay_failed";
  const attempt: ReplayAttemptRow = {
    id: attemptId,
    event_id: event.id,
    attempted_at: attemptedAt,
    success: success ? 1 : 0,
    status_code: statusCode,
    response_body: responseBody,
    error,
  };

  await insertReplayAttempt(db, attempt);
  await updateEventStatus(db, event.id, eventStatus, attemptedAt);

  return { attempt, eventStatus };
}

export async function replayEventForProject(
  db: D1Database,
  event: EventRow,
  projectId: string,
): Promise<ReplayResult> {
  const endpoint = await findEndpointForProject(db, event.endpoint_id, projectId);
  if (!endpoint) {
    throw new ApiError(410, "endpoint_gone", "Endpoint has been deleted");
  }
  return replayEvent(db, event, endpoint);
}

export async function replayEventUnscoped(db: D1Database, event: EventRow): Promise<ReplayResult> {
  const endpoint = await findEndpointById(db, event.endpoint_id);
  if (!endpoint) {
    throw new ApiError(410, "endpoint_gone", "Endpoint has been deleted");
  }
  return replayEvent(db, event, endpoint);
}

async function buildReplayHeaders(event: EventRow, endpoint: EndpointRow): Promise<Headers> {
  const headers = new Headers();
  headers.set("content-type", event.content_type || "application/json");
  headers.set("x-requeue-event-id", event.id);
  headers.set("x-requeue-endpoint-id", endpoint.id);

  if (event.headers) {
    try {
      const stored = JSON.parse(event.headers) as Record<string, unknown>;
      for (const [key, value] of Object.entries(stored)) {
        if (typeof value === "string" && isSafeForwardHeader(key)) {
          headers.set(key, value);
        }
      }
    } catch {
      // stored headers are advisory; ignore malformed JSON
    }
  }

  if (endpoint.secret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await hmacSha256Hex(
      endpoint.secret,
      `${timestamp}.${event.id}.${event.payload}`,
    );
    headers.set("x-requeue-timestamp", timestamp);
    headers.set("x-requeue-signature", `sha256=${signature}`);
  }

  return headers;
}

function isSafeForwardHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "host" || lower === "content-length" || lower === "connection") return false;
  if (lower.startsWith("x-requeue-")) return false;
  return true;
}
