# Replay retries (D1 outbox)

Requeue does **not** use Cloudflare Queues. Automatic retries are the same D1 outbox + cron path as `{ "enqueue": true }`.

Captured failures stay `failed` until someone replays them, unless the endpoint sets `auto_retry: true`. That opt-in uses this same outbox.

## Automatic retry of a captured failure

Off by default. `POST /v1/endpoints` and `PATCH /v1/endpoints/:id` accept:

| Field | Default | Range | Effect |
| --- | --- | --- | --- |
| `auto_retry` | `false` | boolean | When `true`, ingest and a failed relay store `pending_replay` with `next_retry_at = now`. When `false`, captures stay `failed`. |
| `retry_max_attempts` | `6` | 1–20 | Outbox delivery budget for this endpoint, including the first cron POST. The failure that hits the budget becomes `replay_failed`. |
| `retry_base_delay_seconds` | `60` | 1–86400 | Wait after the first failed outbox delivery. Later waits are `base * 2^(n-1)`, capped at 86400 seconds. |

`POST /v1/ingest/:endpointKey` and a failed `POST /v1/relay/:endpointKey` do not POST `target_url` themselves. The once-a-minute cron does. A 2xx relay is still not stored.

The two numbers are the budget for **every** queued delivery to that endpoint, including `{ "enqueue": true }` and bulk enqueue. Defaults match the historical global schedule below. A synchronous replay stays one-shot.

Turning `auto_retry` off stops new captures from joining the outbox. Rows already `pending_replay` keep going until they succeed, exhaust the budget, are resolved, or the endpoint is deleted. `PATCH` of the two numbers applies on the next failed delivery. It does not reset `retry_count`.

`alert_url` still fires once when the row is stored. `event.status` in that POST is `pending_replay` when auto-retry queued the row, and `failed` otherwise.

Cron runs once a minute, so a base delay under 60 seconds becomes due on the next tick after `next_retry_at`.

Invalid `auto_retry` (not a boolean) or an out-of-range attempt count or delay is `400` with `error.code: "invalid_body"`. Nothing is written.

## How a replay gets onto the outbox

- An endpoint with `auto_retry` on writes the same outbox columns when ingest or a failed relay stores the event (`retry_count = 0`, `next_retry_at = now`, no delivery override).
- `POST /v1/events/:id/replay` with `{ "enqueue": true }` sets `status = pending_replay`, `retry_count = 0`, and `next_retry_at = now`. Optional `payload` / `headers` on that request are stored on `events.delivery_payload` / `events.delivery_headers` so later cron attempts deliver the override. The ingest corpse (`events.payload`) is not rewritten.
- `POST /v1/events/bulk-replay` takes `{ "ids": ["evt_…"] }` (1–50) and uses the same outbox write. `enqueue` defaults to `true`. It does not accept `payload` / `headers`; a queued bulk replay clears `delivery_payload` / `delivery_headers` so cron delivers the stored corpse. `"enqueue": false` delivers one id at a time and is one-shot, like a synchronous single replay.
- `wrangler.toml` runs `* * * * *`. Each tick calls `processPendingReplays` ([`src/outbox.ts`](../src/outbox.ts)).
- `POST /v1/internal/process-outbox` (Bearer) drains the same queue for ops/tests.

Eligible rows: `status = pending_replay` and (`next_retry_at` is null or `<= now`).

## Backoff

Each failed **outbox** delivery increments `retry_count` and keeps the event `pending_replay` until that endpoint's budget is exhausted.

Delay after failure `n` (1-based) is `retry_base_delay_seconds * 2^(n-1)`, capped at 86400 seconds. When `retry_count` reaches `retry_max_attempts`, the row becomes `replay_failed` and `next_retry_at` is cleared. Events still inside a backoff window are skipped by cron. The budget is read from the endpoint at delivery time.

Default policy (`retry_max_attempts = 6`, `retry_base_delay_seconds = 60`):

| Failed outbox attempts | Next retry |
| --- | --- |
| 1 | 1 minute |
| 2 | 2 minutes |
| 3 | 4 minutes |
| 4 | 8 minutes |
| 5 | 16 minutes |
| 6 | stop — `replay_failed`, `next_retry_at` cleared |

Six outbox attempts total (first try + five retries). Example with `retry_max_attempts = 3` and `retry_base_delay_seconds = 30`: fail, wait 30s, fail, wait 60s, fail, stop.

A successful outbox (or manual) delivery sets `status = replayed` and clears `next_retry_at`.

Soft-deleting an endpoint (`DELETE /v1/endpoints/:id`) marks that destination's `pending_replay` events `replay_failed` and clears `next_retry_at`, so cron does not keep POSTing to a retired URL.

`POST /v1/events/:id/resolve` and `POST /v1/events/bulk-resolve` set `status = resolved` and clear `next_retry_at` plus `delivery_payload` / `delivery_headers`. That row is no longer eligible. If cron already selected it, the outbox re-reads status and skips the POST. `retry_count` is kept. Contract: [README — Resolve](../README.md#resolve).

## What is not retried automatically

Ingest and a failed relay stay `failed` with no `next_retry_at` when `auto_retry` is off.

Synchronous `POST /v1/events/:id/replay` (no `enqueue`) is one-shot, including a row that auto-retry had already queued. A failure becomes `replay_failed` with no `next_retry_at`. Re-queue it with `{ "enqueue": true }` (resets `retry_count`) or call replay again. The same one-shot rule applies to each id in `POST /v1/events/bulk-replay` when `enqueue` is `false`.

## Free-tier notes

Backoff lives on `events.retry_count` / `events.next_retry_at` ([`migrations/0003_ingest_limits_and_replay_backoff.sql`](../migrations/0003_ingest_limits_and_replay_backoff.sql)). Per-endpoint `auto_retry`, `retry_max_attempts`, and `retry_base_delay_seconds` live on `endpoints` ([`migrations/0009_endpoint_auto_retry.sql`](../migrations/0009_endpoint_auto_retry.sql)). Delivery overrides live on `events.delivery_payload` / `events.delivery_headers` ([`migrations/0006_replay_delivery_override.sql`](../migrations/0006_replay_delivery_override.sql)). Dismissals use status `resolved` and optional `events.resolve_note` ([`migrations/0007_event_resolved.sql`](../migrations/0007_event_resolved.sql)). No KV, Queues, or Durable Objects.
