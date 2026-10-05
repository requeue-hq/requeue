import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { app } from "../src/app";

const DEMO_KEY = "rq_demo_local_dev_only_do_not_use_in_prod";
const AUTH = { Authorization: `Bearer ${DEMO_KEY}` };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const RAW_BODY = '{"id":"evt_test","type":"invoice.paid"}\n';
const STRIPE_SIGNATURE =
  "t=1492774577,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd";
const SVIX_ID = "msg_2Lh9nQ0q0q0q";
const SVIX_TIMESTAMP = "1492774577";
const SVIX_SIGNATURE = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";
const CONTENT_TYPE = "application/json; charset=utf-8";

type Delivery = {
  url: string;
  method: string;
  body: string;
  headers: Headers;
  redirect: string | undefined;
  hasSignal: boolean;
};

function installFetch(respond: (call: number) => Response | Promise<Response>): Delivery[] {
  const calls: Delivery[] = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
      headers,
      redirect: init?.redirect,
      hasSignal: init?.signal instanceof AbortSignal,
    });
    return respond(calls.length);
  };
  return calls;
}

async function createEndpoint(body: Record<string, unknown>) {
  const response = await app.request(
    "/v1/endpoints",
    {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
  const parsed = (await response.json()) as {
    endpoint?: { id: string; endpoint_key: string; relay_path: string; target_url: string };
    error?: { code: string; message: string };
  };
  return { status: response.status, ...parsed };
}

function relayHeaders(): Record<string, string> {
  return {
    "content-type": CONTENT_TYPE,
    "stripe-signature": STRIPE_SIGNATURE,
    "svix-id": SVIX_ID,
    "svix-timestamp": SVIX_TIMESTAMP,
    "svix-signature": SVIX_SIGNATURE,
    "x-requeue-event-id": "evt_spoofed",
    "x-forwarded-for": "203.0.113.5",
    "cf-ray": "abc123",
  };
}

function relayRequest(endpointKey: string, init?: { rateLimit?: string; body?: string }) {
  return app.request(
    `/v1/relay/${endpointKey}`,
    {
      method: "POST",
      headers: relayHeaders(),
      body: init?.body ?? RAW_BODY,
    },
    init?.rateLimit ? { ...env, INGEST_RATE_LIMIT: init.rateLimit } : env,
  );
}

describe("POST /v1/relay/:endpointKey", () => {
  it("passes a 2xx through with the raw body and signature headers unchanged", async () => {
    const calls = installFetch(
      () =>
        new Response('{"received":true}', {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const created = await createEndpoint({
      name: "Stripe",
      target_url: "https://example.com/webhooks/stripe",
      alert_url: "https://alerts.example/hooks/requeue",
    });
    expect(created.status).toBe(201);
    const endpoint = created.endpoint!;
    expect(endpoint.relay_path).toBe(`/v1/relay/${endpoint.endpoint_key}`);

    const response = await relayRequest(endpoint.endpoint_key);
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).toBe('{"received":true}');

    expect(calls).toHaveLength(1);
    const delivery = calls[0]!;
    expect(delivery.url).toBe("https://example.com/webhooks/stripe");
    expect(delivery.method).toBe("POST");
    expect(delivery.body).toBe(RAW_BODY);
    expect(delivery.redirect).toBe("manual");
    expect(delivery.hasSignal).toBe(true);
    expect(delivery.headers.get("content-type")).toBe(CONTENT_TYPE);
    expect(delivery.headers.get("stripe-signature")).toBe(STRIPE_SIGNATURE);
    expect(delivery.headers.get("svix-id")).toBe(SVIX_ID);
    expect(delivery.headers.get("svix-timestamp")).toBe(SVIX_TIMESTAMP);
    expect(delivery.headers.get("svix-signature")).toBe(SVIX_SIGNATURE);
    expect(delivery.headers.get("x-requeue-event-id")).toBeNull();
    expect(delivery.headers.get("x-forwarded-for")).toBeNull();
    expect(delivery.headers.get("cf-ray")).toBeNull();

    const listed = await app.request(`/v1/events?endpoint_id=${endpoint.id}`, { headers: AUTH }, env);
    const listedBody = (await listed.json()) as { count: number };
    expect(listedBody.count).toBe(0);
  });

  it("captures an upstream 5xx as a failed relay event and answers 200", async () => {
    installFetch(() => new Response("bad gateway", { status: 502 }));
    const created = await createEndpoint({
      name: "Stripe down",
      target_url: "https://example.com/webhooks/stripe",
    });
    const endpoint = created.endpoint!;

    const response = await relayRequest(endpoint.endpoint_key);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      captured: boolean;
      event: { id: string; status: string; reason: string };
    };
    expect(body.captured).toBe(true);
    expect(body.event.status).toBe("failed");
    expect(body.event.reason).toBe("relay: upstream 502");

    const row = await env.DB.prepare(
      "SELECT status, payload, content_type, headers, reason, source FROM events WHERE id = ?",
    )
      .bind(body.event.id)
      .first<{
        status: string;
        payload: string;
        content_type: string;
        headers: string;
        reason: string;
        source: string;
      }>();
    expect(row?.status).toBe("failed");
    expect(row?.payload).toBe(RAW_BODY);
    expect(row?.content_type).toBe(CONTENT_TYPE);
    expect(row?.reason).toBe("relay: upstream 502");
    expect(row?.source).toBe("relay");
    expect(JSON.parse(row?.headers ?? "{}")).toMatchObject({
      "content-type": CONTENT_TYPE,
      "stripe-signature": STRIPE_SIGNATURE,
      "svix-id": SVIX_ID,
      "svix-timestamp": SVIX_TIMESTAMP,
      "svix-signature": SVIX_SIGNATURE,
    });
  });

  it("captures a timeout and a network error", async () => {
    const created = await createEndpoint({
      name: "Stripe flaky",
      target_url: "https://example.com/webhooks/stripe",
    });
    const endpoint = created.endpoint!;

    installFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const timedOut = await relayRequest(endpoint.endpoint_key);
    expect(timedOut.status).toBe(200);
    const timedOutBody = (await timedOut.json()) as { event: { id: string; reason: string } };
    expect(timedOutBody.event.reason).toBe("relay: timeout");

    installFetch(() => {
      throw new TypeError("connect ECONNREFUSED");
    });
    const dropped = await relayRequest(endpoint.endpoint_key, { body: RAW_BODY });
    expect(dropped.status).toBe(200);
    const droppedBody = (await dropped.json()) as { event: { reason: string } };
    expect(droppedBody.event.reason).toBe("relay: network error");

    const timeoutRow = await env.DB.prepare("SELECT payload, source FROM events WHERE id = ?")
      .bind(timedOutBody.event.id)
      .first<{ payload: string; source: string }>();
    expect(timeoutRow).toEqual({ payload: RAW_BODY, source: "relay" });
  });

  it("returns 410 for a deleted endpoint and does not call target_url", async () => {
    const calls = installFetch(() => new Response("nope", { status: 500 }));
    const created = await createEndpoint({
      name: "Retired",
      target_url: "https://example.com/webhooks/stripe",
    });
    const endpoint = created.endpoint!;

    const removed = await app.request(`/v1/endpoints/${endpoint.id}`, { method: "DELETE", headers: AUTH }, env);
    expect(removed.status).toBe(200);

    const response = await relayRequest(endpoint.endpoint_key);
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "endpoint_gone" } });
    expect(calls).toHaveLength(0);
  });

  it("shares the per-endpoint ingest rate limit", async () => {
    installFetch(() => new Response("ok", { status: 200 }));
    const created = await createEndpoint({
      name: "Limited relay",
      target_url: "https://example.com/webhooks/stripe",
    });
    const endpoint = created.endpoint!;

    expect((await relayRequest(endpoint.endpoint_key, { rateLimit: "1" })).status).toBe(200);
    const blocked = await relayRequest(endpoint.endpoint_key, { rateLimit: "1" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
    await expect(blocked.json()).resolves.toMatchObject({ error: { code: "rate_limited" } });

    const other = await createEndpoint({
      name: "Shared bucket",
      target_url: "https://example.com/webhooks/other",
    });
    const ingested = await app.request(
      `/v1/ingest/${other.endpoint!.endpoint_key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: { ok: true }, reason: "fills the window" }),
      },
      { ...env, INGEST_RATE_LIMIT: "1" },
    );
    expect(ingested.status).toBe(201);
    const relayBlocked = await relayRequest(other.endpoint!.endpoint_key, { rateLimit: "1" });
    expect(relayBlocked.status).toBe(429);
  });

  it("replays a captured event with the original raw body and signature", async () => {
    const calls = installFetch((n) =>
      n === 1 ? new Response("down", { status: 500 }) : new Response("ok", { status: 200 }),
    );
    const created = await createEndpoint({
      name: "Stripe replay",
      target_url: "https://example.com/webhooks/stripe",
      secret: "replay-secret",
    });
    const endpoint = created.endpoint!;

    const captured = await relayRequest(endpoint.endpoint_key);
    const capturedBody = (await captured.json()) as { event: { id: string } };

    const replayed = await app.request(
      `/v1/events/${capturedBody.event.id}/replay`,
      { method: "POST", headers: AUTH },
      env,
    );
    expect(replayed.status).toBe(200);
    const replayedBody = (await replayed.json()) as {
      event: { status: string };
      attempt: { success: boolean };
    };
    expect(replayedBody.event.status).toBe("replayed");
    expect(replayedBody.attempt.success).toBe(true);

    expect(calls).toHaveLength(2);
    const replay = calls[1]!;
    expect(replay.url).toBe("https://example.com/webhooks/stripe");
    expect(replay.body).toBe(RAW_BODY);
    expect(replay.headers.get("stripe-signature")).toBe(STRIPE_SIGNATURE);
    expect(replay.headers.get("svix-id")).toBe(SVIX_ID);
    expect(replay.headers.get("svix-timestamp")).toBe(SVIX_TIMESTAMP);
    expect(replay.headers.get("svix-signature")).toBe(SVIX_SIGNATURE);
    expect(replay.headers.get("content-type")).toBe(CONTENT_TYPE);
    expect(replay.headers.get("x-requeue-signature")).toMatch(/^sha256=/);
    expect(replay.headers.get("x-requeue-event-id")).toBe(capturedBody.event.id);
  });

  it("rejects a target_url that points at Requeue and does not fetch a stored loop", async () => {
    const rejected = await createEndpoint({
      name: "Loop",
      target_url: "https://api.getrequeue.com/v1/relay/epk_deadbeef",
    });
    expect(rejected.status).toBe(400);
    expect(rejected.error?.code).toBe("invalid_target_url");

    const created = await createEndpoint({
      name: "Will loop",
      target_url: "https://example.com/webhooks/stripe",
    });
    const endpoint = created.endpoint!;
    const patched = await app.request(
      `/v1/endpoints/${endpoint.id}`,
      {
        method: "PATCH",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ target_url: "http://localhost/v1/ingest/epk_other" }),
      },
      env,
    );
    expect(patched.status).toBe(400);

    await env.DB.prepare("UPDATE endpoints SET target_url = ? WHERE id = ?")
      .bind("https://api.getrequeue.com/v1/ingest/epk_stored", endpoint.id)
      .run();

    const calls = installFetch(() => new Response("should not run", { status: 200 }));
    const response = await relayRequest(endpoint.endpoint_key);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { captured: boolean; event: { reason: string } };
    expect(body.captured).toBe(true);
    expect(body.event.reason).toBe("relay: loop");
    expect(calls).toHaveLength(0);
  });

  it("returns 413 for an oversized body and 404 for an unknown key", async () => {
    const calls = installFetch(() => new Response("ok", { status: 200 }));
    const created = await createEndpoint({
      name: "Big",
      target_url: "https://example.com/webhooks/stripe",
    });
    const oversized = await relayRequest(created.endpoint!.endpoint_key, {
      body: "x".repeat(512 * 1024 + 1),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ error: { code: "payload_too_large" } });
    expect(calls).toHaveLength(0);

    const unknown = await relayRequest("epk_missing");
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ error: { code: "unknown_endpoint" } });
  });

  it("notifies alert_url after a captured failure", async () => {
    const calls = installFetch(() => new Response("nope", { status: 500 }));
    const created = await createEndpoint({
      name: "Alert relay",
      target_url: "https://example.com/webhooks/stripe",
      alert_url: "https://alerts.example/hooks/requeue",
    });
    const endpoint = created.endpoint!;

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`http://localhost/v1/relay/${endpoint.endpoint_key}`, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": STRIPE_SIGNATURE },
        body: RAW_BODY,
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { event: { id: string; reason: string } };
    const alert = calls.find((call) => call.url === "https://alerts.example/hooks/requeue");
    expect(alert).toBeDefined();
    expect(JSON.parse(alert?.body ?? "")).toMatchObject({
      type: "event.ingested",
      event: {
        id: body.event.id,
        endpoint_id: endpoint.id,
        status: "failed",
        reason: "relay: upstream 500",
        source: "relay",
      },
    });
    expect(alert?.body).not.toContain("invoice.paid");
  });
});
