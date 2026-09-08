# 5-minute hosted quickstart

Indie path: prove the Worker is up, get a key, ingest a failure, replay it from the dashboard. No local Wrangler, no Cloudflare account.

## 1. Health check

```bash
curl -sS https://api.getrequeue.com/health
# {"ok":true,"service":"requeue","version":"0.1.0"}
```

## 2. Request a key

Hosted production has no public demo tenant. Join the [waitlist](https://getrequeue.com) or email [maya@getrequeue.com](mailto:maya@getrequeue.com). Maya will mint a management key.

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

Replay POSTs the **original stored payload** to `target_url`.

## Next

- Local Wrangler: [README Quickstart](../README.md#quickstart)
- Hosted stack: [hosted.md](hosted.md)
- Keys and bootstrap: [api-keys.md](api-keys.md)
- JS SDK: [requeue-sdk-js](https://github.com/requeue-hq/requeue-sdk-js)
