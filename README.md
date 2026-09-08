# Requeue

**Catch failed webhooks & jobs. Replay them.**

Stripe, Clerk, and your own workers retry a few times, then go quiet. The event that 500'd is gone by the time a customer mentions their invoice never updated. A nightly job times out; the next run overwrites the log. Queue libraries retry, then drop the payload.

Requeue is a dead-letter inbox for webhooks, crons, and background workers. When something fails, send the payload and the reason. Inspect it later. One-click replay the original request to the configured target.

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

Hosted keys are not public. Join the [waitlist](https://getrequeue.com) or email [maya@getrequeue.com](mailto:maya@getrequeue.com) and Maya will mint one. Do not send the local demo key to production.

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
    "secret": "optional-hmac-secret"
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
```

Note `endpoint.id` and `endpoint.endpoint_key` from the create-endpoint response, then substitute `ep_REPLACE_ME` / `epk_REPLACE_ME` / `evt_REPLACE_ME`.

The dashboard at [getrequeue.com/app](https://getrequeue.com/app) is client-only. Point it at `http://127.0.0.1:8787` and paste the local seed key to inspect and replay without curl.

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
    "secret": "optional-hmac-secret"
  }'
```

Inspect and replay from [getrequeue.com/app](https://getrequeue.com/app): set API base URL to `https://api.getrequeue.com` and paste **your** key. Or use the [JS SDK](https://github.com/requeue-hq/requeue-sdk-js) with `baseUrl: "https://api.getrequeue.com"`.

Self-hosting your own Worker? Mint the first key with `POST /v1/api-keys` and Worker secret `BOOTSTRAP_SECRET`. See [docs/api-keys.md](docs/api-keys.md) and [docs/hosted.md](docs/hosted.md).

Replay POSTs the **original stored payload** (not the ingest envelope) to `target_url`. If the endpoint has a `secret`, Requeue adds:

- `X-Requeue-Event-Id`
- `X-Requeue-Timestamp`
- `X-Requeue-Signature: sha256=<hmac>` over `{timestamp}.{eventId}.{payload}`

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | `wrangler dev` |
| `npm test` | ingest + replay tests |
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
| JS SDK | [requeue-hq/requeue-sdk-js](https://github.com/requeue-hq/requeue-sdk-js) | `@requeue-hq/sdk` |
| This repo | [requeue-hq/requeue](https://github.com/requeue-hq/requeue) | Open-source Worker + D1 schema |

More on the live stack and keys: [docs/hosted.md](docs/hosted.md), [docs/api-keys.md](docs/api-keys.md).

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

Replay is synchronous by default: Requeue POSTs the stored payload to `target_url` and writes a `replay_attempts` row. Pass `{"enqueue": true}` to mark the event `pending_replay`; a once-a-minute cron drains that D1 outbox. Failed outbox deliveries retry with exponential backoff (still D1-backed). Cloudflare Queues are not used. See [docs/retries.md](docs/retries.md).

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
| `POST` | `/v1/api-keys` | bootstrap secret or Bearer | Mint a management key (bootstrap also creates a project) |
| `GET` | `/v1/api-keys` | Bearer | List keys for the current project |
| `DELETE` | `/v1/api-keys/:id` | Bearer | Revoke a key |
| `POST` | `/v1/endpoints` | Bearer | Create an endpoint (`target_url`, optional `secret`) |
| `GET` | `/v1/endpoints` | Bearer | List project endpoints (no raw `secret`; `has_secret` only) |
| `GET` | `/v1/endpoints/:id` | Bearer | Fetch one project endpoint |
| `POST` | `/v1/ingest/:endpointKey` | endpoint key | Store a failed event (60 ingest/min/endpoint; `429` when exceeded) |
| `GET` | `/v1/events` | Bearer | List events; `?status=` + `?endpoint_id=` + `?limit=` |
| `GET` | `/v1/events/:id` | Bearer | Event + replay attempts |
| `POST` | `/v1/events/:id/replay` | Bearer | Deliver payload now, or `{ "enqueue": true }` |
| `GET` | `/v1/billing` | Bearer | Billing stub |

See [API keys](#api-keys).

Event statuses: `failed`, `pending_replay`, `replayed`, `replay_failed`. Optional `endpoint_id` limits the list to one destination so you can inspect failures per endpoint.

`GET /v1/endpoints` is project-scoped (same Bearer key as create). Responses include `endpoint_key` and `has_secret`, never the HMAC `secret`.

`POST /v1/ingest/:endpointKey` is limited to **60 requests per minute per endpoint** (fixed 60s D1 window). Override with Worker binding `INGEST_RATE_LIMIT`. Over-limit requests return `429` with `error.code: "rate_limited"` and `Retry-After`.

Queued replays (`{"enqueue": true}` or cron) retry automatically on failure: 1m, 2m, 4m, 8m, 16m, then `replay_failed` after 6 outbox attempts. Manual `POST /v1/events/:id/replay` is one-shot and does not reschedule. Details: [docs/retries.md](docs/retries.md).

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

Schema lives in [`migrations/0001_init.sql`](migrations/0001_init.sql). Later migrations add demo-key revoke (`0002`) plus ingest rate-limit windows and replay backoff columns (`0003`). The local demo tenant is [`scripts/seed-local.sql`](scripts/seed-local.sql) only.

| Table | Role |
| --- | --- |
| `projects` | Tenant / workspace |
| `endpoints` | Replay destination + public ingest key |
| `events` | Failed payloads (the inbox) |
| `replay_attempts` | Delivery audit / outbox history |
| `api_keys` | SHA-256 hashed management keys |
| `ingest_rate_windows` | Per-endpoint ingest counters (60s buckets) |

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

Tests run in the Workers runtime via `@cloudflare/vitest-plugin` and cover the ingest → list → replay happy path, endpoint listing, ingest rate limits, outbox retry/backoff, plus local demo-key and bootstrap minting.

## License

[MIT](LICENSE) © 2026 requeue-hq
