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
