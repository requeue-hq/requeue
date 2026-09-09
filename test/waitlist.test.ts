import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { app, MARKETING_ORIGINS } from "../src/app";

const DEMO_KEY = "rq_demo_local_dev_only_do_not_use_in_prod";

async function joinWaitlist(
  body: unknown,
  headers: Record<string, string> = {},
  bindings: typeof env = env,
) {
  return app.request(
    "/v1/waitlist",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    bindings,
  );
}

describe("POST /v1/waitlist", () => {
  it("accepts an email without auth and persists the row", async () => {
    const res = await joinWaitlist(
      { email: "Founder@Example.com", product: "requeue", source: "getrequeue.com" },
      { Origin: "https://getrequeue.com" },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://getrequeue.com");

    const row = await env.DB.prepare("SELECT email, product, source FROM waitlist WHERE email = ?")
      .bind("founder@example.com")
      .first<{ email: string; product: string; source: string }>();
    expect(row).toMatchObject({
      email: "founder@example.com",
      product: "requeue",
      source: "getrequeue.com",
    });
  });

  it("rejects a missing or invalid email", async () => {
    const missing = await joinWaitlist({ product: "requeue" });
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "invalid_email" },
    });

    const invalid = await joinWaitlist({ email: "not-an-email" });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: "invalid_email" },
    });

    const none = await env.DB.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE email = ?")
      .bind("not-an-email")
      .first<{ n: number }>();
    expect(none?.n ?? 0).toBe(0);
  });

  it("is idempotent for the same email and still returns ok", async () => {
    const first = await joinWaitlist({ email: "repeat@example.com", source: "landing" });
    const second = await joinWaitlist({ email: "Repeat@example.com", product: "requeue" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE email = ?")
      .bind("repeat@example.com")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("allows getrequeue.com and www via CORS preflight", async () => {
    for (const origin of MARKETING_ORIGINS) {
      const preflight = await app.request(
        "/v1/waitlist",
        {
          method: "OPTIONS",
          headers: {
            Origin: origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
          },
        },
        env,
      );
      expect(preflight.status).toBeLessThan(300);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
      expect(preflight.headers.get("access-control-allow-methods")?.toUpperCase()).toContain("POST");
    }
  });

  it("does not change auth on management routes", async () => {
    const unauth = await app.request("/v1/endpoints", {}, env);
    expect(unauth.status).toBe(401);

    const auth = await app.request(
      "/v1/endpoints",
      { headers: { Authorization: `Bearer ${DEMO_KEY}` } },
      env,
    );
    expect(auth.status).toBe(200);
  });
});
