import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";

const DEMO_KEY = "rq_demo_local_dev_only_do_not_use_in_prod";
const BOOTSTRAP_SECRET = "test-bootstrap-secret-do-not-use-in-prod";
const AUTH = { Authorization: `Bearer ${DEMO_KEY}` };

type PublicEndpoint = {
  id: string;
  endpoint_key: string;
};

type PublicEvent = {
  id: string;
  endpoint_id: string;
  status: string;
};

async function createEndpoint(name: string, targetUrl: string, headers = AUTH) {
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
  const body = (await res.json()) as { endpoint: PublicEndpoint };
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
        reason: "test failure",
        source: "worker",
      }),
    },
    env,
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { event: PublicEvent };
  return body.event;
}

describe("GET /v1/events?endpoint_id=", () => {
  it("filters failures to one project endpoint", async () => {
    const orders = await createEndpoint("Orders", "https://example.com/hooks/orders");
    const billing = await createEndpoint("Billing", "https://example.com/hooks/billing");

    const ordersEvent = await ingestFailure(orders.endpoint_key, "ord_filter_1");
    const billingEvent = await ingestFailure(billing.endpoint_key, "bill_filter_1");

    const filtered = await app.request(`/v1/events?endpoint_id=${orders.id}`, { headers: AUTH }, env);
    expect(filtered.status).toBe(200);
    const filteredBody = (await filtered.json()) as { events: PublicEvent[]; count: number };

    expect(filteredBody.events.every((event) => event.endpoint_id === orders.id)).toBe(true);
    expect(filteredBody.events.some((event) => event.id === ordersEvent.id)).toBe(true);
    expect(filteredBody.events.some((event) => event.id === billingEvent.id)).toBe(false);

    const withStatus = await app.request(
      `/v1/events?status=failed&endpoint_id=${orders.id}`,
      { headers: AUTH },
      env,
    );
    expect(withStatus.status).toBe(200);
    const withStatusBody = (await withStatus.json()) as { events: PublicEvent[] };
    expect(withStatusBody.events.every((event) => event.endpoint_id === orders.id)).toBe(true);
    expect(withStatusBody.events.every((event) => event.status === "failed")).toBe(true);
    expect(withStatusBody.events.some((event) => event.id === ordersEvent.id)).toBe(true);
  });

  it("rejects a malformed endpoint_id", async () => {
    const empty = await app.request("/v1/events?endpoint_id=", { headers: AUTH }, env);
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toMatchObject({
      error: { code: "invalid_endpoint_id" },
    });

    const bad = await app.request("/v1/events?endpoint_id=not-an-id", { headers: AUTH }, env);
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toMatchObject({
      error: { code: "invalid_endpoint_id" },
    });

    const keyInsteadOfId = await app.request("/v1/events?endpoint_id=epk_abc", { headers: AUTH }, env);
    expect(keyInsteadOfId.status).toBe(400);
  });

  it("returns an empty list for an unknown well-formed endpoint id", async () => {
    const res = await app.request("/v1/events?endpoint_id=ep_ffffffffffffffffffffffffffffffff", {
      headers: AUTH,
    }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ events: [], count: 0 });
  });

  it("does not leak another project's events", async () => {
    const local = await createEndpoint("Local dest", "https://example.com/hooks/local");
    const localEvent = await ingestFailure(local.endpoint_key, "ord_local");

    const otherProject = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Requeue-Bootstrap-Secret": BOOTSTRAP_SECRET,
        },
        body: JSON.stringify({ name: "Other key", project_name: "Other project" }),
      },
      env,
    );
    const otherBody = (await otherProject.json()) as { api_key: { token: string } };
    const otherAuth = { Authorization: `Bearer ${otherBody.api_key.token}` };
    const other = await createEndpoint("Other dest", "https://example.com/hooks/other", otherAuth);
    await ingestFailure(other.endpoint_key, "ord_other");

    const listed = await app.request(`/v1/events?endpoint_id=${other.id}`, { headers: AUTH }, env);
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { events: PublicEvent[]; count: number };
    expect(listedBody.count).toBe(0);
    expect(listedBody.events.some((event) => event.id === localEvent.id)).toBe(false);

    const otherListed = await app.request(`/v1/events?endpoint_id=${local.id}`, { headers: otherAuth }, env);
    expect(otherListed.status).toBe(200);
    const otherListedBody = (await otherListed.json()) as { events: PublicEvent[]; count: number };
    expect(otherListedBody.count).toBe(0);
  });
});
