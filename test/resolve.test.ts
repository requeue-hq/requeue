import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { app, MAX_BULK_REPLAY_IDS, MAX_RESOLVE_NOTE_CHARS } from "../src/app";
import { processPendingReplays } from "../src/outbox";

const DEMO_KEY = "rq_demo_local_dev_only_do_not_use_in_prod";
const BOOTSTRAP_SECRET = "test-bootstrap-secret-do-not-use-in-prod";
const AUTH = { Authorization: `Bearer ${DEMO_KEY}` };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type BulkResult = {
  id: string;
  ok: boolean;
  event?: { id: string; status: string; resolve_note: string | null; next_retry_at: string | null };
  error?: { code: string; message: string };
};

type StoredEvent = {
  status: string;
  retry_count: number;
  next_retry_at: string | null;
  delivery_payload: string | null;
  delivery_headers: string | null;
  resolve_note: string | null;
};

function captureDeliveries(): string[] {
  const bodies: string[] = [];
  globalThis.fetch = async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({ accepted: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return bodies;
}

async function isolateOutbox() {
  await env.DB.prepare(
    "UPDATE events SET status = 'failed', next_retry_at = NULL WHERE status = 'pending_replay'",
  ).run();
}

async function createEndpoint(name: string, targetUrl: string, headers: Record<string, string> = AUTH) {
  const res = await app.request(
    "/v1/endpoints",
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name, target_url: targetUrl }),
    },
    env,
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { endpoint: { id: string; endpoint_key: string } };
  return body.endpoint;
}

async function ingestFailure(endpointKey: string, orderId: string) {
  const res = await app.request(
    `/v1/ingest/${endpointKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: { order_id: orderId },
        reason: "outage",
        source: "worker",
      }),
    },
    env,
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    event: { id: string; status: string; resolve_note: string | null };
  };
  return body.event;
}

async function resolveEvent(
  eventId: string,
  body?: unknown,
  headers: Record<string, string> = AUTH,
) {
  return app.request(
    `/v1/events/${eventId}/resolve`,
    {
      method: "POST",
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

async function bulkResolve(body: unknown, headers: Record<string, string> = AUTH) {
  return app.request(
    "/v1/events/bulk-resolve",
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function eventRow(eventId: string) {
  return env.DB.prepare(
    `SELECT status, retry_count, next_retry_at, delivery_payload, delivery_headers, resolve_note
     FROM events WHERE id = ?`,
  )
    .bind(eventId)
    .first<StoredEvent>();
}

describe("POST /v1/events/:id/resolve", () => {
  it("dismisses a failed event without replaying it", async () => {
    const deliveries = captureDeliveries();
    const endpoint = await createEndpoint("Resolve orders", "https://example.com/hooks/resolve");
    const event = await ingestFailure(endpoint.endpoint_key, "ord_resolve");
    expect(event.status).toBe("failed");
    expect(event.resolve_note).toBeNull();

    const res = await resolveEvent(event.id, { note: "  fixed upstream  " });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      event: {
        id: string;
        status: string;
        resolve_note: string | null;
        next_retry_at: string | null;
        payload: { order_id: string };
      };
    };
    expect(body.event.id).toBe(event.id);
    expect(body.event.status).toBe("resolved");
    expect(body.event.resolve_note).toBe("fixed upstream");
    expect(body.event.next_retry_at).toBeNull();
    expect(body.event.payload).toEqual({ order_id: "ord_resolve" });
    expect(deliveries).toHaveLength(0);

    const row = await eventRow(event.id);
    expect(row).toMatchObject({
      status: "resolved",
      next_retry_at: null,
      delivery_payload: null,
      delivery_headers: null,
      resolve_note: "fixed upstream",
    });

    const attempts = await env.DB.prepare("SELECT COUNT(*) AS count FROM replay_attempts WHERE event_id = ?")
      .bind(event.id)
      .first<{ count: number }>();
    expect(attempts?.count).toBe(0);

    const listed = await app.request(`/v1/events/${event.id}`, { headers: AUTH }, env);
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { event: { status: string; resolve_note: string | null } };
    expect(listedBody.event.status).toBe("resolved");
    expect(listedBody.event.resolve_note).toBe("fixed upstream");
  });

  it("returns the same event when it is already resolved", async () => {
    const endpoint = await createEndpoint("Resolve idempotent", "https://example.com/hooks/resolve-idem");
    const event = await ingestFailure(endpoint.endpoint_key, "ord_idem");

    const first = await resolveEvent(event.id, { note: "keep this" });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { event: { updated_at: string; resolve_note: string | null } };

    const second = await resolveEvent(event.id, { note: "a different note" });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      event: { status: string; updated_at: string; resolve_note: string | null };
    };
    expect(secondBody.event.status).toBe("resolved");
    expect(secondBody.event.resolve_note).toBe("keep this");
    expect(secondBody.event.updated_at).toBe(firstBody.event.updated_at);
  });

  it("returns 404 for an event in another project", async () => {
    const localEndpoint = await createEndpoint("Resolve local", "https://example.com/hooks/resolve-local");
    const localEvent = await ingestFailure(localEndpoint.endpoint_key, "ord_local");

    const otherProject = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Requeue-Bootstrap-Secret": BOOTSTRAP_SECRET,
        },
        body: JSON.stringify({ name: "Resolve other key", project_name: "Resolve other project" }),
      },
      env,
    );
    expect(otherProject.status).toBe(201);
    const otherBody = (await otherProject.json()) as { api_key: { token: string } };
    const otherAuth = { Authorization: `Bearer ${otherBody.api_key.token}` };

    const res = await resolveEvent(localEvent.id, undefined, otherAuth);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "not_found", message: "Event not found" },
    });
    expect((await eventRow(localEvent.id))?.status).toBe("failed");
  });

  it("clears a pending_replay outbox row so cron does not deliver it", async () => {
    await isolateOutbox();
    const deliveries = captureDeliveries();
    const endpoint = await createEndpoint("Resolve queued", "https://example.com/hooks/resolve-queued");
    const event = await ingestFailure(endpoint.endpoint_key, "ord_queued");

    const queued = await app.request(
      `/v1/events/${event.id}/replay`,
      {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          enqueue: true,
          payload: { order_id: "stale_override" },
          headers: { "x-request-id": "req_queued" },
        }),
      },
      env,
    );
    expect(queued.status).toBe(200);

    await env.DB.prepare("UPDATE events SET retry_count = 4, next_retry_at = ? WHERE id = ?")
      .bind("2020-01-01T00:00:00.000Z", event.id)
      .run();

    const before = await eventRow(event.id);
    expect(before?.status).toBe("pending_replay");
    expect(before?.delivery_payload).toBeTruthy();
    expect(before?.delivery_headers).toBeTruthy();
    expect(before?.next_retry_at).toBeTruthy();

    const res = await resolveEvent(event.id, { note: "fixed upstream" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      event: { status: string; retry_count: number; next_retry_at: string | null; resolve_note: string | null };
    };
    expect(body.event.status).toBe("resolved");
    expect(body.event.retry_count).toBe(4);
    expect(body.event.next_retry_at).toBeNull();
    expect(body.event.resolve_note).toBe("fixed upstream");

    const row = await eventRow(event.id);
    expect(row).toMatchObject({
      status: "resolved",
      retry_count: 4,
      next_retry_at: null,
      delivery_payload: null,
      delivery_headers: null,
      resolve_note: "fixed upstream",
    });

    const processed = await processPendingReplays(env.DB);
    expect(processed).toEqual({ processed: 0, succeeded: 0, failed: 0 });
    expect(deliveries).toHaveLength(0);
    expect((await eventRow(event.id))?.status).toBe("resolved");
  });

  it("rejects a note that is not a short string and leaves the event failed", async () => {
    const endpoint = await createEndpoint("Resolve note", "https://example.com/hooks/resolve-note");
    const event = await ingestFailure(endpoint.endpoint_key, "ord_note");

    const numberNote = await resolveEvent(event.id, { note: 12 });
    expect(numberNote.status).toBe(400);
    await expect(numberNote.json()).resolves.toMatchObject({
      error: { code: "invalid_body", message: "note must be a string" },
    });

    const longNote = await resolveEvent(event.id, { note: "x".repeat(MAX_RESOLVE_NOTE_CHARS + 1) });
    expect(longNote.status).toBe(400);
    await expect(longNote.json()).resolves.toMatchObject({
      error: {
        code: "invalid_body",
        message: `note must be at most ${MAX_RESOLVE_NOTE_CHARS} characters`,
      },
    });

    const badJson = await app.request(
      `/v1/events/${event.id}/resolve`,
      {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: "{",
      },
      env,
    );
    expect(badJson.status).toBe(400);
    await expect(badJson.json()).resolves.toMatchObject({ error: { code: "invalid_json" } });
    expect((await eventRow(event.id))?.status).toBe("failed");
  });

  it("requires a project API key", async () => {
    const res = await app.request("/v1/events/evt_nope/resolve", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/events/bulk-resolve", () => {
  it("resolves found ids and reports missing ids without aborting", async () => {
    const endpoint = await createEndpoint("Bulk resolve", "https://example.com/hooks/bulk-resolve");
    const kept = await ingestFailure(endpoint.endpoint_key, "ord_bulk_keep");
    const missing = "evt_missing_bulk_resolve";

    const res = await bulkResolve({ ids: [missing, kept.id] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: BulkResult[]; ok_count: number; error_count: number };
    expect(body.ok_count).toBe(1);
    expect(body.error_count).toBe(1);
    expect(body.results[0]).toEqual({
      id: missing,
      ok: false,
      error: { code: "not_found", message: "Event not found" },
    });
    expect(body.results[1]).toMatchObject({
      id: kept.id,
      ok: true,
      event: { id: kept.id, status: "resolved", resolve_note: null, next_retry_at: null },
    });
    expect((await eventRow(kept.id))?.status).toBe("resolved");
  });

  it("returns the same error codes as bulk-replay for an empty list and over-cap ids", async () => {
    const endpoint = await createEndpoint("Bulk resolve cap", "https://example.com/hooks/bulk-resolve-cap");
    const event = await ingestFailure(endpoint.endpoint_key, "ord_cap");

    const empty = await bulkResolve({ ids: [] });
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toMatchObject({
      error: { code: "invalid_body", message: "ids must be a non-empty array of event ids" },
    });

    const missing = await bulkResolve({});
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "invalid_body" } });

    const ids = [event.id, ...Array.from({ length: MAX_BULK_REPLAY_IDS }, (_, index) => `evt_extra_${index}`)];
    const capped = await bulkResolve({ ids });
    expect(capped.status).toBe(400);
    await expect(capped.json()).resolves.toMatchObject({
      error: {
        code: "too_many_ids",
        message: `ids is limited to ${MAX_BULK_REPLAY_IDS} event ids per request`,
      },
    });
    expect((await eventRow(event.id))?.status).toBe("failed");
  });

  it("does not resolve another project's events", async () => {
    const localEndpoint = await createEndpoint("Bulk resolve local", "https://example.com/hooks/bulk-resolve-local");
    const localEvent = await ingestFailure(localEndpoint.endpoint_key, "ord_project_local");

    const otherProject = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Requeue-Bootstrap-Secret": BOOTSTRAP_SECRET,
        },
        body: JSON.stringify({ name: "Bulk resolve other key", project_name: "Bulk resolve other project" }),
      },
      env,
    );
    expect(otherProject.status).toBe(201);
    const otherBody = (await otherProject.json()) as { api_key: { token: string } };
    const otherAuth = { Authorization: `Bearer ${otherBody.api_key.token}` };

    const res = await bulkResolve({ ids: [localEvent.id] }, otherAuth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: BulkResult[]; ok_count: number; error_count: number };
    expect(body.ok_count).toBe(0);
    expect(body.error_count).toBe(1);
    expect(body.results[0]).toEqual({
      id: localEvent.id,
      ok: false,
      error: { code: "not_found", message: "Event not found" },
    });
    expect((await eventRow(localEvent.id))?.status).toBe("failed");
  });

  it("requires a project API key", async () => {
    const res = await app.request(
      "/v1/events/bulk-resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ["evt_nope"] }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/events?status=resolved", () => {
  it("returns only resolved events for the caller's project", async () => {
    const endpoint = await createEndpoint("Resolve filter", "https://example.com/hooks/resolve-filter");
    const dismissed = await ingestFailure(endpoint.endpoint_key, "ord_dismissed");
    const stillFailed = await ingestFailure(endpoint.endpoint_key, "ord_still_failed");

    const resolved = await resolveEvent(dismissed.id);
    expect(resolved.status).toBe(200);

    const listed = await app.request(
      `/v1/events?status=resolved&endpoint_id=${endpoint.id}`,
      { headers: AUTH },
      env,
    );
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { events: Array<{ id: string; status: string }>; count: number };
    expect(listedBody.events.every((event) => event.status === "resolved")).toBe(true);
    expect(listedBody.events.some((event) => event.id === dismissed.id)).toBe(true);
    expect(listedBody.events.some((event) => event.id === stillFailed.id)).toBe(false);

    const failed = await app.request(
      `/v1/events?status=failed&endpoint_id=${endpoint.id}`,
      { headers: AUTH },
      env,
    );
    expect(failed.status).toBe(200);
    const failedBody = (await failed.json()) as { events: Array<{ id: string; status: string }> };
    expect(failedBody.events.every((event) => event.status === "failed")).toBe(true);
    expect(failedBody.events.some((event) => event.id === stillFailed.id)).toBe(true);
    expect(failedBody.events.some((event) => event.id === dismissed.id)).toBe(false);
  });
});
