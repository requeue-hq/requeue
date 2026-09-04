# Requeue

**Catch failed webhooks & jobs. Replay them.**

Requeue is an open-source dead-letter inbox for webhooks, cron jobs, and background workers. When something fails, send Requeue the payload and the reason. Inspect it later, then one-click replay the original request to the configured target.

This repository is the **open-source core API** (Cloudflare Workers + D1). The marketing site lives in [requeue-web](https://github.com/requeue-hq/requeue-web) and is not part of this repo.

## Elevator pitch

Catch failed webhooks and jobs. Replay them.

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
    WH[Webhooks]
    CR[Cron jobs]
    WK[Background workers]
  end

  subgraph worker [Requeue Worker - Hono]
    IN[POST /v1/ingest/:endpointKey]
    MGMT[Management API]
    AUTH[Bearer API key]
    OUT[D1 replay outbox]
  end

  D1[(Cloudflare D1)]
  TGT[target_url]

  WH --> IN
  CR --> IN
  WK --> IN
  IN --> D1
  MGMT --> AUTH
  AUTH --> D1
  MGMT -->|POST /v1/events/:id/replay| OUT
  OUT -->|POST original payload| TGT
  OUT --> D1
```

**Ingest** is authenticated by the endpoint key in the URL (a capability token).  
**Management** (create endpoints, list events, replay) requires `Authorization: Bearer <api_key>`.

Replay is synchronous by default: Requeue POSTs the stored payload to `target_url` and writes a `replay_attempts` row. Pass `{"enqueue": true}` to mark the event `pending_replay`; a once-a-minute cron drains that D1 outbox. Cloudflare Queues are not used.

## Quickstart (local)

Requires Node.js 20+ and a Cloudflare account only when you deploy. Local mode uses Wrangler’s D1 emulator.

```bash
git clone https://github.com/requeue-hq/requeue.git
cd requeue
npm install
npm run db:migrate
npm run dev
```

Wrangler listens on `http://127.0.0.1:8787`.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | `wrangler dev` |
| `npm test` | ingest + replay tests |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:migrate` | apply D1 migrations locally |
| `npm run db:migrate:remote` | apply migrations to remote D1 |
| `npm run deploy` | deploy the Worker |

### Demo management key

The first migration seeds a **local/demo** project and API key. Do not use it in production.

```
rq_demo_local_dev_only_do_not_use_in_prod
```

SHA-256 (stored in D1): `ea489957fc62094c0071d21898c261e18b9c04daedb39bc2f8392137fd6a6ccb`

## Curl happy path

Create an endpoint (the URL that should receive replays):

```bash
curl -sS http://127.0.0.1:8787/v1/endpoints \
  -H "Authorization: Bearer rq_demo_local_dev_only_do_not_use_in_prod" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Orders worker",
    "target_url": "https://httpbin.org/post",
    "secret": "optional-hmac-secret"
  }'
```

Note `endpoint.endpoint_key` from the response, then report a failure:

```bash
curl -sS http://127.0.0.1:8787/v1/ingest/epk_REPLACE_ME \
  -H "Content-Type: application/json" \
  -d '{
    "payload": { "order_id": "ord_123", "amount": 4200 },
    "reason": "fulfillment timeout",
    "source": "worker"
  }'
```

List failures, fetch one, then replay it:

```bash
curl -sS "http://127.0.0.1:8787/v1/events?status=failed" \
  -H "Authorization: Bearer rq_demo_local_dev_only_do_not_use_in_prod"

curl -sS http://127.0.0.1:8787/v1/events/evt_REPLACE_ME \
  -H "Authorization: Bearer rq_demo_local_dev_only_do_not_use_in_prod"

curl -sS -X POST http://127.0.0.1:8787/v1/events/evt_REPLACE_ME/replay \
  -H "Authorization: Bearer rq_demo_local_dev_only_do_not_use_in_prod"
```

Replay POSTs the **original stored payload** (not the ingest envelope) to `target_url`. If the endpoint has a `secret`, Requeue adds:

- `X-Requeue-Event-Id`
- `X-Requeue-Timestamp`
- `X-Requeue-Signature: sha256=<hmac>` over `{timestamp}.{eventId}.{payload}`

Health check (no auth):

```bash
curl -sS http://127.0.0.1:8787/health
```

## HTTP API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | none | Liveness + D1 ping |
| `POST` | `/v1/endpoints` | Bearer | Create an endpoint (`target_url`, optional `secret`) |
| `POST` | `/v1/ingest/:endpointKey` | endpoint key | Store a failed event |
| `GET` | `/v1/events` | Bearer | List events; `?status=` + `?limit=` |
| `GET` | `/v1/events/:id` | Bearer | Event + replay attempts |
| `POST` | `/v1/events/:id/replay` | Bearer | Deliver payload now, or `{ "enqueue": true }` |
| `GET` | `/v1/billing` | Bearer | Billing stub |

Event statuses: `failed`, `pending_replay`, `replayed`, `replay_failed`.

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

SQL lives in [`migrations/0001_init.sql`](migrations/0001_init.sql).

| Table | Role |
| --- | --- |
| `projects` | Tenant / workspace |
| `endpoints` | Replay destination + public ingest key |
| `events` | Failed payloads (the inbox) |
| `replay_attempts` | Delivery audit / outbox history |
| `api_keys` | SHA-256 hashed management keys |

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
3. `npm run db:migrate:remote`
4. `npm run deploy`

Replace the seeded demo API key before exposing the Worker. The seed is for local development only.

## Billing

`GET /v1/billing` always returns the free-tier stub. There is no Stripe (or other) integration in this repo.

## Tests

```bash
npm test
npm run typecheck
```

Tests run in the Workers runtime via `@cloudflare/vitest-plugin` and cover the ingest → list → replay happy path.

## License

[MIT](LICENSE) © 2026 requeue-hq
