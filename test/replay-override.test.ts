import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { hmacSha256Hex } from "../src/crypto";
import { app } from "../src/app";
import { processPendingReplays } from "../src/outbox";

const DEMO_KEY = "rq_demo_local_dev_only_do_not_use_in_prod";
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

async function seedFailedEvent(options?: { secret?: string; headers?: Record<string, string> }) {
  const created = await app.request(
    "/v1/endpoints",
    {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Override target",
        target_url: "https://example.com/hooks/override",
        ...(options?.secret ? { secret: options.secret } : {}),
      }),
    },
    env,
  );
  expect(created.status).toBe(201);
  const createdBody = (await created.json()) as { endpoint: { endpoint_key: string } };

  const originalPayload = { order_id: "ord_stale", amount: 1 };
  const ingested = await app.request(
    `/v1/ingest/${createdBody.endpoint.endpoint_key}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: originalPayload,
        reason: "typo in body",
        source: "worker",
        headers: options?.headers ?? { "x-request-id": "req_orig" },
      }),
    },
    env,
  );
  expect(ingested.status).toBe(201);
  const ingestedBody = (await ingested.json()) as { event: { id: string; payload: unknown } };
  return { eventId: ingestedBody.event.id, originalPayload };
}

async function loadEventRow(eventId: string) {
  return env.DB.prepare(
    "SELECT payload, headers, delivery_payload, delivery_headers, status FROM events WHERE id = ?",
  )
    .bind(eventId)
    .first<{
      payload: string;
      headers: string | null;
      delivery_payload: string | null;
      delivery_headers: string | null;
      status: string;
    }>();
}

describe("POST /v1/events/:id/replay payload override", () => {
  it("delivers an immediate payload override and leaves the inbox corpse unchanged", async () => {
    const deliveries = captureDeliveries();
    const { eventId, originalPayload } = await seedFailedEvent();
    const override = { order_id: "ord_fixed", amount: 99 };

    const replayed = await app.request(
      `/v1/events/${eventId}/replay`,
      {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ enqueue: false, payload: override }),
      },
      env,
    );
    expect(replayed.status).toBe(200);
    const replayedBody = (await replayed.json()) as {
      event: { status: string; payload: unknown };
      attempt: { success: boolean; status_code: number };
      queued: boolean;
    };
    expect(replayedBody.queued).toBe(false);
    expect(replayedBody.event.status).toBe("replayed");
    expect(replayedBody.event.payload).toEqual(originalPayload);
    expect(replayedBody.attempt.success).toBe(true);
    expect(replayedBody.attempt.status_code).toBe(200);

    expect(deliveries).toHaveLength(1);
    expect(JSON.parse(deliveries[0]?.body ?? "")).toEqual(override);

    const row = await loadEventRow(eventId);
    expect(JSON.parse(row?.payload ?? "")).toEqual(originalPayload);
    expect(row?.delivery_payload).toBeNull();

    const detail = await app.request(`/v1/events/${eventId}`, { headers: AUTH }, env);
    const detailBody = (await detail.json()) as {
      event: { payload: unknown };
      replay_attempts: Array<{ success: boolean }>;
    };
    expect(detailBody.event.payload).toEqual(originalPayload);
    expect(detailBody.replay_attempts).toHaveLength(1);
    expect(detailBody.replay_attempts[0]?.success).toBe(true);
  });

  it("signs the payload actually delivered, not the stored corpse", async () => {
    const deliveries = captureDeliveries();
    const secret = "hook-secret";
    const { eventId, originalPayload } = await seedFailedEvent({ secret });
    const override = { order_id: "ord_signed", amount: 7 };

    const replayed = await app.request(
      `/v1/events/${eventId}/replay`,
      {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ payload: override }),
      },
      env,
    );
    expect(replayed.status).toBe(200);

    const delivered = deliveries[0];
    expect(delivered).toBeTruthy();
    const timestamp = delivered?.headers.get("x-requeue-timestamp") ?? "";
    const signature = delivered?.headers.get("x-requeue-signature") ?? "";
    const deliveredBody = delivered?.body ?? "";
    const expected = await hmacSha256Hex(secret, `${timestamp}.${eventId}.${deliveredBody}`);
    expect(signature).toBe(`sha256=${expected}`);

    const stale = await hmacSha256Hex(
      secret,
      `${timestamp}.${eventId}.${JSON.stringify(originalPayload)}`,
    );
    expect(signature).not.toBe(`sha256=${stale}`);
    expect(JSON.parse(deliveredBody)).toEqual(override);
  });

  it("forwards header overrides for this delivery only", async () => {
    const deliveries = captureDeliveries();
    const { eventId } = await seedFailedEvent({
      headers: { "x-request-id": "req_orig", "x-extra": "keep-me" },
    });

    const replayed = await app.request(
      `/v1/events/${eventId}/replay`,
      {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          payload: { order_id: "ord_hdr" },
          headers: { "x-request-id": "req_fixed" },
        }),
      },
      env,
    );
    expect(replayed.status).toBe(200);
    expect(deliveries[0]?.headers.get("x-request-id")).toBe("req_fixed");
    expect(deliveries[0]?.headers.get("x-extra")).toBeNull();

    const row = await loadEventRow(eventId);
    expect(JSON.parse(row?.headers ?? "")).toEqual({
      "x-request-id": "req_orig",
      "x-extra": "keep-me",
    });
  });

  it("omits payload and keeps current stored-body behavior", async () => {
    const deliveries = captureDeliveries();
    const { eventId, originalPayload } = await seedFailedEvent();

    const replayed = await app.request(
      `/v1/events/${eventId}/replay`,
      {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ enqueue: false }),
      },
      env,
    );
    expect(replayed.status).toBe(200);
    expect(JSON.parse(deliveries[0]?.body ?? "")).toEqual(originalPayload);
  });

  it("rejects a non-object headers override", async () => {
    const { eventId } = await seedFailedEvent();
    const replayed = await app.request(
      `/v1/events/${eventId}/replay`,
      {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ payload: { ok: true }, headers: "nope" }),
      },
      env,
    );
    expect(replayed.status).toBe(400);
    await expect(replayed.json()).resolves.toMatchObject({
      error: { code: "invalid_body" },
    });
  });

  it("stores the override on the outbox row so cron delivers it and HMAC matches", async () => {
    await isolateOutbox();
    const deliveries = captureDeliveries();
    const secret = "outbox-secret";
    const { eventId, originalPayload } = await seedFailedEvent({ secret });
    const override = { order_id: "ord_queued", amount: 42 };

    const queued = await app.request(
      `/v1/events/${eventId}/replay`,
      {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          enqueue: true,
          payload: override,
          headers: { "x-request-id": "req_queued" },
        }),
      },
      env,
    );
    expect(queued.status).toBe(200);
    const queuedBody = (await queued.json()) as {
      queued: boolean;
      event: { status: string; payload: unknown };
    };
    expect(queuedBody.queued).toBe(true);
    expect(queuedBody.event.status).toBe("pending_replay");
    expect(queuedBody.event.payload).toEqual(originalPayload);

    const pending = await loadEventRow(eventId);
    expect(JSON.parse(pending?.payload ?? "")).toEqual(originalPayload);
    expect(JSON.parse(pending?.delivery_payload ?? "")).toEqual(override);
    expect(JSON.parse(pending?.delivery_headers ?? "")).toEqual({ "x-request-id": "req_queued" });

    const processed = await processPendingReplays(env.DB);
    expect(processed).toEqual({ processed: 1, succeeded: 1, failed: 0 });

    expect(deliveries).toHaveLength(1);
    expect(JSON.parse(deliveries[0]?.body ?? "")).toEqual(override);
    expect(deliveries[0]?.headers.get("x-request-id")).toBe("req_queued");

    const timestamp = deliveries[0]?.headers.get("x-requeue-timestamp") ?? "";
    const signature = deliveries[0]?.headers.get("x-requeue-signature") ?? "";
    const expected = await hmacSha256Hex(secret, `${timestamp}.${eventId}.${deliveries[0]?.body}`);
    expect(signature).toBe(`sha256=${expected}`);

    const after = await loadEventRow(eventId);
    expect(after?.status).toBe("replayed");
    expect(JSON.parse(after?.payload ?? "")).toEqual(originalPayload);
  });

  it("keeps the queued override across a failed outbox retry", async () => {
    await isolateOutbox();
    const { eventId, originalPayload } = await seedFailedEvent();
    const override = { order_id: "ord_retry" };

    const queued = await app.request(
      `/v1/events/${eventId}/replay`,
      {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ enqueue: true, payload: override }),
      },
      env,
    );
    expect(queued.status).toBe(200);

    globalThis.fetch = async () => new Response("upstream down", { status: 503 });
    const first = await processPendingReplays(env.DB);
    expect(first).toEqual({ processed: 1, succeeded: 0, failed: 1 });

    const afterFail = await loadEventRow(eventId);
    expect(afterFail?.status).toBe("pending_replay");
    expect(JSON.parse(afterFail?.payload ?? "")).toEqual(originalPayload);
    expect(JSON.parse(afterFail?.delivery_payload ?? "")).toEqual(override);

    await env.DB.prepare("UPDATE events SET next_retry_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), eventId)
      .run();

    const deliveries = captureDeliveries();
    const retried = await processPendingReplays(env.DB);
    expect(retried).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(JSON.parse(deliveries[0]?.body ?? "")).toEqual(override);
  });
});
