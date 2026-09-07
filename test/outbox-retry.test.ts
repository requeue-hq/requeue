import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { app } from "../src/app";
import { MAX_OUTBOX_ATTEMPTS, nextReplayRetryAt, processPendingReplays } from "../src/outbox";

const DEMO_KEY = "rq_demo_local_dev_only_do_not_use_in_prod";
const AUTH = { Authorization: `Bearer ${DEMO_KEY}` };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function failTarget() {
  globalThis.fetch = async () => new Response("upstream down", { status: 503 });
}

async function isolateOutbox() {
  await env.DB.prepare(
    "UPDATE events SET status = 'failed', next_retry_at = NULL WHERE status = 'pending_replay'",
  ).run();
}

async function enqueueFailedEvent() {
  const created = await app.request(
    "/v1/endpoints",
    {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Retry target",
        target_url: "https://example.com/hooks/retry",
      }),
    },
    env,
  );
  const createdBody = (await created.json()) as { endpoint: { endpoint_key: string } };

  const ingested = await app.request(
    `/v1/ingest/${createdBody.endpoint.endpoint_key}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { id: "retry-me" }, reason: "boom" }),
    },
    env,
  );
  const ingestedBody = (await ingested.json()) as { event: { id: string } };

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
  return ingestedBody.event.id;
}

async function loadEvent(eventId: string) {
  return env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(eventId).first<{
    status: string;
    retry_count: number;
    next_retry_at: string | null;
  }>();
}

describe("outbox replay backoff", () => {
  it("computes exponential delays and stops after the attempt budget", () => {
    const from = "2026-09-07T16:00:00.000Z";
    expect(nextReplayRetryAt(1, from)).toBe("2026-09-07T16:01:00.000Z");
    expect(nextReplayRetryAt(2, from)).toBe("2026-09-07T16:02:00.000Z");
    expect(nextReplayRetryAt(5, from)).toBe("2026-09-07T16:16:00.000Z");
    expect(nextReplayRetryAt(MAX_OUTBOX_ATTEMPTS, from)).toBeNull();
  });

  it("reschedules a failed outbox replay and skips events still in backoff", async () => {
    await isolateOutbox();
    failTarget();
    const eventId = await enqueueFailedEvent();

    const first = await processPendingReplays(env.DB);
    expect(first).toEqual({ processed: 1, succeeded: 0, failed: 1 });

    const afterFail = await loadEvent(eventId);
    expect(afterFail?.status).toBe("pending_replay");
    expect(afterFail?.retry_count).toBe(1);
    expect(afterFail?.next_retry_at).toBeTruthy();
    expect(Date.parse(afterFail?.next_retry_at ?? "")).toBeGreaterThan(Date.now());

    const skipped = await processPendingReplays(env.DB);
    expect(skipped.processed).toBe(0);
    expect((await loadEvent(eventId))?.retry_count).toBe(1);

    await env.DB.prepare("UPDATE events SET next_retry_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), eventId)
      .run();

    const retried = await processPendingReplays(env.DB);
    expect(retried).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const afterRetry = await loadEvent(eventId);
    expect(afterRetry?.status).toBe("pending_replay");
    expect(afterRetry?.retry_count).toBe(2);
  });

  it("marks the event replay_failed after the last automatic attempt", async () => {
    await isolateOutbox();
    failTarget();
    const eventId = await enqueueFailedEvent();
    await env.DB.prepare("UPDATE events SET retry_count = ?, next_retry_at = ? WHERE id = ?")
      .bind(MAX_OUTBOX_ATTEMPTS - 1, new Date(Date.now() - 1000).toISOString(), eventId)
      .run();

    const last = await processPendingReplays(env.DB);
    expect(last).toEqual({ processed: 1, succeeded: 0, failed: 1 });

    const terminal = await loadEvent(eventId);
    expect(terminal?.status).toBe("replay_failed");
    expect(terminal?.retry_count).toBe(MAX_OUTBOX_ATTEMPTS);
    expect(terminal?.next_retry_at).toBeNull();

    expect((await processPendingReplays(env.DB)).processed).toBe(0);
    expect((await loadEvent(eventId))?.status).toBe("replay_failed");
  });

  it("does not auto-reschedule a synchronous manual replay failure", async () => {
    failTarget();
    const created = await app.request(
      "/v1/endpoints",
      {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Manual target",
          target_url: "https://example.com/hooks/manual",
        }),
      },
      env,
    );
    const createdBody = (await created.json()) as { endpoint: { endpoint_key: string } };
    const ingested = await app.request(
      `/v1/ingest/${createdBody.endpoint.endpoint_key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: { id: "manual" } }),
      },
      env,
    );
    const ingestedBody = (await ingested.json()) as { event: { id: string } };

    const replayed = await app.request(`/v1/events/${ingestedBody.event.id}/replay`, {
      method: "POST",
      headers: AUTH,
    }, env);
    expect(replayed.status).toBe(200);
    const replayedBody = (await replayed.json()) as { event: { status: string }; queued: boolean };
    expect(replayedBody.queued).toBe(false);
    expect(replayedBody.event.status).toBe("replay_failed");

    const row = await loadEvent(ingestedBody.event.id);
    expect(row?.status).toBe("replay_failed");
    expect(row?.next_retry_at).toBeNull();
    await isolateOutbox();
    expect((await processPendingReplays(env.DB)).processed).toBe(0);
  });
});
