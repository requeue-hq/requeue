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

type AlertCall = {
  url: string;
  method: string;
  contentType: string;
  body: string;
};

function installFetch(respond: () => Response | Promise<Response>): AlertCall[] {
  const calls: AlertCall[] = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method ?? "GET",
      contentType: new Headers(init?.headers).get("content-type") ?? "",
      body: typeof init?.body === "string" ? init.body : "",
    });
    return respond();
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
  expect(response.status).toBe(201);
  return (await response.json()) as {
    endpoint: { id: string; endpoint_key: string; alert_url: string | null };
  };
}

async function ingest(endpointKey: string, body: Record<string, unknown>) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`http://localhost/v1/ingest/${endpointKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("ingest alert_url", () => {
  it("POSTs one small notification after the event is stored", async () => {
    const calls = installFetch(() => new Response("ok", { status: 204 }));
    const created = await createEndpoint({
      name: "Alert ingest",
      target_url: "https://example.com/hooks/orders",
      alert_url: "https://alerts.example/hooks/requeue",
    });

    const ingested = await ingest(created.endpoint.endpoint_key, {
      payload: { order_id: "ord_alert", secret_blob: "do-not-forward" },
      reason: "fulfillment timeout",
      source: "worker",
      headers: { "x-request-id": "req_do_not_forward" },
    });
    expect(ingested.status).toBe(201);
    const ingestedBody = (await ingested.json()) as {
      event: {
        id: string;
        endpoint_id: string;
        status: string;
        reason: string;
        source: string;
        created_at: string;
        payload: unknown;
      };
    };
    expect(ingestedBody.event.payload).toEqual({
      order_id: "ord_alert",
      secret_blob: "do-not-forward",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://alerts.example/hooks/requeue",
      method: "POST",
      contentType: "application/json",
    });
    const alert = JSON.parse(calls[0]?.body ?? "") as {
      type: string;
      event: Record<string, unknown>;
    };
    expect(alert).toEqual({
      type: "event.ingested",
      event: {
        id: ingestedBody.event.id,
        endpoint_id: created.endpoint.id,
        status: "failed",
        reason: "fulfillment timeout",
        source: "worker",
        created_at: ingestedBody.event.created_at,
      },
    });
    expect(alert.event.payload).toBeUndefined();
    expect(alert.event.headers).toBeUndefined();
    expect(calls[0]?.body).not.toContain("do-not-forward");
    expect(calls[0]?.body).not.toContain("req_do_not_forward");
  });

  it("still stores the event when the alert POST returns 500", async () => {
    const calls = installFetch(() => new Response("nope", { status: 500 }));
    const created = await createEndpoint({
      name: "Alert 500",
      target_url: "https://example.com/hooks/orders",
      alert_url: "https://alerts.example/hooks/five-hundred",
    });

    const ingested = await ingest(created.endpoint.endpoint_key, {
      payload: { order_id: "ord_500" },
      reason: "upstream 500",
    });
    expect(ingested.status).toBe(201);
    const ingestedBody = (await ingested.json()) as { event: { id: string; status: string } };
    expect(ingestedBody.event.status).toBe("failed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://alerts.example/hooks/five-hundred");

    const detail = await app.request(`/v1/events/${ingestedBody.event.id}`, { headers: AUTH }, env);
    expect(detail.status).toBe(200);
  });

  it("still stores the event when the alert POST throws", async () => {
    const calls = installFetch(() => {
      throw new Error("alert endpoint down");
    });
    const created = await createEndpoint({
      name: "Alert throw",
      target_url: "https://example.com/hooks/orders",
      alert_url: "https://alerts.example/hooks/throw",
    });

    const ingested = await ingest(created.endpoint.endpoint_key, {
      payload: { order_id: "ord_throw" },
      reason: "network",
    });
    expect(ingested.status).toBe(201);
    const ingestedBody = (await ingested.json()) as { event: { id: string } };
    expect(calls).toHaveLength(1);

    const detail = await app.request(`/v1/events/${ingestedBody.event.id}`, { headers: AUTH }, env);
    expect(detail.status).toBe(200);
  });

  it("does not call fetch when alert_url is unset", async () => {
    const calls = installFetch(() => new Response("ok", { status: 200 }));
    const created = await createEndpoint({
      name: "No alert ingest",
      target_url: "https://example.com/hooks/orders",
    });
    expect(created.endpoint.alert_url).toBeNull();

    const ingested = await ingest(created.endpoint.endpoint_key, {
      payload: { order_id: "ord_quiet" },
      reason: "no page",
    });
    expect(ingested.status).toBe(201);
    expect(calls).toHaveLength(0);
  });

  it("does not alert when the endpoint is soft-deleted", async () => {
    const calls = installFetch(() => new Response("ok", { status: 200 }));
    const created = await createEndpoint({
      name: "Deleted alert",
      target_url: "https://example.com/hooks/orders",
      alert_url: "https://alerts.example/hooks/gone",
    });

    const deleted = await app.request(`/v1/endpoints/${created.endpoint.id}`, {
      method: "DELETE",
      headers: AUTH,
    }, env);
    expect(deleted.status).toBe(200);

    const ingested = await ingest(created.endpoint.endpoint_key, {
      payload: { order_id: "ord_gone" },
    });
    expect(ingested.status).toBe(410);
    await expect(ingested.json()).resolves.toMatchObject({ error: { code: "endpoint_gone" } });
    expect(calls).toHaveLength(0);
  });
});
