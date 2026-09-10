# FAQ

Short answers for people who landed here after a Stripe or Clerk webhook went quiet. Maya Chen, open-core.

## What is Requeue? What is it not?

Requeue is a **dead-letter inbox** for webhooks, crons, and background workers. Stripe, Clerk, and your own queues retry a few times, then stop. You POST the payload and the reason here. Inspect it later. Replay the original request to the configured `target_url`.

It is **not** a full webhook gateway. We do not sit in front of Stripe as the public URL, transform or fan-out events, or replace outbound “webhooks as a service.” After provider retries stop, you send the corpse in.

## Self-host vs hosted

Same Worker, same routes. Model: **open-core MIT + hosted**.

| | Self-host | Hosted |
| --- | --- | --- |
| What you run | This repo: Cloudflare Worker + D1 (MIT) | Maya runs it |
| API | Your Worker URL | [api.getrequeue.com](https://api.getrequeue.com) |
| Inbox UI | [getrequeue.com/app](https://getrequeue.com/app) pointed at your Worker | [getrequeue.com/app](https://getrequeue.com/app) |
| Keys | `POST /v1/api-keys` + `BOOTSTRAP_SECRET` — [api-keys.md](api-keys.md) | Waitlist or email Maya (below) |

Local Wrangler uses a seed key that is **not** valid on hosted. Details: [hosted.md](hosted.md).

## How does replay signing work?

If the endpoint has a `secret`, replay POSTs the **original stored payload** and adds HMAC headers (`X-Requeue-Event-Id`, `X-Requeue-Timestamp`, `X-Requeue-Signature`). The contract is in the [README](../README.md#quickstart) (hosted Quickstart) and [`src/replay.ts`](../src/replay.ts). This FAQ does not repeat it.

Retries and the D1 outbox: [retries.md](retries.md).

## How does Requeue compare?

Fair and short. These products overlap on “webhooks / jobs / reliability”; they are not the same job.

**[Hookdeck](https://hookdeck.com)** is an inbound webhook gateway: it receives events from Stripe, Shopify, and the rest, queues them, and forwards to your app with retries and observability. Requeue is the inbox *after* those retries (or the provider’s) stop — we are not the front door.

**[Svix](https://www.svix.com)** is webhooks-as-a-service for *sending* events to your customers (outbound delivery, customer portals, signing). Requeue is for catching *your* inbound webhook and job failures, not for emitting webhooks to end users.

**[Healthchecks](https://healthchecks.io)** is a dead-man’s switch: your cron pings on success, and you get an alert if the ping is late. Requeue stores the failed payload so you can inspect and replay it; we do not watch schedules or page you when a job never started.

**[Relae](https://relaehook.com)** is a webhook delivery platform (retries, observability, and a dead-letter queue as part of that pipeline). Requeue is only the inspect-and-replay inbox — MIT Worker + D1 — and it also takes cron and worker failures, not just webhook deliveries.

## How do I get a hosted key?

Hosted production has no public demo tenant. Do not send the local seed key to [api.getrequeue.com](https://api.getrequeue.com).

1. Join the [waitlist](https://getrequeue.com) — the form posts `POST /v1/waitlist` on the hosted API ([waitlist.md](waitlist.md)).
2. Or email [maya@getrequeue.com](mailto:maya@getrequeue.com). Maya will mint a management key.

Then paste that key at [getrequeue.com/app](https://getrequeue.com/app) with API base URL `https://api.getrequeue.com`. Five-minute path: [quickstart.md](quickstart.md).

No pricing in this FAQ. If you deploy your own Worker, mint the first key yourself — [api-keys.md](api-keys.md).
