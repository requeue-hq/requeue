# Demo transcript

Local Wrangler (`npm run dev`) and the **local-only** seed key. [`demo.cast`](demo.cast) is an asciinema v2 recording of this session (~25s), scripted from a real local run (same routes, ids, and bodies). Replay with:

```bash
asciinema play docs/assets/demo.cast
```

Do not send this key to `https://api.getrequeue.com`.

```console
$ export RQ=http://127.0.0.1:8787
$ export KEY=rq_demo_local_dev_only_do_not_use_in_prod

$ curl -sS $RQ/health
{"ok":true,"service":"requeue","version":"0.1.0"}

$ curl -sS $RQ/v1/endpoints -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -d '{"name":"Orders worker","target_url":"https://httpbin.org/post"}'
{
  "endpoint": {
    "id": "ep_24bacd84940613f6bff923b6a4bf35e5",
    "project_id": "prj_demo",
    "name": "Orders worker",
    "endpoint_key": "epk_9ae71dd2735f27d0dee49fce6505e256a251",
    "target_url": "https://httpbin.org/post",
    "ingest_path": "/v1/ingest/epk_9ae71dd2735f27d0dee49fce6505e256a251",
    "has_secret": false,
    "created_at": "2026-09-18T16:26:18.635Z"
  }
}

$ export EPK=epk_9ae71dd2735f27d0dee49fce6505e256a251
$ export EP=ep_24bacd84940613f6bff923b6a4bf35e5

$ curl -sS $RQ/v1/ingest/$EPK -H "Content-Type: application/json" \
    -d '{"payload":{"order_id":"ord_123","amount":4200},"reason":"fulfillment timeout","source":"worker"}'
{
  "event": {
    "id": "evt_e9faabfc18523fe5a56f59a91a077901",
    "endpoint_id": "ep_24bacd84940613f6bff923b6a4bf35e5",
    "status": "failed",
    "payload": {
      "order_id": "ord_123",
      "amount": 4200
    },
    "content_type": "application/json",
    "headers": null,
    "reason": "fulfillment timeout",
    "source": "worker",
    "created_at": "2026-09-18T16:26:18.722Z",
    "updated_at": "2026-09-18T16:26:18.722Z",
    "retry_count": 0,
    "next_retry_at": null
  }
}

$ export EVT=evt_e9faabfc18523fe5a56f59a91a077901

$ curl -sS "$RQ/v1/events?status=failed&endpoint_id=$EP" \
    -H "Authorization: Bearer $KEY"
{
  "events": [
    {
      "id": "evt_e9faabfc18523fe5a56f59a91a077901",
      "endpoint_id": "ep_24bacd84940613f6bff923b6a4bf35e5",
      "status": "failed",
      "payload": {
        "order_id": "ord_123",
        "amount": 4200
      },
      "content_type": "application/json",
      "headers": null,
      "reason": "fulfillment timeout",
      "source": "worker",
      "created_at": "2026-09-18T16:26:18.722Z",
      "updated_at": "2026-09-18T16:26:18.722Z",
      "retry_count": 0,
      "next_retry_at": null
    }
  ],
  "count": 1
}

$ curl -sS -X POST $RQ/v1/events/$EVT/replay \
    -H "Authorization: Bearer $KEY" \
    | jq '{status: .event.status, success: .attempt.success, status_code: .attempt.status_code, queued}'
{
  "status": "replayed",
  "success": true,
  "status_code": 200,
  "queued": false
}
```

Replay POSTs the stored payload to `https://httpbin.org/post`. The raw `attempt.response_body` is the httpbin echo (headers + `{"order_id":"ord_123","amount":4200}`); `jq` keeps the recording readable.

Captured against local Wrangler on 2026-09-18. IDs are from that run — yours will differ.
