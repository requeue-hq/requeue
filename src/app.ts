import { Hono } from "hono";
import { cors } from "hono/cors";
import { requireApiKey } from "./auth";
import { newId } from "./crypto";
import {
  findEndpointByKey,
  findEventForProject,
  insertEndpoint,
  insertEvent,
  listEventsForProject,
  listReplayAttempts,
  updateEventStatus,
} from "./db";
import { ApiError, jsonError } from "./errors";
import { asRecord, nowIso } from "./json";
import { processPendingReplays } from "./outbox";
import { replayEventForProject } from "./replay";
import { publicAttempt, publicEndpoint, publicEvent } from "./serialize";
import type { AppEnv, EventStatus } from "./types";

const EVENT_STATUSES = new Set<EventStatus>([
  "failed",
  "pending_replay",
  "replayed",
  "replay_failed",
]);

const MAX_PAYLOAD_BYTES = 512 * 1024;

export const app = new Hono<AppEnv>();

app.use("*", cors());

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return jsonError(c, err.status, err.code, err.message);
  }
  const message = err instanceof Error ? err.message : "Internal error";
  return jsonError(c, 500, "internal_error", message);
});

app.notFound((c) => jsonError(c, 404, "not_found", "Not found"));

app.get("/health", async (c) => {
  await c.env.DB.prepare("SELECT 1 AS ok").first();
  return c.json({
    ok: true,
    service: "requeue",
    version: "0.1.0",
  });
});

app.get("/v1/billing", requireApiKey, (c) => {
  return c.json({
    billing: {
      enabled: false,
      plan: "free",
      provider: "none",
      status: "stubbed",
      message:
        "Billing is stubbed in the open-source core. This MVP runs on the Cloudflare free tier.",
    },
  });
});

app.post("/v1/endpoints", requireApiKey, async (c) => {
  const body = asRecord(await readJsonBody(c));
  if (!body) {
    return jsonError(c, 400, "invalid_body", "JSON object body required");
  }

  const targetUrl = asString(body.target_url);
  if (!targetUrl || !isHttpUrl(targetUrl)) {
    return jsonError(c, 400, "invalid_target_url", "target_url must be an http(s) URL");
  }

  const name = asString(body.name) || hostnameOf(targetUrl);
  const secret = asString(body.secret);
  const createdAt = nowIso();
  const row = {
    id: newId("ep"),
    project_id: c.get("projectId"),
    name,
    endpoint_key: newId("epk", 18),
    target_url: targetUrl,
    secret: secret || null,
    created_at: createdAt,
  };

  await insertEndpoint(c.env.DB, row);
  return c.json({ endpoint: publicEndpoint(row) }, 201);
});

app.post("/v1/ingest/:endpointKey", async (c) => {
  const endpoint = await findEndpointByKey(c.env.DB, c.req.param("endpointKey"));
  if (!endpoint) {
    return jsonError(c, 404, "unknown_endpoint", "Unknown endpoint key");
  }

  const raw = await c.req.text();
  if (byteLength(raw) > MAX_PAYLOAD_BYTES) {
    return jsonError(c, 413, "payload_too_large", "Payload exceeds 512KB");
  }

  const contentType = c.req.header("content-type") ?? "application/json";
  const ingested = parseIngestBody(raw, contentType, c.req.header("x-requeue-reason"));

  if (ingested.payload.length === 0) {
    return jsonError(c, 400, "empty_payload", "Failure payload is required");
  }

  const createdAt = nowIso();
  const event = {
    id: newId("evt"),
    endpoint_id: endpoint.id,
    status: "failed" as const,
    payload: ingested.payload,
    content_type: ingested.contentType,
    headers: ingested.headers,
    reason: ingested.reason,
    source: ingested.source,
    created_at: createdAt,
    updated_at: createdAt,
  };

  await insertEvent(c.env.DB, event);
  return c.json({ event: publicEvent(event) }, 201);
});

app.get("/v1/events", requireApiKey, async (c) => {
  const statusParam = c.req.query("status");
  if (statusParam && !EVENT_STATUSES.has(statusParam as EventStatus)) {
    return jsonError(c, 400, "invalid_status", "Unknown event status");
  }

  const limit = clampInt(c.req.query("limit"), 50, 1, 200);
  const events = await listEventsForProject(
    c.env.DB,
    c.get("projectId"),
    statusParam as EventStatus | undefined,
    limit,
  );

  return c.json({
    events: events.map(publicEvent),
    count: events.length,
  });
});

app.get("/v1/events/:id", requireApiKey, async (c) => {
  const event = await findEventForProject(c.env.DB, c.req.param("id"), c.get("projectId"));
  if (!event) {
    return jsonError(c, 404, "not_found", "Event not found");
  }

  const attempts = await listReplayAttempts(c.env.DB, event.id);
  return c.json({
    event: publicEvent(event),
    replay_attempts: attempts.map(publicAttempt),
  });
});

app.post("/v1/events/:id/replay", requireApiKey, async (c) => {
  const event = await findEventForProject(c.env.DB, c.req.param("id"), c.get("projectId"));
  if (!event) {
    return jsonError(c, 404, "not_found", "Event not found");
  }

  const body = await readOptionalJsonObject(c.req);
  if (body?.enqueue === true) {
    const updatedAt = nowIso();
    await updateEventStatus(c.env.DB, event.id, "pending_replay", updatedAt);
    return c.json({
      event: publicEvent({ ...event, status: "pending_replay", updated_at: updatedAt }),
      queued: true,
    });
  }

  const result = await replayEventForProject(c.env.DB, event, c.get("projectId"));
  return c.json({
    event: publicEvent({ ...event, status: result.eventStatus, updated_at: result.attempt.attempted_at }),
    attempt: publicAttempt(result.attempt),
    queued: false,
  });
});

app.post("/v1/internal/process-outbox", requireApiKey, async (c) => {
  const result = await processPendingReplays(c.env.DB);
  return c.json({ outbox: result });
});

async function readJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be JSON");
  }
}

async function readOptionalJsonObject(req: { text: () => Promise<string> }): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (!text.trim()) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function parseIngestBody(
  raw: string,
  contentType: string,
  reasonHeader: string | undefined,
): { payload: string; contentType: string; headers: string | null; reason: string | null; source: string | null } {
  if (contentType.includes("application/json") && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      const record = asRecord(parsed);
      if (record && Object.prototype.hasOwnProperty.call(record, "payload")) {
        const payloadValue = record.payload;
        const payload =
          typeof payloadValue === "string" ? payloadValue : JSON.stringify(payloadValue ?? null);
        const headers =
          record.headers === undefined ? null : JSON.stringify(record.headers ?? null);
        return {
          payload,
          contentType: asString(record.content_type) || "application/json",
          headers,
          reason: asString(record.reason) || reasonHeader || null,
          source: asString(record.source),
        };
      }
    } catch {
      // fall through and store the raw body
    }
  }

  return {
    payload: raw,
    contentType,
    headers: null,
    reason: reasonHeader || null,
    source: null,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function hostnameOf(value: string): string {
  try {
    return new URL(value).host || "endpoint";
  } catch {
    return "endpoint";
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
