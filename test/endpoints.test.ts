import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";

const DEMO_KEY = "rq_demo_local_dev_only_do_not_use_in_prod";
const BOOTSTRAP_SECRET = "test-bootstrap-secret-do-not-use-in-prod";
const AUTH = { Authorization: `Bearer ${DEMO_KEY}` };

type PublicEndpoint = {
  id: string;
  project_id: string;
  name: string;
  endpoint_key: string;
  target_url: string;
  ingest_path: string;
  has_secret: boolean;
  created_at: string;
  secret?: string;
};

async function createEndpoint(body: Record<string, unknown>, headers = AUTH) {
  return app.request(
    "/v1/endpoints",
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("GET /v1/endpoints", () => {
  it("rejects missing or invalid API keys", async () => {
    const missing = await app.request("/v1/endpoints", {}, env);
    expect(missing.status).toBe(401);

    const invalid = await app.request(
      "/v1/endpoints",
      { headers: { Authorization: "Bearer rq_not_a_real_key" } },
      env,
    );
    expect(invalid.status).toBe(401);

    const patchUnauth = await app.request(
      "/v1/endpoints/ep_x",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" },
      env,
    );
    expect(patchUnauth.status).toBe(401);

    const deleteUnauth = await app.request("/v1/endpoints/ep_x", { method: "DELETE" }, env);
    expect(deleteUnauth.status).toBe(401);
  });

  it("lists project endpoints without returning secrets", async () => {
    const withSecret = await createEndpoint({
      name: "Orders worker",
      target_url: "https://example.com/hooks/orders",
      secret: "hook-secret",
    });
    expect(withSecret.status).toBe(201);
    const withSecretBody = (await withSecret.json()) as { endpoint: PublicEndpoint };

    const withoutSecret = await createEndpoint({
      name: "Billing worker",
      target_url: "https://example.com/hooks/billing",
    });
    expect(withoutSecret.status).toBe(201);
    const withoutSecretBody = (await withoutSecret.json()) as { endpoint: PublicEndpoint };

    const listed = await app.request("/v1/endpoints", { headers: AUTH }, env);
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { endpoints: PublicEndpoint[]; count: number };

    expect(listedBody.count).toBeGreaterThanOrEqual(2);
    const orders = listedBody.endpoints.find((row) => row.id === withSecretBody.endpoint.id);
    const billing = listedBody.endpoints.find((row) => row.id === withoutSecretBody.endpoint.id);
    expect(orders).toMatchObject({
      name: "Orders worker",
      target_url: "https://example.com/hooks/orders",
      has_secret: true,
      ingest_path: `/v1/ingest/${withSecretBody.endpoint.endpoint_key}`,
    });
    expect(billing).toMatchObject({
      name: "Billing worker",
      has_secret: false,
    });
    expect(listedBody.endpoints.every((row) => row.secret === undefined)).toBe(true);
    expect(JSON.stringify(listedBody)).not.toContain("hook-secret");
  });

  it("returns a single project endpoint and 404s for other projects", async () => {
    const created = await createEndpoint({
      name: "Detail target",
      target_url: "https://example.com/hooks/detail",
      secret: "detail-secret",
    });
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };

    const detail = await app.request(`/v1/endpoints/${createdBody.endpoint.id}`, { headers: AUTH }, env);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { endpoint: PublicEndpoint };
    expect(detailBody.endpoint.id).toBe(createdBody.endpoint.id);
    expect(detailBody.endpoint.has_secret).toBe(true);
    expect(detailBody.endpoint.secret).toBeUndefined();

    const missing = await app.request("/v1/endpoints/ep_does_not_exist", { headers: AUTH }, env);
    expect(missing.status).toBe(404);

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
    const cross = await app.request(`/v1/endpoints/${createdBody.endpoint.id}`, {
      headers: { Authorization: `Bearer ${otherBody.api_key.token}` },
    }, env);
    expect(cross.status).toBe(404);

    const otherList = await app.request("/v1/endpoints", {
      headers: { Authorization: `Bearer ${otherBody.api_key.token}` },
    }, env);
    const otherListBody = (await otherList.json()) as { endpoints: PublicEndpoint[]; count: number };
    expect(otherListBody.endpoints.some((row) => row.id === createdBody.endpoint.id)).toBe(false);
  });
});

async function mintOtherProjectKey() {
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
  return { Authorization: `Bearer ${otherBody.api_key.token}` };
}

function patchEndpoint(id: string, body: unknown, headers = AUTH) {
  return app.request(
    `/v1/endpoints/${id}`,
    {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

function deleteEndpoint(id: string, headers = AUTH) {
  return app.request(`/v1/endpoints/${id}`, { method: "DELETE", headers }, env);
}

describe("PATCH /v1/endpoints/:id", () => {
  it("updates name, target_url, and secret without rotating endpoint_key", async () => {
    const created = await createEndpoint({
      name: "Orders worker",
      target_url: "https://example.com/hooks/orders",
      secret: "old-secret",
    });
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };
    const originalKey = createdBody.endpoint.endpoint_key;

    const patched = await patchEndpoint(createdBody.endpoint.id, {
      name: "Orders v2",
      target_url: "https://example.com/hooks/orders-v2",
      secret: "rotated-secret",
      endpoint_key: "epk_should_not_apply",
    });
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as { endpoint: PublicEndpoint };
    expect(patchedBody.endpoint).toMatchObject({
      id: createdBody.endpoint.id,
      name: "Orders v2",
      target_url: "https://example.com/hooks/orders-v2",
      endpoint_key: originalKey,
      ingest_path: `/v1/ingest/${originalKey}`,
      has_secret: true,
    });
    expect(patchedBody.endpoint.secret).toBeUndefined();
    expect(JSON.stringify(patchedBody)).not.toContain("rotated-secret");

    const detail = await app.request(`/v1/endpoints/${createdBody.endpoint.id}`, { headers: AUTH }, env);
    const detailBody = (await detail.json()) as { endpoint: PublicEndpoint };
    expect(detailBody.endpoint.endpoint_key).toBe(originalKey);
    expect(detailBody.endpoint.name).toBe("Orders v2");
    expect(detailBody.endpoint.has_secret).toBe(true);

    const nameOnly = await patchEndpoint(createdBody.endpoint.id, { name: "Orders v2b" });
    expect(nameOnly.status).toBe(200);
    await expect(nameOnly.json()).resolves.toMatchObject({
      endpoint: {
        name: "Orders v2b",
        target_url: "https://example.com/hooks/orders-v2",
        endpoint_key: originalKey,
        has_secret: true,
      },
    });
  });

  it("clears the HMAC secret with an empty string or null", async () => {
    const created = await createEndpoint({
      name: "Secret target",
      target_url: "https://example.com/hooks/secret",
      secret: "hook-secret",
    });
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };
    expect(createdBody.endpoint.has_secret).toBe(true);

    const clearedEmpty = await patchEndpoint(createdBody.endpoint.id, { secret: "" });
    expect(clearedEmpty.status).toBe(200);
    const clearedEmptyBody = (await clearedEmpty.json()) as { endpoint: PublicEndpoint };
    expect(clearedEmptyBody.endpoint.has_secret).toBe(false);

    const restored = await patchEndpoint(createdBody.endpoint.id, { secret: "again" });
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({ endpoint: { has_secret: true } });

    const clearedNull = await patchEndpoint(createdBody.endpoint.id, { secret: null });
    expect(clearedNull.status).toBe(200);
    const clearedNullBody = (await clearedNull.json()) as { endpoint: PublicEndpoint };
    expect(clearedNullBody.endpoint.has_secret).toBe(false);
    expect(clearedNullBody.endpoint.secret).toBeUndefined();
  });

  it("accepts a partial update and rejects invalid target_url", async () => {
    const created = await createEndpoint({
      name: "Partial",
      target_url: "https://example.com/hooks/partial",
    });
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };

    const renamed = await patchEndpoint(createdBody.endpoint.id, { name: "Renamed only" });
    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toMatchObject({
      endpoint: {
        name: "Renamed only",
        target_url: "https://example.com/hooks/partial",
        endpoint_key: createdBody.endpoint.endpoint_key,
      },
    });

    const badUrl = await patchEndpoint(createdBody.endpoint.id, { target_url: "not-a-url" });
    expect(badUrl.status).toBe(400);
    await expect(badUrl.json()).resolves.toMatchObject({
      error: { code: "invalid_target_url" },
    });

    const ftp = await patchEndpoint(createdBody.endpoint.id, { target_url: "ftp://example.com/hooks" });
    expect(ftp.status).toBe(400);

    const emptyName = await patchEndpoint(createdBody.endpoint.id, { name: "  " });
    expect(emptyName.status).toBe(400);
    await expect(emptyName.json()).resolves.toMatchObject({
      error: { code: "invalid_name" },
    });

    const badSecret = await patchEndpoint(createdBody.endpoint.id, { secret: 123 });
    expect(badSecret.status).toBe(400);
    await expect(badSecret.json()).resolves.toMatchObject({
      error: { code: "invalid_secret" },
    });

    const notObject = await patchEndpoint(createdBody.endpoint.id, ["nope"]);
    expect(notObject.status).toBe(400);
    await expect(notObject.json()).resolves.toMatchObject({
      error: { code: "invalid_body" },
    });
  });

  it("returns 404 for missing endpoints and other projects", async () => {
    const created = await createEndpoint({
      name: "Scoped",
      target_url: "https://example.com/hooks/scoped",
    });
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };

    const missing = await patchEndpoint("ep_does_not_exist", { name: "Nope" });
    expect(missing.status).toBe(404);

    const otherAuth = await mintOtherProjectKey();
    const cross = await patchEndpoint(createdBody.endpoint.id, { name: "Stolen" }, otherAuth);
    expect(cross.status).toBe(404);

    const still = await app.request(`/v1/endpoints/${createdBody.endpoint.id}`, { headers: AUTH }, env);
    const stillBody = (await still.json()) as { endpoint: PublicEndpoint };
    expect(stillBody.endpoint.name).toBe("Scoped");
  });
});

describe("DELETE /v1/endpoints/:id", () => {
  it("soft-deletes an endpoint and stops ingest without wiping events", async () => {
    const created = await createEndpoint({
      name: "Retire me",
      target_url: "https://example.com/hooks/retire",
    });
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };

    const ingested = await app.request(
      `/v1/ingest/${createdBody.endpoint.endpoint_key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: { order_id: "ord_keep" }, reason: "keep history" }),
      },
      env,
    );
    expect(ingested.status).toBe(201);
    const ingestedBody = (await ingested.json()) as { event: { id: string; endpoint_id: string } };

    const queued = await app.request(
      `/v1/events/${ingestedBody.event.id}/replay`,
      {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ enqueue: true }),
      },
      env,
    );
    expect(queued.status).toBe(200);

    const deleted = await deleteEndpoint(createdBody.endpoint.id);
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      deleted: true,
      id: createdBody.endpoint.id,
    });

    const detail = await app.request(`/v1/endpoints/${createdBody.endpoint.id}`, { headers: AUTH }, env);
    expect(detail.status).toBe(404);

    const listed = await app.request("/v1/endpoints", { headers: AUTH }, env);
    const listedBody = (await listed.json()) as { endpoints: PublicEndpoint[] };
    expect(listedBody.endpoints.some((row) => row.id === createdBody.endpoint.id)).toBe(false);

    const ingestGone = await app.request(
      `/v1/ingest/${createdBody.endpoint.endpoint_key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: { order_id: "ord_after" } }),
      },
      env,
    );
    expect(ingestGone.status).toBe(410);
    await expect(ingestGone.json()).resolves.toMatchObject({
      error: { code: "endpoint_gone" },
    });

    const events = await app.request(`/v1/events?endpoint_id=${createdBody.endpoint.id}`, {
      headers: AUTH,
    }, env);
    expect(events.status).toBe(200);
    const eventsBody = (await events.json()) as { events: Array<{ id: string; status: string }> };
    expect(eventsBody.events.some((event) => event.id === ingestedBody.event.id)).toBe(true);
    expect(eventsBody.events.find((event) => event.id === ingestedBody.event.id)?.status).toBe(
      "replay_failed",
    );

    const replay = await app.request(`/v1/events/${ingestedBody.event.id}/replay`, {
      method: "POST",
      headers: AUTH,
    }, env);
    expect(replay.status).toBe(410);
    await expect(replay.json()).resolves.toMatchObject({
      error: { code: "endpoint_gone" },
    });

    const again = await deleteEndpoint(createdBody.endpoint.id);
    expect(again.status).toBe(404);
  });

  it("returns 404 for missing endpoints and other projects", async () => {
    const created = await createEndpoint({
      name: "Keep",
      target_url: "https://example.com/hooks/keep",
    });
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };

    const missing = await deleteEndpoint("ep_does_not_exist");
    expect(missing.status).toBe(404);

    const otherAuth = await mintOtherProjectKey();
    const cross = await deleteEndpoint(createdBody.endpoint.id, otherAuth);
    expect(cross.status).toBe(404);

    const still = await app.request(`/v1/endpoints/${createdBody.endpoint.id}`, { headers: AUTH }, env);
    expect(still.status).toBe(200);
  });
});
