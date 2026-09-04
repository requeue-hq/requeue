import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { app } from "../src/app";

const DEMO_KEY = "rq_demo_local_dev_only_do_not_use_in_prod";
const AUTH = { Authorization: `Bearer ${DEMO_KEY}` };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("health", () => {
  it("returns ok after a D1 ping", async () => {
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      service: "requeue",
    });
  });
});

describe("ingest + replay happy path", () => {
  it("stores a failed event and replays the original payload to target_url", async () => {
    const deliveries: Array<{ url: string; body: string; contentType: string }> = [];

    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      deliveries.push({
        url,
        body: String(init?.body ?? ""),
        contentType: new Headers(init?.headers).get("content-type") ?? "",
      });
      return new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const created = await app.request(
      "/v1/endpoints",
      {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Orders worker",
          target_url: "https://example.com/hooks/orders",
          secret: "hook-secret",
        }),
      },
      env,
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      endpoint: { id: string; endpoint_key: string; target_url: string };
    };
    const endpointKey = createdBody.endpoint.endpoint_key;

    const originalPayload = { order_id: "ord_123", amount: 4200 };
    const ingested = await app.request(
      `/v1/ingest/${endpointKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payload: originalPayload,
          reason: "fulfillment timeout",
          source: "worker",
          headers: { "x-request-id": "req_abc" },
        }),
      },
      env,
    );
    expect(ingested.status).toBe(201);
    const ingestedBody = (await ingested.json()) as {
      event: { id: string; status: string; payload: unknown; reason: string };
    };
    expect(ingestedBody.event.status).toBe("failed");
    expect(ingestedBody.event.payload).toEqual(originalPayload);
    expect(ingestedBody.event.reason).toBe("fulfillment timeout");

    const listed = await app.request("/v1/events?status=failed", { headers: AUTH }, env);
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { events: Array<{ id: string }>; count: number };
    expect(listedBody.count).toBeGreaterThanOrEqual(1);
    expect(listedBody.events.some((event) => event.id === ingestedBody.event.id)).toBe(true);

    const replayed = await app.request(
      `/v1/events/${ingestedBody.event.id}/replay`,
      { method: "POST", headers: AUTH },
      env,
    );
    expect(replayed.status).toBe(200);
    const replayedBody = (await replayed.json()) as {
      event: { status: string };
      attempt: { success: boolean; status_code: number };
      queued: boolean;
    };
    expect(replayedBody.queued).toBe(false);
    expect(replayedBody.event.status).toBe("replayed");
    expect(replayedBody.attempt.success).toBe(true);
    expect(replayedBody.attempt.status_code).toBe(200);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.url).toBe("https://example.com/hooks/orders");
    expect(JSON.parse(deliveries[0]?.body ?? "")).toEqual(originalPayload);
    expect(deliveries[0]?.contentType).toContain("application/json");

    const detail = await app.request(`/v1/events/${ingestedBody.event.id}`, { headers: AUTH }, env);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      event: { status: string };
      replay_attempts: Array<{ success: boolean }>;
    };
    expect(detailBody.event.status).toBe("replayed");
    expect(detailBody.replay_attempts).toHaveLength(1);
    expect(detailBody.replay_attempts[0]?.success).toBe(true);
  });

  it("rejects management routes without a valid API key", async () => {
    const res = await app.request("/v1/events", {}, env);
    expect(res.status).toBe(401);
  });
});
