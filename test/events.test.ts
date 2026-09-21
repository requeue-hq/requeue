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

async function ingestFailure(
  endpointKey: string,
  orderId: string,
  fields?: { reason?: string; source?: string },
) {
  const res = await app.request(
    `/v1/ingest/${endpointKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: { order_id: orderId },
        reason: fields?.reason ?? "test failure",
        source: fields?.source ?? "worker",
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

describe("GET /v1/events?q=", () => {
  it("leaves the list unchanged when q is omitted or blank", async () => {
    const endpoint = await createEndpoint("Search inbox", "https://example.com/hooks/search");
    const alpha = await ingestFailure(endpoint.endpoint_key, "ord_q_alpha", {
      reason: "alpha reason qsearch",
    });
    const beta = await ingestFailure(endpoint.endpoint_key, "ord_q_beta", {
      reason: "beta reason qsearch",
    });

    const unfiltered = await app.request(`/v1/events?endpoint_id=${endpoint.id}`, { headers: AUTH }, env);
    expect(unfiltered.status).toBe(200);
    const unfilteredBody = (await unfiltered.json()) as { events: PublicEvent[]; count: number };
    expect(unfilteredBody.count).toBe(2);
    expect(unfilteredBody.events.map((event) => event.id).sort()).toEqual([alpha.id, beta.id].sort());

    const blank = await app.request(`/v1/events?endpoint_id=${endpoint.id}&q=%20%20`, { headers: AUTH }, env);
    expect(blank.status).toBe(200);
    const blankBody = (await blank.json()) as { events: PublicEvent[]; count: number };
    expect(blankBody.events.map((event) => event.id).sort()).toEqual(
      unfilteredBody.events.map((event) => event.id).sort(),
    );
    expect(blankBody.count).toBe(unfilteredBody.count);

    const empty = await app.request(`/v1/events?endpoint_id=${endpoint.id}&q=`, { headers: AUTH }, env);
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as { events: PublicEvent[]; count: number };
    expect(emptyBody.count).toBe(unfilteredBody.count);

    const limited = await app.request(`/v1/events?endpoint_id=${endpoint.id}&q=qsearch&limit=1`, {
      headers: AUTH,
    }, env);
    const limitedBody = (await limited.json()) as { events: PublicEvent[]; count: number };
    expect(limitedBody.count).toBe(1);
    expect(limitedBody.events).toHaveLength(1);
  });

  it("matches reason, source, and payload text case-insensitively", async () => {
    const endpoint = await createEndpoint("Search fields", "https://example.com/hooks/search-fields");
    const byReason = await ingestFailure(endpoint.endpoint_key, "ord_q_reason", {
      reason: "Fulfillment Timeout QSearch",
      source: "checkout",
    });
    const bySource = await ingestFailure(endpoint.endpoint_key, "ord_q_source", {
      reason: "unrelated",
      source: "Billing-Worker-QSearch",
    });
    const byPayload = await ingestFailure(endpoint.endpoint_key, "ord_q_payload_77", {
      reason: "other",
      source: "worker",
    });

    const reasonHit = await app.request(
      `/v1/events?endpoint_id=${endpoint.id}&q=${encodeURIComponent("fulfillment timeout qsearch")}`,
      { headers: AUTH },
      env,
    );
    expect(reasonHit.status).toBe(200);
    const reasonBody = (await reasonHit.json()) as { events: PublicEvent[]; count: number };
    expect(reasonBody.count).toBe(1);
    expect(reasonBody.events[0]?.id).toBe(byReason.id);

    const sourceHit = await app.request(
      `/v1/events?endpoint_id=${endpoint.id}&q=billing-worker-qsearch`,
      { headers: AUTH },
      env,
    );
    const sourceBody = (await sourceHit.json()) as { events: PublicEvent[] };
    expect(sourceBody.events.map((event) => event.id)).toEqual([bySource.id]);

    const payloadHit = await app.request(
      `/v1/events?endpoint_id=${endpoint.id}&q=ord_q_payload_77`,
      { headers: AUTH },
      env,
    );
    const payloadBody = (await payloadHit.json()) as { events: PublicEvent[] };
    expect(payloadBody.events.map((event) => event.id)).toEqual([byPayload.id]);
  });

  it("matches an event id prefix", async () => {
    const endpoint = await createEndpoint("Search id", "https://example.com/hooks/search-id");
    const target = await ingestFailure(endpoint.endpoint_key, "ord_q_id_target", {
      reason: "id target",
    });
    const other = await ingestFailure(endpoint.endpoint_key, "ord_q_id_other", {
      reason: "id other",
    });
    const prefix = target.id.slice(0, 16);
    expect(other.id.includes(prefix)).toBe(false);

    const res = await app.request(
      `/v1/events?endpoint_id=${endpoint.id}&q=${encodeURIComponent(prefix)}`,
      { headers: AUTH },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: PublicEvent[]; count: number };
    expect(body.events.some((event) => event.id === target.id)).toBe(true);
    expect(body.events.some((event) => event.id === other.id)).toBe(false);
  });

  it("returns an empty list when q matches nothing", async () => {
    const endpoint = await createEndpoint("Search miss", "https://example.com/hooks/search-miss");
    await ingestFailure(endpoint.endpoint_key, "ord_q_miss", { reason: "present failure" });

    const res = await app.request(
      `/v1/events?endpoint_id=${endpoint.id}&q=zzznomatch_qsearch_token`,
      { headers: AUTH },
      env,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ events: [], count: 0 });
  });

  it("composes q with status and does not leak another project", async () => {
    const endpoint = await createEndpoint("Search compose", "https://example.com/hooks/search-compose");
    const failed = await ingestFailure(endpoint.endpoint_key, "ord_q_compose", {
      reason: "shared compose token qsearch",
    });

    const replayedFilter = await app.request(
      `/v1/events?endpoint_id=${endpoint.id}&status=replayed&q=${encodeURIComponent("shared compose token qsearch")}`,
      { headers: AUTH },
      env,
    );
    expect(replayedFilter.status).toBe(200);
    await expect(replayedFilter.json()).resolves.toEqual({ events: [], count: 0 });

    const failedFilter = await app.request(
      `/v1/events?status=failed&q=${encodeURIComponent("shared compose token qsearch")}`,
      { headers: AUTH },
      env,
    );
    const failedBody = (await failedFilter.json()) as { events: PublicEvent[] };
    expect(failedBody.events.some((event) => event.id === failed.id)).toBe(true);
    expect(failedBody.events.every((event) => event.status === "failed")).toBe(true);

    const otherProject = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Requeue-Bootstrap-Secret": BOOTSTRAP_SECRET,
        },
        body: JSON.stringify({ name: "Search other key", project_name: "Search other project" }),
      },
      env,
    );
    const otherBody = (await otherProject.json()) as { api_key: { token: string } };
    const otherAuth = { Authorization: `Bearer ${otherBody.api_key.token}` };

    const leaked = await app.request(
      `/v1/events?q=${encodeURIComponent("shared compose token qsearch")}`,
      { headers: otherAuth },
      env,
    );
    expect(leaked.status).toBe(200);
    await expect(leaked.json()).resolves.toEqual({ events: [], count: 0 });
  });

  it("treats LIKE metacharacters in q as literals", async () => {
    const endpoint = await createEndpoint("Search literal", "https://example.com/hooks/search-literal");
    const percent = await ingestFailure(endpoint.endpoint_key, "ord_q_pct", {
      reason: "100% cpu qsearch",
    });
    const underscore = await ingestFailure(endpoint.endpoint_key, "ord_q_under", {
      reason: "disk_full qsearch",
    });
    await ingestFailure(endpoint.endpoint_key, "ord_q_plain", { reason: "100X cpu qsearch" });
    await ingestFailure(endpoint.endpoint_key, "ord_q_under_decoy", { reason: "diskXfull qsearch" });

    const percentHit = await app.request(
      `/v1/events?endpoint_id=${endpoint.id}&q=${encodeURIComponent("100%")}`,
      { headers: AUTH },
      env,
    );
    const percentBody = (await percentHit.json()) as { events: PublicEvent[] };
    expect(percentBody.events.map((event) => event.id)).toEqual([percent.id]);

    const underscoreHit = await app.request(
      `/v1/events?endpoint_id=${endpoint.id}&q=${encodeURIComponent("disk_full")}`,
      { headers: AUTH },
      env,
    );
    const underscoreBody = (await underscoreHit.json()) as { events: PublicEvent[] };
    expect(underscoreBody.events.map((event) => event.id)).toEqual([underscore.id]);
  });

  it("still rejects an unknown status", async () => {
    const res = await app.request("/v1/events?status=nope&q=timeout", { headers: AUTH }, env);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: "invalid_status" },
    });
  });
});
