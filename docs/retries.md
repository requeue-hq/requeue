# Replay retries (D1 outbox)

Requeue does **not** use Cloudflare Queues. Automatic retries are the same D1 outbox + cron path as `{ "enqueue": true }`.

## How a replay gets onto the outbox

- `POST /v1/events/:id/replay` with `{ "enqueue": true }` sets `status = pending_replay`, `retry_count = 0`, and `next_retry_at = now`.
- `wrangler.toml` runs `* * * * *`. Each tick calls `processPendingReplays` ([`src/outbox.ts`](../src/outbox.ts)).
- `POST /v1/internal/process-outbox` (Bearer) drains the same queue for ops/tests.

Eligible rows: `status = pending_replay` and (`next_retry_at` is null or `<= now`).

## Backoff

Each failed **outbox** delivery increments `retry_count` and keeps the event `pending_replay` until the budget is exhausted.

| Failed outbox attempts | Next retry |
| --- | --- |
| 1 | 1 minute |
| 2 | 2 minutes |
| 3 | 4 minutes |
| 4 | 8 minutes |
| 5 | 16 minutes |
| 6 | stop — `replay_failed`, `next_retry_at` cleared |

Six outbox attempts total (first try + five retries). Events still inside a backoff window are skipped by cron.

A successful outbox (or manual) delivery sets `status = replayed` and clears `next_retry_at`.

Soft-deleting an endpoint (`DELETE /v1/endpoints/:id`) marks that destination's `pending_replay` events `replay_failed` and clears `next_retry_at`, so cron does not keep POSTing to a retired URL.

## What is not retried automatically

Synchronous `POST /v1/events/:id/replay` (no `enqueue`) is one-shot. A failure becomes `replay_failed` with no `next_retry_at`. Re-queue it with `{ "enqueue": true }` (resets `retry_count`) or call replay again.

## Free-tier notes

Backoff lives on `events.retry_count` / `events.next_retry_at` ([`migrations/0003_ingest_limits_and_replay_backoff.sql`](../migrations/0003_ingest_limits_and_replay_backoff.sql)). No KV, Queues, or Durable Objects.
