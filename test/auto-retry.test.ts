import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { app } from "../src/app";
import {
  MAX_RETRY_DELAY_SECONDS,
  REPLAY_BACKOFF_SECONDS,
  nextReplayRetryAt,
  processPendingReplays,
} from "../src/outbox";

const DEMO_KEY = "rq_demo_local_dev_only_do_not_use_in_prod";
const AUTH = { Authorization: `Bearer ${DEMO_KEY}` };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type PublicEndpoint = {
  id: string;
  endpoint_key: string;
  auto_retry: boolean;
  retry_max_attempts: number;
  retry_base_delay_seconds: number;
  alert_url: string | null;
  name: string;
};

type PublicEvent = {
  id: string;
  status: string;
  retry_count: number;
  next_retry_at: string | null;
};

async function createEndpoint(body: Record<string, unknown>) {
  return app.request(
    "/v1/endpoints",
    {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function patchEndpoint(id: string, body: Record<string, unknown>) {
  return app.request(
    `/v1/endpoints/${id}`,
    {
      method: "PATCH",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function ingest(endpointKey: string, payload: Record<string, unknown> = { id: "auto" }) {
  return app.request(
    `/v1/ingest/${endpointKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload, reason: "boom", source: "worker" }),
    },
    env,
  );
}

async function isolateOutbox() {
  await env.DB.prepare(
    "UPDATE events SET status = 'failed', next_retry_at = NULL WHERE status = 'pending_replay'",
  ).run();
}

async function loadEvent(eventId: string) {
  return env.DB.prepare(
    "SELECT status, retry_count, next_retry_at, updated_at FROM events WHERE id = ?",
  )
    .bind(eventId)
    .first<{
      status: string;
      retry_count: number;
      next_retry_at: string | null;
      updated_at: string;
    }>();
}

function failTarget() {
  globalThis.fetch = async () => new Response("upstream down", { status: 503 });
}

describe("endpoint retry policy", () => {
  it("defaults auto-retry off with the historical outbox budget", async () => {
    const created = await createEndpoint({
      name: "Default retry",
      target_url: "https://example.com/hooks/default-retry",
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };
    expect(createdBody.endpoint).toMatchObject({
      auto_retry: false,
      retry_max_attempts: 6,
      retry_base_delay_seconds: 60,
    });

    const listed = await app.request("/v1/endpoints", { headers: AUTH }, env);
    const listedBody = (await listed.json()) as { endpoints: PublicEndpoint[] };
    expect(listedBody.endpoints.find((row) => row.id === createdBody.endpoint.id)).toMatchObject({
      auto_retry: false,
      retry_max_attempts: 6,
      retry_base_delay_seconds: 60,
    });
  });

  it("stores a custom policy and leaves omitted patch fields alone", async () => {
    const created = await createEndpoint({
      name: "Custom retry",
      target_url: "https://example.com/hooks/custom-retry",
      auto_retry: true,
      retry_max_attempts: 4,
      retry_base_delay_seconds: 30,
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };
    expect(createdBody.endpoint).toMatchObject({
      auto_retry: true,
      retry_max_attempts: 4,
      retry_base_delay_seconds: 30,
    });

    const renamed = await patchEndpoint(createdBody.endpoint.id, { name: "Custom retry renamed" });
    expect(renamed.status).toBe(200);
    const renamedBody = (await renamed.json()) as { endpoint: PublicEndpoint };
    expect(renamedBody.endpoint).toMatchObject({
      name: "Custom retry renamed",
      auto_retry: true,
      retry_max_attempts: 4,
      retry_base_delay_seconds: 30,
    });

    const disabled = await patchEndpoint(createdBody.endpoint.id, { auto_retry: false });
    expect(disabled.status).toBe(200);
    const disabledBody = (await disabled.json()) as { endpoint: PublicEndpoint };
    expect(disabledBody.endpoint).toMatchObject({
      auto_retry: false,
      retry_max_attempts: 4,
      retry_base_delay_seconds: 30,
    });

    const detail = await app.request(`/v1/endpoints/${createdBody.endpoint.id}`, { headers: AUTH }, env);
    const detailBody = (await detail.json()) as { endpoint: PublicEndpoint };
    expect(detailBody.endpoint.auto_retry).toBe(false);
    expect(detailBody.endpoint.retry_max_attempts).toBe(4);
  });

  it("rejects out-of-range and non-integer retry settings", async () => {
    const cases: Array<Record<string, unknown>> = [
      { auto_retry: 1 },
      { auto_retry: "true" },
      { retry_max_attempts: 0 },
      { retry_max_attempts: 21 },
      { retry_max_attempts: 1.5 },
      { retry_max_attempts: "6" },
      { retry_base_delay_seconds: 0 },
      { retry_base_delay_seconds: 86_401 },
    ];

    for (const extra of cases) {
      const rejected = await createEndpoint({
        name: "Rejected retry",
        target_url: "https://example.com/hooks/rejected-retry",
        ...extra,
      });
      expect(rejected.status).toBe(400);
      const body = (await rejected.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("invalid_body");
    }

    const created = await createEndpoint({
      name: "Patch reject retry",
      target_url: "https://example.com/hooks/patch-reject-retry",
      auto_retry: true,
      retry_max_attempts: 3,
    });
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };
    const patched = await patchEndpoint(createdBody.endpoint.id, { retry_base_delay_seconds: -1 });
    expect(patched.status).toBe(400);
    const detail = await app.request(`/v1/endpoints/${createdBody.endpoint.id}`, { headers: AUTH }, env);
    const detailBody = (await detail.json()) as { endpoint: PublicEndpoint };
    expect(detailBody.endpoint).toMatchObject({
      auto_retry: true,
      retry_max_attempts: 3,
      retry_base_delay_seconds: 60,
    });
  });

  it("accepts the inclusive bounds", async () => {
    const created = await createEndpoint({
      name: "Bounds retry",
      target_url: "https://example.com/hooks/bounds-retry",
      auto_retry: true,
      retry_max_attempts: 1,
      retry_base_delay_seconds: 1,
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };
    const patched = await patchEndpoint(createdBody.endpoint.id, {
      retry_max_attempts: 20,
      retry_base_delay_seconds: 86_400,
    });
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as { endpoint: PublicEndpoint };
    expect(patchedBody.endpoint).toMatchObject({
      auto_retry: true,
      retry_max_attempts: 20,
      retry_base_delay_seconds: 86_400,
    });
  });
});

describe("captured-failure auto retry", () => {
  it("computes per-endpoint exponential delays and caps a step at one day", () => {
    const from = "2026-09-07T16:00:00.000Z";
    expect(nextReplayRetryAt(1, from)).toBe("2026-09-07T16:01:00.000Z");
    expect(REPLAY_BACKOFF_SECONDS).toEqual([60, 120, 240, 480, 960]);

    const policy = { maxAttempts: 4, baseDelaySeconds: 30 };
    expect(nextReplayRetryAt(1, from, policy)).toBe("2026-09-07T16:00:30.000Z");
    expect(nextReplayRetryAt(2, from, policy)).toBe("2026-09-07T16:01:00.000Z");
    expect(nextReplayRetryAt(3, from, policy)).toBe("2026-09-07T16:02:00.000Z");
    expect(nextReplayRetryAt(4, from, policy)).toBeNull();

    const capped = { maxAttempts: 5, baseDelaySeconds: MAX_RETRY_DELAY_SECONDS };
    expect(nextReplayRetryAt(1, from, capped)).toBe("2026-09-08T16:00:00.000Z");
    expect(nextReplayRetryAt(2, from, capped)).toBe("2026-09-08T16:00:00.000Z");
  });

  it("queues a captured ingest on the outbox without delivering inside the request", async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return new Response("ok", { status: 204 });
    };

    const created = await createEndpoint({
      name: "Auto ingest",
      target_url: "https://example.com/hooks/auto-ingest",
      auto_retry: true,
      retry_max_attempts: 3,
      retry_base_delay_seconds: 45,
    });
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };

    const ingested = await ingest(createdBody.endpoint.endpoint_key, { id: "queued-now" });
    expect(ingested.status).toBe(201);
    const ingestedBody = (await ingested.json()) as { event: PublicEvent };
    expect(ingestedBody.event.status).toBe("pending_replay");
    expect(ingestedBody.event.retry_count).toBe(0);
    expect(ingestedBody.event.next_retry_at).toBeTruthy();

    const row = await loadEvent(ingestedBody.event.id);
    expect(row?.status).toBe("pending_replay");
    expect(row?.next_retry_at).toBe(ingestedBody.event.next_retry_at);
    const attempts = await env.DB.prepare("SELECT COUNT(*) AS n FROM replay_attempts WHERE event_id = ?")
      .bind(ingestedBody.event.id)
      .first<{ n: number }>();
    expect(attempts?.n).toBe(0);
    expect(calls).toEqual([]);
  });

  it("leaves captures failed when auto_retry is off", async () => {
    const created = await createEndpoint({
      name: "Manual only",
      target_url: "https://example.com/hooks/manual-only",
      retry_max_attempts: 2,
      retry_base_delay_seconds: 15,
    });
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };
    const ingested = await ingest(createdBody.endpoint.endpoint_key);
    const ingestedBody = (await ingested.json()) as { event: PublicEvent };
    expect(ingestedBody.event.status).toBe("failed");
    expect(ingestedBody.event.next_retry_at).toBeNull();
  });

  it("queues a failed relay and reports pending_replay to the provider", async () => {
    globalThis.fetch = async () => new Response("bad gateway", { status: 502 });
    const created = await createEndpoint({
      name: "Auto relay",
      target_url: "https://example.com/webhooks/stripe",
      auto_retry: true,
    });
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };

    const response = await app.request(
      `/v1/relay/${createdBody.endpoint.endpoint_key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"id":"evt_auto_relay"}',
      },
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { captured: boolean; event: { id: string; status: string } };
    expect(body.captured).toBe(true);
    expect(body.event.status).toBe("pending_replay");

    const row = await loadEvent(body.event.id);
    expect(row?.status).toBe("pending_replay");
    expect(row?.retry_count).toBe(0);
    expect(row?.next_retry_at).toBeTruthy();
    const attempts = await env.DB.prepare("SELECT COUNT(*) AS n FROM replay_attempts WHERE event_id = ?")
      .bind(body.event.id)
      .first<{ n: number }>();
    expect(attempts?.n).toBe(0);
  });

  it("sends pending_replay on the ingest alert when the capture is auto-queued", async () => {
    const calls: string[] = [];
    globalThis.fetch = async (_input, init) => {
      calls.push(typeof init?.body === "string" ? init.body : "");
      return new Response("ok", { status: 204 });
    };

    const created = await createEndpoint({
      name: "Auto alert",
      target_url: "https://example.com/hooks/auto-alert",
      alert_url: "https://alerts.example/hooks/requeue",
      auto_retry: true,
    });
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`http://localhost/v1/ingest/${createdBody.endpoint.endpoint_key}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: { id: "alert-me" }, reason: "boom", source: "worker" }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(201);
    expect(calls).toHaveLength(1);
    const alert = JSON.parse(calls[0] ?? "") as { type: string; event: { status: string } };
    expect(alert.type).toBe("event.ingested");
    expect(alert.event.status).toBe("pending_replay");
  });

  it("backs off with the endpoint base delay and stops at its attempt budget", async () => {
    await isolateOutbox();
    failTarget();
    const created = await createEndpoint({
      name: "Backoff target",
      target_url: "https://example.com/hooks/backoff",
      auto_retry: true,
      retry_max_attempts: 3,
      retry_base_delay_seconds: 120,
    });
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };
    const ingested = await ingest(createdBody.endpoint.endpoint_key);
    const eventId = ((await ingested.json()) as { event: PublicEvent }).event.id;

    const first = await processPendingReplays(env.DB);
    expect(first).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const afterFirst = await loadEvent(eventId);
    expect(afterFirst?.status).toBe("pending_replay");
    expect(afterFirst?.retry_count).toBe(1);
    expect(Date.parse(afterFirst?.next_retry_at ?? "") - Date.parse(afterFirst?.updated_at ?? "")).toBe(
      120_000,
    );

    const skipped = await processPendingReplays(env.DB);
    expect(skipped.processed).toBe(0);

    await env.DB.prepare("UPDATE events SET retry_count = ?, next_retry_at = ? WHERE id = ?")
      .bind(2, new Date(Date.now() - 1000).toISOString(), eventId)
      .run();
    const last = await processPendingReplays(env.DB);
    expect(last).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const terminal = await loadEvent(eventId);
    expect(terminal?.status).toBe("replay_failed");
    expect(terminal?.retry_count).toBe(3);
    expect(terminal?.next_retry_at).toBeNull();
  });

  it("uses the endpoint budget for a manual enqueue when auto_retry is off", async () => {
    await isolateOutbox();
    failTarget();
    const created = await createEndpoint({
      name: "Enqueue budget",
      target_url: "https://example.com/hooks/enqueue-budget",
      auto_retry: false,
      retry_base_delay_seconds: 180,
    });
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };
    const ingested = await ingest(createdBody.endpoint.endpoint_key);
    const eventId = ((await ingested.json()) as { event: PublicEvent }).event.id;

    const queued = await app.request(
      `/v1/events/${eventId}/replay`,
      {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ enqueue: true }),
      },
      env,
    );
    expect(queued.status).toBe(200);

    const first = await processPendingReplays(env.DB);
    expect(first).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const after = await loadEvent(eventId);
    expect(after?.status).toBe("pending_replay");
    expect(Date.parse(after?.next_retry_at ?? "") - Date.parse(after?.updated_at ?? "")).toBe(180_000);
  });

  it("stops after a single delivery when retry_max_attempts is 1", async () => {
    await isolateOutbox();
    failTarget();
    const created = await createEndpoint({
      name: "One shot auto",
      target_url: "https://example.com/hooks/one-shot-auto",
      auto_retry: true,
      retry_max_attempts: 1,
      retry_base_delay_seconds: 30,
    });
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };
    const ingested = await ingest(createdBody.endpoint.endpoint_key);
    const eventId = ((await ingested.json()) as { event: PublicEvent }).event.id;

    const only = await processPendingReplays(env.DB);
    expect(only).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const terminal = await loadEvent(eventId);
    expect(terminal?.status).toBe("replay_failed");
    expect(terminal?.retry_count).toBe(1);
    expect(terminal?.next_retry_at).toBeNull();
  });

  it("marks a successful cron delivery replayed and clears the schedule", async () => {
    await isolateOutbox();
    globalThis.fetch = async () => new Response("ok", { status: 200 });
    const created = await createEndpoint({
      name: "Auto success",
      target_url: "https://example.com/hooks/auto-success",
      auto_retry: true,
    });
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };
    const ingested = await ingest(createdBody.endpoint.endpoint_key);
    const eventId = ((await ingested.json()) as { event: PublicEvent }).event.id;

    const done = await processPendingReplays(env.DB);
    expect(done).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const row = await loadEvent(eventId);
    expect(row?.status).toBe("replayed");
    expect(row?.retry_count).toBe(0);
    expect(row?.next_retry_at).toBeNull();
  });

  it("does not reschedule a synchronous replay of an auto-queued event", async () => {
    await isolateOutbox();
    failTarget();
    const created = await createEndpoint({
      name: "Sync after auto",
      target_url: "https://example.com/hooks/sync-after-auto",
      auto_retry: true,
    });
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };
    const ingested = await ingest(createdBody.endpoint.endpoint_key);
    const eventId = ((await ingested.json()) as { event: PublicEvent }).event.id;

    const replayed = await app.request(
      `/v1/events/${eventId}/replay`,
      { method: "POST", headers: AUTH },
      env,
    );
    expect(replayed.status).toBe(200);
    const row = await loadEvent(eventId);
    expect(row?.status).toBe("replay_failed");
    expect(row?.next_retry_at).toBeNull();
    expect((await processPendingReplays(env.DB)).processed).toBe(0);
  });

  it("keeps an in-flight outbox row when auto_retry is turned off", async () => {
    await isolateOutbox();
    failTarget();
    const created = await createEndpoint({
      name: "Disable later",
      target_url: "https://example.com/hooks/disable-later",
      auto_retry: true,
      retry_base_delay_seconds: 90,
    });
    const createdBody = (await created.json()) as { endpoint: PublicEndpoint };
    const firstIngest = await ingest(createdBody.endpoint.endpoint_key, { id: "already-queued" });
    const queuedId = ((await firstIngest.json()) as { event: PublicEvent }).event.id;

    const patched = await patchEndpoint(createdBody.endpoint.id, { auto_retry: false });
    expect(patched.status).toBe(200);

    const second = await ingest(createdBody.endpoint.endpoint_key, { id: "after-off" });
    const secondBody = (await second.json()) as { event: PublicEvent };
    expect(secondBody.event.status).toBe("failed");
    expect(secondBody.event.next_retry_at).toBeNull();

    const drained = await processPendingReplays(env.DB);
    expect(drained).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const queued = await loadEvent(queuedId);
    expect(queued?.status).toBe("pending_replay");
    expect(queued?.retry_count).toBe(1);
    expect(Date.parse(queued?.next_retry_at ?? "") - Date.parse(queued?.updated_at ?? "")).toBe(90_000);
  });
});
