import { Hono } from "hono";
import { cors } from "hono/cors";
import { bearerToken, requireApiKey, resolveApiKey } from "./auth";
import { newApiKeyToken, newId, secretsMatch, sha256Hex } from "./crypto";
import {
  deleteApiKey,
  findApiKeyForProject,
  findEndpointByKey,
  findEndpointForProject,
  findEventForProject,
  insertApiKey,
  insertEndpoint,
  insertEvent,
  insertProject,
  listApiKeysForProject,
  listEndpointsForProject,
  listEventsForProject,
  listReplayAttempts,
  markEventPendingReplay,
  upsertWaitlistSignup,
} from "./db";
import { ApiError, jsonError } from "./errors";
import { asRecord, nowIso } from "./json";
import { processPendingReplays } from "./outbox";
import {
  consumeIngestRateLimit,
  consumeWaitlistRateLimit,
  parseIngestRateLimit,
  parseWaitlistRateLimit,
} from "./ratelimit";
import { replayEventForProject } from "./replay";
import { publicApiKey, publicAttempt, publicEndpoint, publicEvent, publicProject } from "./serialize";
import type { ApiKeyRow, AppEnv, EventStatus, ProjectRow } from "./types";

const EVENT_STATUSES = new Set<EventStatus>([
  "failed",
  "pending_replay",
  "replayed",
  "replay_failed",
]);

const ENDPOINT_ID_RE = /^ep_[0-9a-f]+$/;

const MAX_PAYLOAD_BYTES = 512 * 1024;

const MAX_WAITLIST_FIELD_CHARS = 128;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Marketing site origins that POST /v1/waitlist (and the dashboard) from the browser. */
export const MARKETING_ORIGINS = ["https://getrequeue.com", "https://www.getrequeue.com"] as const;

export const app = new Hono<AppEnv>();

app.use(
  "*",
  cors({
    origin: (origin) => allowCorsOrigin(origin),
  }),
);

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

app.post("/v1/waitlist", async (c) => {
  const limit = parseWaitlistRateLimit(c.env.WAITLIST_RATE_LIMIT);
  const rate = await consumeWaitlistRateLimit(c.env.DB, waitlistClientKey(c), limit);
  if (!rate.allowed) {
    const retryAfter = String(rate.retryAfterSeconds);
    c.header("Retry-After", retryAfter);
    return jsonError(
      c,
      429,
      "rate_limited",
      `Waitlist rate limit exceeded (${rate.limit} per minute). Retry after ${retryAfter}s.`,
    );
  }

  const parsed = await readJsonBody(c);
  const body = asRecord(parsed);
  if (!body) {
    return jsonError(c, 400, "invalid_body", "JSON object body required");
  }

  const email = normalizeEmail(body.email);
  if (!email) {
    return jsonError(c, 400, "invalid_email", "email is required");
  }
  if (!isValidEmail(email)) {
    return jsonError(c, 400, "invalid_email", "email must be a valid email address");
  }

  const product = optionalWaitlistField(body.product);
  const source = optionalWaitlistField(body.source);
  if (product === false || source === false) {
    return jsonError(c, 400, "invalid_body", "product and source must be short strings when provided");
  }

  const createdAt = nowIso();
  await upsertWaitlistSignup(c.env.DB, {
    id: newId("wl"),
    email,
    product,
    source,
    created_at: createdAt,
  });

  console.log(
    JSON.stringify({
      msg: "waitlist_signup",
      email,
      product,
      source,
    }),
  );

  return c.json({ ok: true });
});

app.post("/v1/api-keys", async (c) => {
  const body = (await readOptionalJsonObject(c.req)) ?? {};
  const name = asString(body.name) || "Management key";
  const authorization = c.req.header("Authorization");

  if (authorization) {
    if (!authorization.startsWith("Bearer ")) {
      return jsonError(c, 401, "unauthorized", "Missing Authorization: Bearer <api_key>");
    }
    if (!bearerToken(authorization)) {
      return jsonError(c, 401, "unauthorized", "Missing API key");
    }
    const existing = await resolveApiKey(c.env.DB, authorization);
    if (!existing) {
      return jsonError(c, 401, "unauthorized", "Invalid API key");
    }
    const minted = await mintApiKey(c.env.DB, existing.project_id, name);
    return c.json({ api_key: publicApiKey(minted.row, minted.token) }, 201);
  }

  const provided = c.req.header("X-Requeue-Bootstrap-Secret")?.trim() ?? "";
  const expected = c.env.BOOTSTRAP_SECRET?.trim() ?? "";
  if (!(await secretsMatch(provided, expected))) {
    return jsonError(c, 401, "unauthorized", "Valid API key or bootstrap secret required");
  }

  const createdAt = nowIso();
  const project: ProjectRow = {
    id: newId("prj"),
    name: asString(body.project_name) || "Default project",
    created_at: createdAt,
  };
  await insertProject(c.env.DB, project);
  const minted = await mintApiKey(c.env.DB, project.id, name);
  return c.json(
    {
      api_key: publicApiKey(minted.row, minted.token),
      project: publicProject(project),
    },
    201,
  );
});

app.get("/v1/api-keys", requireApiKey, async (c) => {
  const keys = await listApiKeysForProject(c.env.DB, c.get("projectId"));
  return c.json({
    api_keys: keys.map((row) => publicApiKey(row)),
    count: keys.length,
  });
});

app.delete("/v1/api-keys/:id", requireApiKey, async (c) => {
  const key = await findApiKeyForProject(c.env.DB, c.req.param("id"), c.get("projectId"));
  if (!key) {
    return jsonError(c, 404, "not_found", "API key not found");
  }

  await deleteApiKey(c.env.DB, key.id, key.project_id);
  return c.json({ deleted: true, id: key.id });
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

app.get("/v1/endpoints", requireApiKey, async (c) => {
  const endpoints = await listEndpointsForProject(c.env.DB, c.get("projectId"));
  return c.json({
    endpoints: endpoints.map(publicEndpoint),
    count: endpoints.length,
  });
});

app.get("/v1/endpoints/:id", requireApiKey, async (c) => {
  const endpoint = await findEndpointForProject(c.env.DB, c.req.param("id"), c.get("projectId"));
  if (!endpoint) {
    return jsonError(c, 404, "not_found", "Endpoint not found");
  }
  return c.json({ endpoint: publicEndpoint(endpoint) });
});

app.post("/v1/ingest/:endpointKey", async (c) => {
  const endpoint = await findEndpointByKey(c.env.DB, c.req.param("endpointKey"));
  if (!endpoint) {
    return jsonError(c, 404, "unknown_endpoint", "Unknown endpoint key");
  }

  const limit = parseIngestRateLimit(c.env.INGEST_RATE_LIMIT);
  const rate = await consumeIngestRateLimit(c.env.DB, endpoint.id, limit);
  if (!rate.allowed) {
    const retryAfter = String(rate.retryAfterSeconds);
    c.header("Retry-After", retryAfter);
    return jsonError(
      c,
      429,
      "rate_limited",
      `Ingest rate limit exceeded (${rate.limit} per minute per endpoint). Retry after ${retryAfter}s.`,
    );
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
    retry_count: 0,
    next_retry_at: null,
  };

  await insertEvent(c.env.DB, event);
  return c.json({ event: publicEvent(event) }, 201);
});

app.get("/v1/events", requireApiKey, async (c) => {
  const statusParam = c.req.query("status");
  if (statusParam && !EVENT_STATUSES.has(statusParam as EventStatus)) {
    return jsonError(c, 400, "invalid_status", "Unknown event status");
  }

  const endpointIdParam = c.req.query("endpoint_id");
  if (endpointIdParam !== undefined && !ENDPOINT_ID_RE.test(endpointIdParam)) {
    return jsonError(c, 400, "invalid_endpoint_id", "endpoint_id must be an endpoint id");
  }

  const limit = clampInt(c.req.query("limit"), 50, 1, 200);
  const events = await listEventsForProject(
    c.env.DB,
    c.get("projectId"),
    statusParam as EventStatus | undefined,
    limit,
    endpointIdParam,
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
    await markEventPendingReplay(c.env.DB, event.id, updatedAt);
    return c.json({
      event: publicEvent({
        ...event,
        status: "pending_replay",
        updated_at: updatedAt,
        retry_count: 0,
        next_retry_at: updatedAt,
      }),
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

function allowCorsOrigin(origin: string): string {
  if ((MARKETING_ORIGINS as readonly string[]).includes(origin)) {
    return origin;
  }
  // Keep existing permissive CORS for self-hosted dashboards and local wrangler.
  return origin || "*";
}

function waitlistClientKey(c: { req: { header: (name: string) => string | undefined } }): string {
  const cfIp = c.req.header("cf-connecting-ip")?.trim();
  if (cfIp) return `ip:${cfIp}`;
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return `ip:${forwarded}`;
  return "ip:unknown";
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function isValidEmail(value: string): boolean {
  if (value.length > 254) return false;
  if (!EMAIL_RE.test(value)) return false;
  const at = value.lastIndexOf("@");
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return local.length > 0 && local.length <= 64 && domain.includes(".");
}

function optionalWaitlistField(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_WAITLIST_FIELD_CHARS) return false;
  return trimmed;
}

async function mintApiKey(
  db: D1Database,
  projectId: string,
  name: string,
): Promise<{ row: ApiKeyRow; token: string }> {
  const { token, prefix } = newApiKeyToken();
  const createdAt = nowIso();
  const row: ApiKeyRow = {
    id: newId("key"),
    project_id: projectId,
    name,
    key_hash: await sha256Hex(token),
    key_prefix: prefix,
    created_at: createdAt,
  };
  await insertApiKey(db, row);
  return { row, token };
}
