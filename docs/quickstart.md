# 5-minute hosted quickstart

Indie path: prove the Worker is up, get a key, ingest a failure, replay it from the dashboard. No local Wrangler, no Cloudflare account.

## 1. Health check

```bash
curl -sS https://api.getrequeue.com/health
# {"ok":true,"service":"requeue","version":"0.1.0"}
```

## 2. Request a key

Hosted production has no public demo tenant. Join the [waitlist](https://getrequeue.com) (`POST /v1/waitlist`) or email [maya@getrequeue.com](mailto:maya@getrequeue.com). Maya will mint a management key.

Do **not** send the local seed key (`rq_demo_local_dev_only_do_not_use_in_prod`) to hosted — it is not a production credential.

```bash
export REQUEUE_API=https://api.getrequeue.com
export REQUEUE_KEY=rq_PASTE_YOUR_KEY
```

## 3. Create an endpoint

This is the replay destination. Note `id` (`ep_…`) and `endpoint_key` (`epk_…`) from the response.

```bash
curl -sS "$REQUEUE_API/v1/endpoints" \
  -H "Authorization: Bearer $REQUEUE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Orders worker",
    "target_url": "https://httpbin.org/post",
    "alert_url": "https://example.com/hooks/requeue-alerts"
  }'
```

`alert_url` is optional. When it is an absolute `https://` URL, each stored failure also POSTs a small `event.ingested` notification there (no payload, no retry). `http://` and relative URLs are rejected. `PATCH` with `null` or `""` clears it.

`auto_retry` defaults to false. Set it to `true` to put each captured failure on the D1 outbox immediately (`pending_replay`) so the once-a-minute cron replays it. Optional `retry_max_attempts` (default 6, max 20) and `retry_base_delay_seconds` (default 60) set that endpoint's backoff. The same numbers apply when you enqueue a replay yourself. See [retries.md](retries.md).

## 4. Ingest a failure

Ingest uses the endpoint key in the URL, not the Bearer token.

```bash
curl -sS "$REQUEUE_API/v1/ingest/epk_REPLACE_ME" \
  -H "Content-Type: application/json" \
  -d '{
    "payload": { "order_id": "ord_123", "amount": 4200 },
    "reason": "fulfillment timeout",
    "source": "worker"
  }'
```

## Relay a Stripe (or Clerk) webhook

Ingest is for workers you control. Stripe and Clerk will not POST their failures to it. Point the provider's webhook URL at relay instead. `target_url` stays your app.

```bash
curl -sS "$REQUEUE_API/v1/endpoints" \
  -H "Authorization: Bearer $REQUEUE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Stripe",
    "target_url": "https://yourapp.com/webhooks/stripe",
    "secret": "optional-requeue-replay-secret",
    "alert_url": "https://yourapp.com/hooks/requeue-alerts"
  }'
```

In the Stripe Dashboard, set the endpoint URL to:

```text
https://api.getrequeue.com/v1/relay/epk_REPLACE_ME
```

Use the `endpoint_key` from the create response (`relay_path` is the same path). Clerk and other Svix senders use that same URL.

Requeue forwards the raw body and the provider signature headers (`Stripe-Signature`, or `svix-id` / `svix-timestamp` / `svix-signature`) to `target_url`. When your app returns 2xx, Stripe sees that status and body, and Requeue does not store the event. When your app errors, times out (10s), or cannot be reached, Requeue stores the raw payload (`source: "relay"`, status `failed`, or `pending_replay` when `auto_retry` is on) and answers **200** so Stripe stops retrying. Replay it from the inbox, or let cron retry it when auto-retry is on. `alert_url` fires on that capture.

Provider signatures expire. Stripe's default tolerance is 5 minutes, so a replay later than that can fail your app's `Stripe-Signature` check. For that delivery, pass a `headers` override on `POST /v1/events/:id/replay`, or verify `X-Requeue-Signature` with the endpoint `secret` (replay adds it; the live forward does not). Contract: [README — Relay](../README.md#relay).

## 5. Replay from the dashboard

Open [getrequeue.com/app](https://getrequeue.com/app). Paste `https://api.getrequeue.com` as the API base URL and **your** key. Find the event and replay.

Or replay with curl (same Bearer key):

```bash
curl -sS "$REQUEUE_API/v1/events?status=failed" \
  -H "Authorization: Bearer $REQUEUE_KEY"

curl -sS -X POST "$REQUEUE_API/v1/events/evt_REPLACE_ME/replay" \
  -H "Authorization: Bearer $REQUEUE_KEY"
```

Replay POSTs the **stored payload** to `target_url`. That immediate POST is one-shot. To put the event on the D1 outbox (cron retries with backoff), pass `{"enqueue": true}`:

```bash
curl -sS -X POST "$REQUEUE_API/v1/events/evt_REPLACE_ME/replay" \
  -H "Authorization: Bearer $REQUEUE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enqueue": true}'
```

The event becomes `pending_replay`. Backoff uses the endpoint's `retry_max_attempts` and `retry_base_delay_seconds` (default 6 attempts, 60s base). Table: [retries.md](retries.md).

## Bulk replay

Redeliver many failures in one call after an outage. `enqueue` defaults to `true` (D1 outbox, not a long synchronous Worker run). Cap is 50 ids. Missing ids are per-item errors; the rest still queue. This route does not accept `payload` or `headers` — edit one event with the single-event replay below.

```bash
curl -sS -X POST "$REQUEUE_API/v1/events/bulk-replay" \
  -H "Authorization: Bearer $REQUEUE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ids":["evt_ONE","evt_TWO"]}'
```

Response: `results` (one entry per id, same order), plus `ok_count` and `error_count`. A success entry is `{ "id", "ok": true, "event", "attempt", "queued" }` (`attempt` is `null` when queued). A failure entry is `{ "id", "ok": false, "error": { "code", "message" } }`. Pass `"enqueue": false` to POST each id immediately. Contract: [README — Bulk replay](../README.md#bulk-replay).

## Resolve

Dismiss a failure without replaying it (you already fixed it upstream). Status becomes `resolved`. A queued event is taken off the outbox (`next_retry_at` and any delivery override are cleared) so cron does not POST it. Optional `note` is stored on the event (500 characters max).

```bash
curl -sS -X POST "$REQUEUE_API/v1/events/evt_REPLACE_ME/resolve" \
  -H "Authorization: Bearer $REQUEUE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"note":"fixed in the orders worker"}'
```

Already `resolved` returns `200` with the same event. List dismissed rows with `GET /v1/events?status=resolved`.

Dismiss many at once (1–50 ids, same empty / over-cap errors as bulk replay). Missing ids are per-item errors; the rest still resolve. No `note` on this route.

```bash
curl -sS -X POST "$REQUEUE_API/v1/events/bulk-resolve" \
  -H "Authorization: Bearer $REQUEUE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ids":["evt_ONE","evt_TWO"]}'
```

Contract: [README — Resolve](../README.md#resolve).

## Edit before replay

Fix a typo or stale field for **this delivery only**. The inbox row stays the original corpse — `GET /v1/events/:id` still shows what was ingested.

```bash
curl -sS -X POST "$REQUEUE_API/v1/events/evt_REPLACE_ME/replay" \
  -H "Authorization: Bearer $REQUEUE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "payload": { "order_id": "ord_123", "amount": 4200 },
    "headers": { "x-request-id": "req_fixed" }
  }'
```

Omit `payload` to keep the stored body. Omit `headers` to keep the stored ingest headers. `{ "enqueue": true, "payload": { ... } }` stores the override on the outbox row so cron retries deliver the edit; HMAC signs the body that is actually POSTed. Contract: [README — Edit before replay](../README.md#edit-before-replay).

## Filter the inbox

`GET /v1/events` accepts `?status=` (`failed`, `pending_replay`, `replayed`, `replay_failed`, `resolved`) and `?endpoint_id=` (an `ep_…` id). Combine them to inspect one destination. Optional `q` is a case-insensitive substring over event id, reason, source, and payload text (blank `q` is ignored).

```bash
curl -sS "$REQUEUE_API/v1/events?status=failed&endpoint_id=ep_REPLACE_ME&q=ord_123" \
  -H "Authorization: Bearer $REQUEUE_KEY"
```

Optional `?limit=` (1–200, default 50).

## Update or retire an endpoint

Same Bearer key as create. List and get omit the raw HMAC `secret` (`has_secret` only).

```bash
curl -sS "$REQUEUE_API/v1/endpoints" \
  -H "Authorization: Bearer $REQUEUE_KEY"

curl -sS "$REQUEUE_API/v1/endpoints/ep_REPLACE_ME" \
  -H "Authorization: Bearer $REQUEUE_KEY"

curl -sS -X PATCH "$REQUEUE_API/v1/endpoints/ep_REPLACE_ME" \
  -H "Authorization: Bearer $REQUEUE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Orders worker v2","target_url":"https://httpbin.org/post"}'

curl -sS -X DELETE "$REQUEUE_API/v1/endpoints/ep_REPLACE_ME" \
  -H "Authorization: Bearer $REQUEUE_KEY"
```

`PATCH` is partial: omitted fields stay as-is. You can also set `secret` (or `""` / `null` to clear it), `alert_url` (or `""` / `null` to clear it), and the retry policy (`auto_retry`, `retry_max_attempts`, `retry_base_delay_seconds`). `endpoint_key` / ingest path do **not** rotate — existing workers keep posting to the same URL.

`DELETE` is a soft-delete (`deleted_at`). Historical events stay. List/get hide the row. Ingest and relay for that key return `410` with `error.code: "endpoint_gone"`. Pending outbox replays for the destination become `replay_failed`.

## Next

- FAQ: [faq.md](faq.md)
- Outbox retries: [retries.md](retries.md)
- Local Wrangler: [README Quickstart](../README.md#quickstart)
- Hosted stack: [hosted.md](hosted.md)
- Keys and bootstrap: [api-keys.md](api-keys.md)
- JS SDK: [requeue-sdk-js](https://github.com/requeue-hq/requeue-sdk-js)
