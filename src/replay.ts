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

/** This-delivery-only body. Omitted keys keep the stored ingest corpse. */
export type ReplayOverride = {
  payload?: string;
  headers?: string | null;
};

export async function replayEvent(
  db: D1Database,
  event: EventRow,
  endpoint: EndpointRow,
  override?: ReplayOverride,
): Promise<ReplayResult> {
  const attemptedAt = nowIso();
  const attemptId = newId("rpl");
  const delivery = resolveReplayDelivery(event, override);

  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let error: string | null = null;
  let success = false;

  try {
    const headers = await buildReplayHeaders(event, endpoint, delivery);
    const response = await fetch(endpoint.target_url, {
      method: "POST",
      headers,
      body: delivery.payload,
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
  override?: ReplayOverride,
): Promise<ReplayResult> {
  const endpoint = await findEndpointForProject(db, event.endpoint_id, projectId);
  if (!endpoint) {
    throw new ApiError(410, "endpoint_gone", "Endpoint has been deleted");
  }
  return replayEvent(db, event, endpoint, override);
}

export async function replayEventUnscoped(
  db: D1Database,
  event: EventRow,
  override?: ReplayOverride,
): Promise<ReplayResult> {
  const endpoint = await findEndpointById(db, event.endpoint_id);
  if (!endpoint) {
    throw new ApiError(410, "endpoint_gone", "Endpoint has been deleted");
  }
  return replayEvent(db, event, endpoint, override);
}

/** Read a queued override off the outbox row (`delivery_*`), if one was stored. */
export function replayOverrideFromEvent(event: EventRow): ReplayOverride | undefined {
  const override: ReplayOverride = {};
  if (event.delivery_payload != null) override.payload = event.delivery_payload;
  if (event.delivery_headers != null) override.headers = event.delivery_headers;
  return override.payload !== undefined || override.headers !== undefined ? override : undefined;
}

function resolveReplayDelivery(
  event: EventRow,
  override?: ReplayOverride,
): { payload: string; headers: string | null } {
  return {
    payload: override?.payload ?? event.payload,
    headers:
      override && Object.prototype.hasOwnProperty.call(override, "headers")
        ? (override.headers ?? null)
        : event.headers,
  };
}

async function buildReplayHeaders(
  event: EventRow,
  endpoint: EndpointRow,
  delivery: { payload: string; headers: string | null },
): Promise<Headers> {
  const headers = new Headers();
  headers.set("content-type", event.content_type || "application/json");
  headers.set("x-requeue-event-id", event.id);
  headers.set("x-requeue-endpoint-id", endpoint.id);

  if (delivery.headers) {
    try {
      const stored = JSON.parse(delivery.headers) as Record<string, unknown> | null;
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        for (const [key, value] of Object.entries(stored)) {
          if (typeof value === "string" && isSafeForwardHeader(key)) {
            headers.set(key, value);
          }
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
      `${timestamp}.${event.id}.${delivery.payload}`,
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
