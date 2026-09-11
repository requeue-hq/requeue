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
    "target_url": "https://httpbin.org/post"
  }'
```

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

## 5. Replay from the dashboard

Open [getrequeue.com/app](https://getrequeue.com/app). Paste `https://api.getrequeue.com` as the API base URL and **your** key. Find the event and replay.

Or replay with curl (same Bearer key):

```bash
curl -sS "$REQUEUE_API/v1/events?status=failed" \
  -H "Authorization: Bearer $REQUEUE_KEY"

curl -sS -X POST "$REQUEUE_API/v1/events/evt_REPLACE_ME/replay" \
  -H "Authorization: Bearer $REQUEUE_KEY"
```

Replay POSTs the **original stored payload** to `target_url`. That immediate POST is one-shot. To put the event on the D1 outbox (cron retries with backoff), pass `{"enqueue": true}`:

```bash
curl -sS -X POST "$REQUEUE_API/v1/events/evt_REPLACE_ME/replay" \
  -H "Authorization: Bearer $REQUEUE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enqueue": true}'
```

The event becomes `pending_replay`. Backoff table: [retries.md](retries.md).

## Filter the inbox

`GET /v1/events` accepts `?status=` (`failed`, `pending_replay`, `replayed`, `replay_failed`) and `?endpoint_id=` (an `ep_…` id). Combine them to inspect one destination:

```bash
curl -sS "$REQUEUE_API/v1/events?status=failed&endpoint_id=ep_REPLACE_ME" \
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

`PATCH` is partial: omitted fields stay as-is. You can also set `secret` (or `""` / `null` to clear it). `endpoint_key` / ingest path do **not** rotate — existing workers keep posting to the same URL.

`DELETE` is a soft-delete (`deleted_at`). Historical events stay. List/get hide the row. Ingest for that key returns `410` with `error.code: "endpoint_gone"`. Pending outbox replays for the destination become `replay_failed`.

## Next

- FAQ: [faq.md](faq.md)
- Outbox retries: [retries.md](retries.md)
- Local Wrangler: [README Quickstart](../README.md#quickstart)
- Hosted stack: [hosted.md](hosted.md)
- Keys and bootstrap: [api-keys.md](api-keys.md)
- JS SDK: [requeue-sdk-js](https://github.com/requeue-hq/requeue-sdk-js)
