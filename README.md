# Requeue

**Catch failed webhooks & jobs. Replay them.**

Stripe, Clerk, and your own workers retry a few times, then go quiet. The event that 500'd is gone by the time a customer mentions their invoice never updated. A nightly job times out; the next run overwrites the log. Queue libraries retry, then drop the payload.

Requeue is a dead-letter inbox for webhooks, crons, and background workers. When something fails, send the payload and the reason. Inspect it later. One-click replay the original request to the configured target.

Or point Stripe, Clerk, or another provider at Requeue. Requeue forwards the raw webhook to your app and keeps a copy when your app is down or returns an error.

This repository is the **MIT core API** (Cloudflare Workers + D1). Marketing, waitlist, and the dashboard live at [getrequeue.com](https://getrequeue.com) — not in this repo.

- **Product:** [getrequeue.com](https://getrequeue.com)
- **Dashboard:** [getrequeue.com/app](https://getrequeue.com/app)
- **Hosted API:** [api.getrequeue.com](https://api.getrequeue.com)
- **JS SDK:** [requeue-sdk-js](https://github.com/requeue-hq/requeue-sdk-js)

## Try hosted

The Worker is live. Health (no auth):

```bash
curl -sS https://api.getrequeue.com/health
# {"ok":true,"service":"requeue","version":"0.1.0"}
```

Open the inbox at [getrequeue.com/app](https://getrequeue.com/app). Paste `https://api.getrequeue.com` as the API base URL and **your** API key.

Hosted keys are not public. Join the [waitlist](https://getrequeue.com) (`POST /v1/waitlist`) or email [maya@getrequeue.com](mailto:maya@getrequeue.com) and Maya will mint one. Do not send the local demo key to production.

Five minutes, hosted only: [docs/quickstart.md](docs/quickstart.md). FAQ (what this is, vs Hookdeck/Svix, how to get a key): [docs/faq.md](docs/faq.md). Local ingest → list → replay: [Demo](#demo).

## Quickstart

### Local (Wrangler)

Requires Node.js 22+. A Cloudflare account is only needed when you deploy. Local mode uses Wrangler’s D1 emulator.

```bash
git clone https://github.com/requeue-hq/requeue.git
cd requeue
npm install
npm run db:migrate
npm run dev
```

Wrangler listens on `http://127.0.0.1:8787`. Health (no auth):

```bash
curl -sS http://127.0.0.1:8787/health
# {"ok":true,"service":"requeue","version":"0.1.0"}
```

Create an endpoint, ingest a failure, then replay — using the **local-only** seed key (not valid on hosted):

```bash
curl -sS http://127.0.0.1:8787/v1/endpoints \
  -H "Authorization: Bearer rq_demo_local_dev_only_do_not_use_in_prod" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Orders worker",
    "target_url": "https://httpbin.org/post",
    "secret": "optional-hmac-secret",
    "alert_url": "https://example.com/hooks/requeue-alerts"
  }'

curl -sS http://127.0.0.1:8787/v1/ingest/epk_REPLACE_ME \
  -H "Content-Type: application/json" \
  -d '{
    "payload": { "order_id": "ord_123", "amount": 4200 },
    "reason": "fulfillment timeout",
    "source": "worker"
  }'

curl -sS "http://127.0.0.1:8787/v1/events?status=failed&endpoint_id=ep_REPLACE_ME" \
  -H "Authorization: Bearer rq_demo_local_dev_only_do_not_use_in_prod"

curl -sS http://127.0.0.1:8787/v1/events/evt_REPLACE_ME \
  -H "Authorization: Bearer rq_demo_local_dev_only_do_not_use_in_prod"

curl -sS -X POST http://127.0.0.1:8787/v1/events/evt_REPLACE_ME/replay \
  -H "Authorization: Bearer rq_demo_local_dev_only_do_not_use_in_prod"

curl -sS -X POST http://127.0.0.1:8787/v1/events/bulk-replay \
  -H "Authorization: Bearer rq_demo_local_dev_only_do_not_use_in_prod" \
  -H "Content-Type: application/json" \
  -d '{"ids":["evt_REPLACE_ME","evt_REPLACE_ME_TOO"]}'
```

Bulk replay defaults to `{"enqueue": true}` (D1 outbox, up to 50 ids). Pass `"enqueue": false` to deliver each id immediately. Payload edits stay on the single-event replay route.

Note `endpoint.id` and `endpoint.endpoint_key` from the create-endpoint response, then substitute `ep_REPLACE_ME` / `epk_REPLACE_ME` / `evt_REPLACE_ME`. `secret` and `alert_url` are optional; drop `alert_url` if you do not want a notification. Optional `q` on that list call searches the event id, reason, source, and payload (case-insensitive) — `q=ord_123` matches the sample above.

The dashboard at [getrequeue.com/app](https://getrequeue.com/app) is client-only. Point it at `http://127.0.0.1:8787` and paste the local seed key to inspect and replay without curl.

### Demo

Local Wrangler (`npm run dev`) and the seed key. Health → create endpoint → ingest one failure → list → replay to httpbin (~25s).

GitHub cannot host the [asciinema](https://asciinema.org) player, so the transcript is inline. Replay the recording with `asciinema play docs/assets/demo.cast`. Same session: [docs/assets/demo.md](docs/assets/demo.md).

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
    "endpoint_key": "epk_9ae71dd2735f27d0dee49fce6505e256a251",
    "target_url": "https://httpbin.org/post",
    "ingest_path": "/v1/ingest/epk_9ae71dd2735f27d0dee49fce6505e256a251"
  }
}

$ curl -sS $RQ/v1/ingest/epk_9ae71dd2735f27d0dee49fce6505e256a251 \
    -H "Content-Type: application/json" \
    -d '{"payload":{"order_id":"ord_123","amount":4200},"reason":"fulfillment timeout","source":"worker"}'
{
  "event": {
    "id": "evt_e9faabfc18523fe5a56f59a91a077901",
    "status": "failed",
    "payload": {"order_id": "ord_123", "amount": 4200},
    "reason": "fulfillment timeout"
  }
}

$ curl -sS "$RQ/v1/events?status=failed&endpoint_id=ep_24bacd84940613f6bff923b6a4bf35e5" \
    -H "Authorization: Bearer $KEY"
{"count":1,"events":[{"id":"evt_e9faabfc18523fe5a56f59a91a077901","status":"failed"}]}

$ curl -sS -X POST $RQ/v1/events/evt_e9faabfc18523fe5a56f59a91a077901/replay \
    -H "Authorization: Bearer $KEY" \
    | jq '{status: .event.status, success: .attempt.success, status_code: .attempt.status_code, queued}'
{
  "status": "replayed",
  "success": true,
  "status_code": 200,
  "queued": false
}
```

Captured against local Wrangler. The seed key is not valid on hosted. The last `jq` keeps the httpbin echo out of the recording.

### Hosted (`https://api.getrequeue.com`)

Same routes. **Do not** send the local demo key to hosted — it is not a production credential.

If Maya minted you a key ([Try hosted](#try-hosted)), use it as `Authorization: Bearer`:

```bash
export REQUEUE_KEY=rq_PASTE_YOUR_KEY

curl -sS https://api.getrequeue.com/health
# {"ok":true,"service":"requeue","version":"0.1.0"}

curl -sS https://api.getrequeue.com/v1/endpoints \
  -H "Authorization: Bearer $REQUEUE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Orders worker",
    "target_url": "https://httpbin.org/post",
    "secret": "optional-hmac-secret",
    "alert_url": "https://example.com/hooks/requeue-alerts"
  }'
```

Inspect and replay from [getrequeue.com/app](https://getrequeue.com/app): set API base URL to `https://api.getrequeue.com` and paste **your** key. Or use the [JS SDK](https://github.com/requeue-hq/requeue-sdk-js) with `baseUrl: "https://api.getrequeue.com"`.

Self-hosting your own Worker? Mint the first key with `POST /v1/api-keys` and Worker secret `BOOTSTRAP_SECRET`. See [docs/api-keys.md](docs/api-keys.md) and [docs/hosted.md](docs/hosted.md).

Replay POSTs the **stored payload** (not the ingest envelope) to `target_url`, unless the replay request supplies a `payload` override (see [Edit before replay](#edit-before-replay)). If the endpoint has a `secret`, Requeue adds:

- `X-Requeue-Event-Id`
- `X-Requeue-Timestamp`
- `X-Requeue-Signature: sha256=<hmac>` over `{timestamp}.{eventId}.{payload}` where `payload` is the **body actually delivered**

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | `wrangler dev` |
| `npm test` | ingest, relay, and replay tests |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:migrate` | apply D1 migrations locally, then the **local-only** seed |
| `npm run db:seed:local` | re-apply the local-only demo key (never use on remote) |
| `npm run db:migrate:remote` | apply migrations to remote D1 (no demo seed) |
| `npm run deploy` | deploy the Worker |

## Status

The hosted stack is live. Model: **open-core MIT + hosted**.

| Surface | URL | Notes |
| --- | --- | --- |
| Marketing | [getrequeue.com](https://getrequeue.com) | Waitlist + product |
| Hosted API | [api.getrequeue.com](https://api.getrequeue.com) | `GET /health` → `{"ok":true,"service":"requeue","version":"0.1.0"}` |
| Dashboard | [getrequeue.com/app](https://getrequeue.com/app) | Client-only inbox. Paste API base URL + Bearer key |
| Hosted 5-min path | [docs/quickstart.md](docs/quickstart.md) | Health → waitlist key → ingest → replay |
| FAQ | [docs/faq.md](docs/faq.md) | What this is / is not, self-host vs hosted, vs Hookdeck/Svix, keys |
| JS SDK | [requeue-hq/requeue-sdk-js](https://github.com/requeue-hq/requeue-sdk-js) | `@requeue-hq/sdk` |
| This repo | [requeue-hq/requeue](https://github.com/requeue-hq/requeue) | Open-source Worker + D1 schema |

More on the live stack and keys: [docs/quickstart.md](docs/quickstart.md), [docs/faq.md](docs/faq.md), [docs/hosted.md](docs/hosted.md), [docs/api-keys.md](docs/api-keys.md).

## Why this stack

Bootstrap / free-tier only:

| Concern | Choice |
| --- | --- |
| Runtime | Cloudflare Workers + [Hono](https://hono.dev) |
| Storage | Cloudflare D1 (SQLite) |
| Retries | D1-backed outbox + cron (no Cloudflare Queues) |
| Auth | SHA-256 hashed API keys in D1 |
| Billing | Stubbed (`GET /v1/billing`) |
| License | MIT |

No paid SaaS dependencies. No paid Cloudflare features (no Queues, no Hyperdrive, no Workers Paid).

## Architecture

```mermaid
flowchart LR
  subgraph producers [Producers]
    WH[Stripe / Clerk / other webhooks]
    CR[Cron jobs]
    WK[Background workers]
  end

  subgraph worker [Requeue Worker - Hono]
    RELAY[POST /v1/relay/:endpointKey]
    IN[POST /v1/ingest/:endpointKey]
    MGMT[Management API]
    AUTH[Bearer API key]
    OUT[D1 replay outbox]
  end

  D1[(Cloudflare D1)]
  TGT[target_url]

  WH --> RELAY
  RELAY -->|raw body, 2xx| TGT
  RELAY -->|failure only| D1
  CR --> IN
  WK --> IN
  IN --> D1
  MGMT --> AUTH
  AUTH --> D1
  MGMT -->|POST /v1/events/:id/replay| OUT
  OUT -->|POST stored or override payload| TGT
  OUT --> D1
```

**Ingest and relay** are authenticated by the endpoint key in the URL (a capability token).  
**Management** (create endpoints, list events, replay) requires `Authorization: Bearer <api_key>`.

Single-event replay is synchronous by default: Requeue POSTs the stored payload (or a request `payload` override) to `target_url` and writes a `replay_attempts` row. Pass `{"enqueue": true}` to mark the event `pending_replay`; a once-a-minute cron drains that D1 outbox. `POST /v1/events/bulk-replay` uses that same path for up to 50 ids and defaults to the outbox so a batch does not hold the Worker open. Failed outbox deliveries retry with exponential backoff (still D1-backed). An endpoint can opt in so a captured failure joins that outbox immediately (`auto_retry`). Cloudflare Queues are not used. See [docs/retries.md](docs/retries.md).

## API keys

The Worker hashes the Bearer token with SHA-256 and looks it up in `api_keys` ([`src/auth.ts`](src/auth.ts)). `POST /v1/endpoints` creates an ingest endpoint (replay target), not a management key.

**Local only.** `npm run db:migrate` applies schema migrations, then [`scripts/seed-local.sql`](scripts/seed-local.sql). That seed is for Wrangler/dev and tests. It is **not** applied by `npm run db:migrate:remote` and is **not** valid on `https://api.getrequeue.com`.

```
rq_demo_local_dev_only_do_not_use_in_prod
```

**Hosted.** There is no public demo tenant. Ask Maya for a key ([Try hosted](#try-hosted)), or if you deploy your own Worker, mint one with `POST /v1/api-keys` and Worker secret `BOOTSTRAP_SECRET` (`X-Requeue-Bootstrap-Secret`). See [docs/api-keys.md](docs/api-keys.md) and the production runbook [docs/ops-maya.md](docs/ops-maya.md). Shared migration `0002_revoke_public_demo_key.sql` deletes the historical public demo hash from hosted D1 if it was ever seeded.

## HTTP API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | none | Liveness + D1 ping |
| `POST` | `/v1/waitlist` | none | Capture a marketing waitlist email (`{email, product?, source?}`) |
| `POST` | `/v1/api-keys` | bootstrap secret or Bearer | Mint a management key (bootstrap also creates a project) |
| `GET` | `/v1/api-keys` | Bearer | List keys for the current project |
| `DELETE` | `/v1/api-keys/:id` | Bearer | Revoke a key |
| `POST` | `/v1/endpoints` | Bearer | Create an endpoint (`target_url`, optional `secret`, `alert_url`, retry policy) |
| `GET` | `/v1/endpoints` | Bearer | List project endpoints (no raw `secret`; `has_secret`, `alert_url`, retry policy) |
| `GET` | `/v1/endpoints/:id` | Bearer | Fetch one project endpoint |
| `PATCH` | `/v1/endpoints/:id` | Bearer | Update `name`, `target_url`, `secret`, `alert_url`, and/or retry policy (ingest path stays put) |
| `DELETE` | `/v1/endpoints/:id` | Bearer | Soft-delete; ingest and relay return `410 endpoint_gone` |
| `POST` | `/v1/ingest/:endpointKey` | endpoint key | Store a failed event (60/min/endpoint, shared with relay; `429` when exceeded) |
| `POST` | `/v1/relay/:endpointKey` | endpoint key | Forward the raw request to `target_url`; store it only when the app does not return 2xx |
| `GET` | `/v1/events` | Bearer | List events; `?status=` + `?endpoint_id=` + `?q=` + `?limit=` |
| `GET` | `/v1/events/:id` | Bearer | Event + replay attempts |
| `POST` | `/v1/events/:id/replay` | Bearer | Deliver now, or `{ enqueue, payload?, headers? }` (override is this delivery only) |
| `POST` | `/v1/events/bulk-replay` | Bearer | Redeliver up to 50 ids (`enqueue` defaults true; no payload override) |
| `POST` | `/v1/events/:id/resolve` | Bearer | Dismiss an event (`resolved`); optional `{ "note" }`; no replay |
| `POST` | `/v1/events/bulk-resolve` | Bearer | Dismiss up to 50 ids (no replay) |
| `GET` | `/v1/billing` | Bearer | Billing stub |

See [API keys](#api-keys).

Event statuses: `failed`, `pending_replay`, `replayed`, `replay_failed`, `resolved`. Optional `endpoint_id` limits the list to one destination so you can inspect failures per endpoint. Optional `q` is a case-insensitive substring over event id, reason, source, and payload text (blank `q` is ignored) and combines with `status` and `endpoint_id`. `resolved` is a dismiss: the row stays in the inbox and is not delivered.

`GET /v1/endpoints` is project-scoped (same Bearer key as create). Responses include `endpoint_key`, `ingest_path`, `relay_path`, `has_secret`, `alert_url` (or null), `auto_retry`, `retry_max_attempts`, and `retry_base_delay_seconds`. They never include the HMAC `secret`.

`PATCH /v1/endpoints/:id` is partial. Omitted fields stay as-is. `secret: ""` or `secret: null` clears the HMAC secret (same as create treating an empty value as no secret). `alert_url: ""` or `alert_url: null` clears the notification URL the same way. `endpoint_key` / `ingest_path` / `relay_path` are not rotated. `DELETE` sets `endpoints.deleted_at` so historical events remain (`events.endpoint_id` is `ON DELETE CASCADE`). List/get omit deleted rows; ingest and relay for that key return `410` with `error.code: "endpoint_gone"`. Pending outbox replays for the destination are marked `replay_failed`. A deleted endpoint is not called, so it does not alert.

`alert_url`, when set, must be an absolute `https://` URL. `http://` and relative URLs are `400` with `error.code: "invalid_body"`. After ingest or a failed relay stores the event, Requeue schedules one background POST (`waitUntil`, a few seconds, no retry) to that URL:

```json
{
  "type": "event.ingested",
  "event": {
    "id": "evt_…",
    "endpoint_id": "ep_…",
    "status": "failed",
    "reason": "fulfillment timeout",
    "source": "worker",
    "created_at": "2026-09-29T00:00:00.000Z"
  }
}
```

The alert does not include the payload or headers (`GET /v1/events/:id` does). Network errors and non-2xx responses are ignored. Ingest still returns the stored event. A captured relay returns 200 with `{ "captured": true, "event": { "id", "status", "reason" } }` and leaves the payload in the inbox. When `auto_retry` is on, that stored `status` (and the alert's `event.status`) is `pending_replay` instead of `failed`.

### Automatic retry

Captured failures stay `failed` until you replay them, unless the endpoint opts in. `auto_retry`, `retry_max_attempts`, and `retry_base_delay_seconds` are optional on create and `PATCH`.

| Field | Default | Effect |
| --- | --- | --- |
| `auto_retry` | `false` | `true` stores ingest and a failed relay as `pending_replay` with `next_retry_at` set to now. The once-a-minute cron delivers the corpse. `false` leaves the capture at `failed`. |
| `retry_max_attempts` | `6` | Outbox delivery budget for this endpoint (integer 1–20). Counts every cron POST, including the first. The last failure becomes `replay_failed`. |
| `retry_base_delay_seconds` | `60` | Seconds after the first failed outbox delivery (integer 1–86400). Later failures wait `base * 2^(n-1)`, capped at 86400 seconds. |

The same budget applies to `{ "enqueue": true }` and bulk enqueue. Defaults match the historical schedule (1m, 2m, 4m, 8m, 16m, then stop). Synchronous replay stays one-shot and clears `next_retry_at`. Turning `auto_retry` off does not cancel events already on the outbox. Cron granularity is one minute, so a shorter base delay still runs on the next tick once it is due. A non-boolean `auto_retry` or an out-of-range number is `400` `invalid_body`. No Cloudflare Queues. Contract: [docs/retries.md](docs/retries.md).

`POST /v1/waitlist` is unauthenticated. CORS allows `https://getrequeue.com` and `https://www.getrequeue.com` so the marketing site can `fetch` it. Light rate limit: **10 requests per minute per client IP** (`WAITLIST_RATE_LIMIT`). See [docs/waitlist.md](docs/waitlist.md).

`POST /v1/ingest/:endpointKey` and `POST /v1/relay/:endpointKey` share a limit of **60 requests per minute per endpoint** (fixed 60s D1 window). Override with Worker binding `INGEST_RATE_LIMIT`. Over-limit requests return `429` with `error.code: "rate_limited"` and `Retry-After`.

### Relay

`POST /v1/relay/:endpointKey` is the URL you give Stripe, Clerk, or any other provider that can only POST to one webhook endpoint. Same endpoint key as ingest. No Bearer token. Create sets `relay_path` (`/v1/relay/epk_…`).

Hosted example: `https://api.getrequeue.com/v1/relay/epk_…`. `target_url` is your app's existing handler.

Requeue POSTs the **raw body** (not an ingest envelope) to `target_url`. Header **values** are copied unchanged, including `Stripe-Signature`, `svix-id`, `svix-timestamp`, `svix-signature`, and `Content-Type`, so your app can still verify the provider signature. Names are case-insensitive. Hop-by-hop headers, `CF-*`, `X-Forwarded-*`, and `X-Requeue-*` are not forwarded. The upstream call times out after **10 seconds**. Redirects are not followed.

| Upstream | Stored in the inbox? | What the provider gets |
| --- | --- | --- |
| 2xx | No | The same status, `Content-Type`, and body (body capped at 64KB) |
| Anything else (4xx, 5xx, 3xx) | Yes. `failed` (or `pending_replay` when `auto_retry` is on), `source: "relay"`, reason `relay: upstream <status>` | **200** and `{ "captured": true, "event": { "id", "status", "reason" } }` |
| Timeout | Yes. Reason `relay: timeout` | 200, same captured body |
| Network error | Yes. Reason `relay: network error` | 200, same captured body |
| `target_url` is this Worker's `/v1/relay` or `/v1/ingest` | Yes. Reason `relay: loop`. No outbound fetch | 200, same captured body |

Timeout, network error, and loop captures use that same status: `pending_replay` when `auto_retry` is on, otherwise `failed`. Successful relays are not stored. D1 is for corpses, not a copy of every Stripe event.

**Why 200 when your app failed.** Requeue has the payload. A 2xx tells Stripe and Clerk to stop retrying, so the inbox keeps one row and a later replay does not race a provider retry. Returning the upstream 5xx would keep those retries alive and write a row per attempt. 200 is the status every common provider treats as success. If the insert itself throws, the Worker returns 500 and the provider retries — Requeue only claims the event after the row is written. This is not configurable (no extra column). The direct ingest URL is still there if you want to record a failure without taking the provider off its own retry schedule.

`alert_url`, when set, runs on a captured failure the same way as ingest (`source` is `relay`). It does not run on a 2xx pass-through. A deleted endpoint returns `410` `endpoint_gone` and does not alert. Bodies over 512KB return `413`, same as ingest.

Create and `PATCH` reject a `target_url` whose path is `/v1/relay` or `/v1/ingest` on the request host or `api.getrequeue.com` (`400` `invalid_target_url`). That avoids a relay loop. A row that already points there is short-circuited as `relay: loop`.

**Replay and provider signatures.** Replay POSTs the stored raw body and the stored headers, including the original signature. Provider signatures include a timestamp. Stripe's default tolerance is **5 minutes**, and Svix (Clerk) defaults to 5 minutes as well, so a later replay can fail the app's signature check even though the body matches. Two ways through that:

- Edit-before-replay: `POST /v1/events/:id/replay` with a `headers` object for this delivery only (drop or replace `Stripe-Signature`). The stored corpse is unchanged. See [Edit before replay](#edit-before-replay).
- Endpoint `secret`: replay adds `X-Requeue-Timestamp` and `X-Requeue-Signature: sha256=<hmac>` over `{timestamp}.{eventId}.{body}` where `body` is the body actually delivered. Verify that on the replay path. The live relay does **not** add `X-Requeue-*` headers, so the pass-through still looks like the provider.

Queued replays (`{"enqueue": true}` or cron) retry automatically on failure. The default budget is 1m, 2m, 4m, 8m, 16m, then `replay_failed` after 6 outbox attempts. `retry_max_attempts` and `retry_base_delay_seconds` on the endpoint replace that schedule. Manual `POST /v1/events/:id/replay` is one-shot and does not reschedule. Bulk replay defaults to the outbox; see [Bulk replay](#bulk-replay). Dismiss without a delivery: [Resolve](#resolve). Opt-in capture retry: [Automatic retry](#automatic-retry). Details: [docs/retries.md](docs/retries.md). Hosted curls for filters, queued replay, bulk replay, resolve, edit-before-replay, and PATCH/DELETE: [docs/quickstart.md](docs/quickstart.md).

### Bulk replay

`POST /v1/events/bulk-replay` redelivers many events for the caller's project. Same Bearer key as `GET /v1/events`.

```json
{ "ids": ["evt_one", "evt_two"], "enqueue": true }
```

| Field | Default | Effect |
| --- | --- | --- |
| `ids` | required | 1–50 event ids. Empty, missing, or more than 50 is `400` (`invalid_body` or `too_many_ids`) and nothing is replayed |
| `enqueue` | `true` | `true` marks each found event `pending_replay` on the D1 outbox. `false` delivers synchronously, one id at a time |
| `payload` / `headers` | — | Not accepted (`400`). Edit-before-replay stays on `POST /v1/events/:id/replay` |

A well-formed batch returns `200` even when some ids fail. Missing ids and ids from another project are per-item `not_found` (same lookup as single-event replay); the rest still run. Results stay in request order.

```json
{
  "results": [
    {
      "id": "evt_one",
      "ok": true,
      "event": { "id": "evt_one", "status": "pending_replay" },
      "attempt": null,
      "queued": true
    },
    {
      "id": "evt_missing",
      "ok": false,
      "error": { "code": "not_found", "message": "Event not found" }
    }
  ],
  "ok_count": 1,
  "error_count": 1
}
```

`event` is the same object as `GET /v1/events/:id` (the example above omits the other fields). `attempt` is that route's replay-attempt object, or `null` when `queued` is true.

Each success uses the single-event path: HMAC over the delivered body when the endpoint has a `secret`, a `replay_attempts` row on synchronous delivery, and `pending_replay` / `retry_count = 0` / `next_retry_at` when queued. Queued bulk replay clears any previous `delivery_payload` / `delivery_headers`, so cron POSTs the stored corpse. A synchronous upstream failure is still `ok: true` with `attempt.success: false` and `event.status: "replay_failed"` — the same 200-plus-attempt shape as one event. `enqueue: false` is one-shot per id (no backoff).

### Resolve

`POST /v1/events/:id/resolve` dismisses an event. Same Bearer key as replay. It does **not** POST to `target_url` and does **not** write a `replay_attempts` row. Use this after you fixed the failure upstream and want it out of the failed inbox.

```json
{ "note": "fixed in the orders worker" }
```

| Field | Default | Effect |
| --- | --- | --- |
| `note` | omitted | Optional. A string of at most 500 characters, stored on `events.resolve_note` and returned on the event. Blank or null stores `null` |

The event status becomes `resolved`. `next_retry_at`, `delivery_payload`, and `delivery_headers` are cleared so a queued replay is taken off the D1 outbox and cron will not deliver it. `retry_count` is left as history. The ingest corpse (`payload` / `headers`) is unchanged.

Calling resolve on an event that is already `resolved` returns `200` with that event and does not change `resolve_note` or `updated_at`. An id from another project is `404` `not_found`, same as replay.

`POST /v1/events/bulk-resolve` dismisses many events for the caller's project:

```json
{ "ids": ["evt_one", "evt_two"] }
```

`ids` is 1–50 event ids. Empty, missing, or more than 50 is `400` (`invalid_body` or `too_many_ids`) and nothing is resolved — the same errors as [bulk replay](#bulk-replay). A well-formed batch returns `200` with per-item `results`, `ok_count`, and `error_count`. Missing ids and ids from another project are per-item `not_found`; the rest still resolve. Results stay in request order. Bulk resolve does not take a `note` (each success stores `resolve_note: null` unless the event was already resolved).

```json
{
  "results": [
    {
      "id": "evt_one",
      "ok": true,
      "event": { "id": "evt_one", "status": "resolved", "resolve_note": null }
    },
    {
      "id": "evt_missing",
      "ok": false,
      "error": { "code": "not_found", "message": "Event not found" }
    }
  ],
  "ok_count": 1,
  "error_count": 1
}
```

`GET /v1/events?status=resolved` lists dismissed events. A later `POST /v1/events/:id/replay` can still deliver a resolved event if you want it back on the wire.

### Edit before replay

`POST /v1/events/:id/replay` may include an optional JSON body. Empty body and `{ "enqueue": true }` stay backward compatible.

```json
{
  "enqueue": false,
  "payload": { "order_id": "ord_123", "amount": 4200 },
  "headers": { "x-request-id": "req_fixed" }
}
```

| Field | Default | Effect |
| --- | --- | --- |
| `payload` | omitted | Deliver the stored inbox corpse (`events.payload`) |
| `payload` | present | Deliver this JSON/body for **this attempt only** |
| `headers` | omitted | Forward the stored ingest headers |
| `headers` | present | Forward this object for **this attempt only** (same safe-header filter as ingest) |
| `enqueue` | `false` | `true` queues the same override on the D1 outbox |

The original `events.payload` / `events.headers` are the audit corpse. Replay does **not** overwrite them. `GET /v1/events/:id` still returns the ingested body. Queued overrides live on `events.delivery_payload` / `events.delivery_headers` so cron retries deliver the edit, not the stale corpse. HMAC (`secret` on the endpoint) signs the body that is actually POSTed.

### Ingest body

Preferred envelope:

```json
{
  "payload": { "any": "original body" },
  "reason": "upstream 502",
  "source": "webhook",
  "headers": { "x-request-id": "abc" }
}
```

If `payload` is omitted, the raw request body is stored as the failure payload. You can also send `X-Requeue-Reason`.

## Schema

Schema lives in [`migrations/0001_init.sql`](migrations/0001_init.sql). Later migrations add demo-key revoke (`0002`), ingest rate-limit windows and replay backoff columns (`0003`), the marketing waitlist (`0004`), endpoint soft-delete (`0005`, `endpoints.deleted_at`), replay delivery overrides (`0006`, `events.delivery_payload` / `delivery_headers`), and dismiss-without-replay (`0007`, status `resolved` plus `events.resolve_note`). The local demo tenant is [`scripts/seed-local.sql`](scripts/seed-local.sql) only.

| Table | Role |
| --- | --- |
| `projects` | Tenant / workspace |
| `endpoints` | Replay destination + public ingest key (`deleted_at` when retired) |
| `events` | Failed payloads (the inbox) |
| `replay_attempts` | Delivery audit / outbox history |
| `api_keys` | SHA-256 hashed management keys |
| `ingest_rate_windows` | Per-endpoint ingest counters (60s buckets) |
| `waitlist` | Marketing waitlist emails (`POST /v1/waitlist`) |
| `waitlist_rate_windows` | Per-IP waitlist counters (60s buckets) |

Apply locally or remotely:

```bash
npm run db:migrate
npm run db:migrate:remote
```

Create a new migration with:

```bash
npx wrangler d1 migrations create requeue <name>
```

## Deploy (Cloudflare free tier)

1. `npx wrangler login`
2. `npm run db:create` and paste the printed `database_id` into `wrangler.toml`
3. `npx wrangler secret put BOOTSTRAP_SECRET`
4. `npm run db:migrate:remote`
5. `npm run deploy`
6. `POST /v1/api-keys` with `X-Requeue-Bootstrap-Secret` to mint the first management key

`db:migrate:remote` does **not** seed a public demo key. `0002` revokes that hash if an older `0001` inserted it. See [docs/ops-maya.md](docs/ops-maya.md).

## Billing

`GET /v1/billing` always returns the free-tier stub. There is no Stripe (or other) integration in this repo.

## Tests

```bash
npm test
npm run typecheck
```

Pull requests and pushes to `main` run the same commands on GitHub Actions. Pushes to `main` also deploy after CI passes when Cloudflare secrets are set — see [CI.md](CI.md).

Tests run in the Workers runtime via `@cloudflare/vitest-plugin` and cover the ingest → list → replay happy path, relay (2xx passthrough, captured upstream failure / timeout / network error, deleted endpoint, shared rate limit, replay of the raw body), bulk replay (enqueue, sync, mixed missing ids, empty / over-cap `400`, project isolation), edit-before-replay overrides (immediate + queued, HMAC on the delivered body), endpoint listing / update / soft-delete, per-endpoint auto-retry, ingest rate limits, waitlist capture, outbox retry/backoff, plus local demo-key and bootstrap minting.

## License

[MIT](LICENSE) © 2026 requeue-hq
