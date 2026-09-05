import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";

const DEMO_KEY = "rq_demo_local_dev_only_do_not_use_in_prod";
const BOOTSTRAP_SECRET = "test-bootstrap-secret-do-not-use-in-prod";
const AUTH = { Authorization: `Bearer ${DEMO_KEY}` };

describe("local demo key", () => {
  it("still authenticates management routes after the hosted revoke migration", async () => {
    const res = await app.request("/v1/billing", { headers: AUTH }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      billing: { plan: "free", status: "stubbed" },
    });
  });

  it("re-seeds key_demo after the hosted revoke migration", async () => {
    const listed = await env.DB.prepare("SELECT id FROM api_keys WHERE id = 'key_demo'").first<{
      id: string;
    }>();
    expect(listed?.id).toBe("key_demo");
  });
});

describe("POST /v1/api-keys bootstrap", () => {
  it("mints a project and key when the bootstrap secret matches", async () => {
    const res = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Requeue-Bootstrap-Secret": BOOTSTRAP_SECRET,
        },
        body: JSON.stringify({ name: "Maya production", project_name: "Production" }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      api_key: { id: string; token: string; key_prefix: string; name: string; project_id: string };
      project: { id: string; name: string };
    };
    expect(body.project.name).toBe("Production");
    expect(body.api_key.name).toBe("Maya production");
    expect(body.api_key.token).toMatch(/^rq_[0-9a-f]+$/);
    expect(body.api_key.token).not.toBe(DEMO_KEY);
    expect(body.api_key.key_prefix).toBe(body.api_key.token.slice(0, 11));

    const billed = await app.request(
      "/v1/billing",
      { headers: { Authorization: `Bearer ${body.api_key.token}` } },
      env,
    );
    expect(billed.status).toBe(200);
  });

  it("rejects a missing or wrong bootstrap secret", async () => {
    const missing = await app.request(
      "/v1/api-keys",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      env,
    );
    expect(missing.status).toBe(401);

    const wrong = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Requeue-Bootstrap-Secret": "nope",
        },
        body: "{}",
      },
      env,
    );
    expect(wrong.status).toBe(401);
  });

  it("rejects bootstrap when BOOTSTRAP_SECRET is not configured", async () => {
    const res = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Requeue-Bootstrap-Secret": BOOTSTRAP_SECRET,
        },
        body: "{}",
      },
      { ...env, BOOTSTRAP_SECRET: undefined },
    );
    expect(res.status).toBe(401);
  });
});

describe("authenticated API key management", () => {
  it("mints an additional key for the same project and can revoke it", async () => {
    const created = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ name: "Second local key" }),
      },
      env,
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      api_key: { id: string; token: string; name: string };
    };
    expect(createdBody.api_key.name).toBe("Second local key");
    expect(createdBody.api_key.token).toMatch(/^rq_[0-9a-f]+$/);

    const listed = await app.request("/v1/api-keys", { headers: AUTH }, env);
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      api_keys: Array<{ id: string; token?: string; key_hash?: string }>;
      count: number;
    };
    expect(listedBody.count).toBeGreaterThanOrEqual(2);
    expect(listedBody.api_keys.some((key) => key.id === createdBody.api_key.id)).toBe(true);
    expect(listedBody.api_keys.every((key) => key.token === undefined)).toBe(true);
    expect(listedBody.api_keys.every((key) => key.key_hash === undefined)).toBe(true);

    const revoked = await app.request(`/v1/api-keys/${createdBody.api_key.id}`, {
      method: "DELETE",
      headers: AUTH,
    }, env);
    expect(revoked.status).toBe(200);

    const after = await app.request(
      "/v1/billing",
      { headers: { Authorization: `Bearer ${createdBody.api_key.token}` } },
      env,
    );
    expect(after.status).toBe(401);
  });
});
