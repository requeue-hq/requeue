import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { app, MAX_BULK_REPLAY_IDS } from "../src/app";
import { hmacSha256Hex } from "../src/crypto";
import { processPendingReplays } from "../src/outbox";

const DEMO_KEY = "rq_demo_local_dev_only_do_not_use_in_prod";
const BOOTSTRAP_SECRET = "test-bootstrap-secret-do-not-use-in-prod";
const AUTH = { Authorization: `Bearer ${DEMO_KEY}` };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Delivery = {
  url: string;
  body: string;
  headers: Headers;
};

type BulkResult = {
  id: string;
  ok: boolean;
  event?: { id: string; status: string; payload: unknown; retry_count: number; next_retry_at: string | null };
  attempt?: { success: boolean; status_code: number | null; event_id: string } | null;
  queued?: boolean;
  error?: { code: string; message: string };
};

function captureDeliveries(): Delivery[] {
  const deliveries: Delivery[] = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    deliveries.push({
      url,
      body: String(init?.body ?? ""),
      headers: new Headers(init?.headers),
    });
    return new Response(JSON.stringify({ accepted: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return deliveries;
}

async function isolateOutbox() {
  await env.DB.prepare(
    "UPDATE events SET status = 'failed', next_retry_at = NULL WHERE status = 'pending_replay'",
  ).run();
}

async function createEndpoint(
  name: string,
  targetUrl: string,
  headers: Record<string, string> = AUTH,
  secret?: string,
) {
  const res = await app.request(
    "/v1/endpoints",
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        name,
        target_url: targetUrl,
        ...(secret ? { secret } : {}),
      }),
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
  const body = (await res.json()) as { event: { id: string; status: string; payload: unknown } };
  return body.event;
}

async function bulkReplay(body: unknown, headers: Record<string, string> = AUTH) {
  return app.request(
    "/v1/events/bulk-replay",
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function eventStatus(eventId: string) {
  return env.DB.prepare(
    "SELECT status, retry_count, next_retry_at, delivery_payload, delivery_headers FROM events WHERE id = ?",
  )
    .bind(eventId)
    .first<{
      status: string;
      retry_count: number;
      next_retry_at: string | null;
      delivery_payload: string | null;
      delivery_headers: string | null;
    }>();
}

describe("POST /v1/events/bulk-replay", () => {
  it("enqueues each id by default and the outbox delivers the stored corpse", async () => {
    await isolateOutbox();
    const deliveries = captureDeliveries();
    const secret = "bulk-hook-secret";
    const endpoint = await createEndpoint("Bulk orders", "https://example.com/hooks/bulk", AUTH, secret);
    const first = await ingestFailure(endpoint.endpoint_key, "ord_bulk_1");
    const second = await ingestFailure(endpoint.endpoint_key, "ord_bulk_2");

    await env.DB.prepare("UPDATE events SET retry_count = 3, delivery_payload = ? WHERE id = ?")
      .bind(JSON.stringify({ order_id: "stale_override" }), first.id)
      .run();

    const res = await bulkReplay({ ids: [first.id, second.id] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: BulkResult[]; ok_count: number; error_count: number };
    expect(body.ok_count).toBe(2);
    expect(body.error_count).toBe(0);
    expect(body.results.map((item) => item.id)).toEqual([first.id, second.id]);
    for (const item of body.results) {
      expect(item.ok).toBe(true);
      expect(item.queued).toBe(true);
      expect(item.attempt).toBeNull();
      expect(item.event?.status).toBe("pending_replay");
      expect(item.event?.retry_count).toBe(0);
      expect(item.event?.next_retry_at).toBeTruthy();
    }
    expect(deliveries).toHaveLength(0);

    const queuedFirst = await eventStatus(first.id);
    expect(queuedFirst?.status).toBe("pending_replay");
    expect(queuedFirst?.retry_count).toBe(0);
    expect(queuedFirst?.next_retry_at).toBeTruthy();
    expect(queuedFirst?.delivery_payload).toBeNull();
    expect(queuedFirst?.delivery_headers).toBeNull();

    const processed = await processPendingReplays(env.DB);
    expect(processed).toEqual({ processed: 2, succeeded: 2, failed: 0 });
    expect(deliveries).toHaveLength(2);
    const deliveredBodies = deliveries.map((delivery) => JSON.parse(delivery.body) as { order_id: string });
    expect(deliveredBodies.map((payload) => payload.order_id).sort()).toEqual(["ord_bulk_1", "ord_bulk_2"]);

    const signed = deliveries.find((delivery) => JSON.parse(delivery.body).order_id === "ord_bulk_1");
    expect(signed).toBeTruthy();
    const timestamp = signed?.headers.get("x-requeue-timestamp") ?? "";
    const signature = signed?.headers.get("x-requeue-signature") ?? "";
    const expected = await hmacSha256Hex(secret, `${timestamp}.${first.id}.${signed?.body}`);
    expect(signature).toBe(`sha256=${expected}`);

    expect((await eventStatus(first.id))?.status).toBe("replayed");
    expect((await eventStatus(second.id))?.status).toBe("replayed");
  });

  it("delivers synchronously one-by-one when enqueue is false", async () => {
    const deliveries = captureDeliveries();
    const endpoint = await createEndpoint("Bulk sync", "https://example.com/hooks/bulk-sync");
    const first = await ingestFailure(endpoint.endpoint_key, "ord_sync_1");
    const second = await ingestFailure(endpoint.endpoint_key, "ord_sync_2");

    const res = await bulkReplay({ ids: [second.id, first.id], enqueue: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: BulkResult[]; ok_count: number; error_count: number };
    expect(body.ok_count).toBe(2);
    expect(body.error_count).toBe(0);
    expect(body.results.map((item) => item.id)).toEqual([second.id, first.id]);
    for (const item of body.results) {
      expect(item.ok).toBe(true);
      expect(item.queued).toBe(false);
      expect(item.event?.status).toBe("replayed");
      expect(item.attempt?.success).toBe(true);
      expect(item.attempt?.status_code).toBe(200);
      expect(item.attempt?.event_id).toBe(item.id);
    }

    expect(deliveries.map((delivery) => JSON.parse(delivery.body))).toEqual([
      { order_id: "ord_sync_2" },
      { order_id: "ord_sync_1" },
    ]);
    expect(deliveries.every((delivery) => delivery.url === "https://example.com/hooks/bulk-sync")).toBe(true);

    const attempts = await env.DB.prepare("SELECT event_id, success FROM replay_attempts WHERE event_id IN (?, ?)")
      .bind(first.id, second.id)
      .all<{ event_id: string; success: number }>();
    expect(attempts.results?.map((row) => row.event_id).sort()).toEqual([first.id, second.id].sort());
    expect(attempts.results?.every((row) => row.success === 1)).toBe(true);
  });

  it("reports a missing id without aborting the rest of the batch", async () => {
    const endpoint = await createEndpoint("Bulk mixed", "https://example.com/hooks/bulk-mixed");
    const kept = await ingestFailure(endpoint.endpoint_key, "ord_mixed_keep");
    const missing = "evt_missing_bulk_replay";

    const res = await bulkReplay({ ids: [missing, kept.id] });
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
      queued: true,
      attempt: null,
      event: { id: kept.id, status: "pending_replay" },
    });
    expect((await eventStatus(kept.id))?.status).toBe("pending_replay");
  });

  it("returns 400 for an empty ids array and does not replay", async () => {
    const endpoint = await createEndpoint("Bulk empty", "https://example.com/hooks/bulk-empty");
    const event = await ingestFailure(endpoint.endpoint_key, "ord_empty");

    const empty = await bulkReplay({ ids: [] });
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toMatchObject({
      error: { code: "invalid_body", message: "ids must be a non-empty array of event ids" },
    });

    const missing = await bulkReplay({});
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "invalid_body" } });

    const blankId = await bulkReplay({ ids: [event.id, ""] });
    expect(blankId.status).toBe(400);
    await expect(blankId.json()).resolves.toMatchObject({
      error: { code: "invalid_body", message: "ids must be non-empty strings" },
    });
    expect((await eventStatus(event.id))?.status).toBe("failed");
  });

  it("returns 400 when ids exceed the cap and writes nothing", async () => {
    const endpoint = await createEndpoint("Bulk cap", "https://example.com/hooks/bulk-cap");
    const event = await ingestFailure(endpoint.endpoint_key, "ord_cap");
    const ids = [event.id, ...Array.from({ length: MAX_BULK_REPLAY_IDS }, (_, index) => `evt_extra_${index}`)];
    expect(ids).toHaveLength(MAX_BULK_REPLAY_IDS + 1);

    const res = await bulkReplay({ ids });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: "too_many_ids",
        message: `ids is limited to ${MAX_BULK_REPLAY_IDS} event ids per request`,
      },
    });
    expect((await eventStatus(event.id))?.status).toBe("failed");
  });

  it("accepts exactly the cap of ids", async () => {
    const ids = Array.from({ length: MAX_BULK_REPLAY_IDS }, (_, index) => `evt_cap_ok_${index}`);
    const res = await bulkReplay({ ids });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: BulkResult[]; ok_count: number; error_count: number };
    expect(body.results).toHaveLength(MAX_BULK_REPLAY_IDS);
    expect(body.ok_count).toBe(0);
    expect(body.error_count).toBe(MAX_BULK_REPLAY_IDS);
    expect(body.results.every((item) => item.ok === false && item.error?.code === "not_found")).toBe(true);
  });

  it("does not replay another project's events", async () => {
    captureDeliveries();
    const localEndpoint = await createEndpoint("Bulk local", "https://example.com/hooks/bulk-local");
    const localEvent = await ingestFailure(localEndpoint.endpoint_key, "ord_project_local");

    const otherProject = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Requeue-Bootstrap-Secret": BOOTSTRAP_SECRET,
        },
        body: JSON.stringify({ name: "Bulk other key", project_name: "Bulk other project" }),
      },
      env,
    );
    expect(otherProject.status).toBe(201);
    const otherBody = (await otherProject.json()) as { api_key: { token: string } };
    const otherAuth = { Authorization: `Bearer ${otherBody.api_key.token}` };
    const otherEndpoint = await createEndpoint(
      "Bulk other",
      "https://example.com/hooks/bulk-other",
      otherAuth,
    );
    const otherEvent = await ingestFailure(otherEndpoint.endpoint_key, "ord_project_other");

    const fromOther = await bulkReplay({ ids: [localEvent.id, otherEvent.id], enqueue: false }, otherAuth);
    expect(fromOther.status).toBe(200);
    const fromOtherBody = (await fromOther.json()) as {
      results: BulkResult[];
      ok_count: number;
      error_count: number;
    };
    expect(fromOtherBody.ok_count).toBe(1);
    expect(fromOtherBody.error_count).toBe(1);
    expect(fromOtherBody.results[0]).toEqual({
      id: localEvent.id,
      ok: false,
      error: { code: "not_found", message: "Event not found" },
    });
    expect(fromOtherBody.results[1]).toMatchObject({
      id: otherEvent.id,
      ok: true,
      queued: false,
      event: { status: "replayed" },
    });
    expect((await eventStatus(localEvent.id))?.status).toBe("failed");
    expect((await eventStatus(otherEvent.id))?.status).toBe("replayed");

    const fromLocal = await bulkReplay({ ids: [otherEvent.id] });
    expect(fromLocal.status).toBe(200);
    const fromLocalBody = (await fromLocal.json()) as { results: BulkResult[]; ok_count: number; error_count: number };
    expect(fromLocalBody.ok_count).toBe(0);
    expect(fromLocalBody.error_count).toBe(1);
    expect(fromLocalBody.results[0]).toEqual({
      id: otherEvent.id,
      ok: false,
      error: { code: "not_found", message: "Event not found" },
    });
    expect((await eventStatus(otherEvent.id))?.status).toBe("replayed");
  });

  it("rejects payload and headers overrides before replaying", async () => {
    const endpoint = await createEndpoint("Bulk override", "https://example.com/hooks/bulk-override");
    const event = await ingestFailure(endpoint.endpoint_key, "ord_no_override");

    const res = await bulkReplay({
      ids: [event.id],
      payload: { order_id: "edited" },
      headers: { "x-request-id": "req_bulk" },
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "invalid_body" },
    });
    expect((await eventStatus(event.id))?.status).toBe("failed");
  });

  it("keeps going when a synchronous replay hits a deleted endpoint", async () => {
    const deliveries = captureDeliveries();
    const live = await createEndpoint("Bulk live", "https://example.com/hooks/bulk-live");
    const gone = await createEndpoint("Bulk gone", "https://example.com/hooks/bulk-gone");
    const liveEvent = await ingestFailure(live.endpoint_key, "ord_live");
    const goneEvent = await ingestFailure(gone.endpoint_key, "ord_gone");

    const deleted = await app.request(`/v1/endpoints/${gone.id}`, { method: "DELETE", headers: AUTH }, env);
    expect(deleted.status).toBe(200);

    const res = await bulkReplay({ ids: [goneEvent.id, liveEvent.id], enqueue: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: BulkResult[]; ok_count: number; error_count: number };
    expect(body.ok_count).toBe(1);
    expect(body.error_count).toBe(1);
    expect(body.results[0]).toEqual({
      id: goneEvent.id,
      ok: false,
      error: { code: "endpoint_gone", message: "Endpoint has been deleted" },
    });
    expect(body.results[1]).toMatchObject({
      id: liveEvent.id,
      ok: true,
      queued: false,
      event: { status: "replayed" },
    });
    expect(deliveries).toHaveLength(1);
    expect(JSON.parse(deliveries[0]?.body ?? "")).toEqual({ order_id: "ord_live" });
    expect((await eventStatus(goneEvent.id))?.status).toBe("failed");
  });

  it("requires a project API key", async () => {
    const res = await app.request(
      "/v1/events/bulk-replay",
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
