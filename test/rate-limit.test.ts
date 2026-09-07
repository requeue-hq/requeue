import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";

const DEMO_KEY = "rq_demo_local_dev_only_do_not_use_in_prod";
const AUTH = { Authorization: `Bearer ${DEMO_KEY}` };

async function createEndpoint(name: string) {
  const created = await app.request(
    "/v1/endpoints",
    {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        name,
        target_url: "https://example.com/hooks/limited",
      }),
    },
    env,
  );
  const body = (await created.json()) as { endpoint: { id: string; endpoint_key: string } };
  return body.endpoint;
}

async function ingest(endpointKey: string, rateLimit: string) {
  return app.request(
    `/v1/ingest/${endpointKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { ok: true }, reason: "rate-limit test" }),
    },
    { ...env, INGEST_RATE_LIMIT: rateLimit },
  );
}

describe("POST /v1/ingest/:endpointKey rate limit", () => {
  it("returns 429 when the per-endpoint window is exceeded", async () => {
    const endpoint = await createEndpoint("Limited worker");

    const first = await ingest(endpoint.endpoint_key, "2");
    const second = await ingest(endpoint.endpoint_key, "2");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const blocked = await ingest(endpoint.endpoint_key, "2");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: "rate_limited" },
    });
  });

  it("isolates the limit per endpoint and still 404s unknown keys", async () => {
    const limited = await createEndpoint("Noisy worker");
    const other = await createEndpoint("Quiet worker");

    expect((await ingest(limited.endpoint_key, "1")).status).toBe(201);
    expect((await ingest(limited.endpoint_key, "1")).status).toBe(429);
    expect((await ingest(other.endpoint_key, "1")).status).toBe(201);

    const unknown = await ingest("epk_does_not_exist", "1");
    expect(unknown.status).toBe(404);
  });
});
