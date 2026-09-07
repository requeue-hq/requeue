# CI / CD

GitHub Actions (`.github/workflows/ci.yml`) uses the free tier only: `ubuntu-latest`, Node 20, no paid Actions features.

## CI

On every pull request and every push to `main`:

1. `npm ci`
2. `npm run typecheck`
3. `npm test`

The job **fails** if typecheck or tests fail. Tests use Miniflare / local D1; they do not need Cloudflare credentials.

## Deploy

On push to `main` only, after CI passes:

1. `npx wrangler d1 migrations apply requeue --remote --yes`  
   Same as `npm run db:migrate:remote` (schema + demo-key revoke). Wrangler applies each file once. Does **not** run `scripts/seed-local.sql`.
2. `npx wrangler deploy` → Worker at [api.getrequeue.com](https://api.getrequeue.com)

The deploy job is **skipped** (the workflow still succeeds) unless both secrets below are set. It does not run on pull requests. A small `deploy-gate` job on `main` checks that the secrets exist without printing them (GitHub does not allow `secrets` in a job-level `if`).

`BOOTSTRAP_SECRET` stays in Cloudflare (`npx wrangler secret put BOOTSTRAP_SECRET`). Do not put it, or any `rq_…` API key, in GitHub Actions.

## Secrets (Maya)

GitHub → **Settings → Secrets and variables → Actions → New repository secret**.

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Create a token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens). Do not commit it. |
| `CLOUDFLARE_ACCOUNT_ID` | `550ca8e6b415f74ad69ef9a5714911bc` |

Suggested token permissions (Account, this Cloudflare account):

- **Workers Scripts** — Edit
- **D1** — Edit

After both secrets exist, the next push to `main` deploys. Until then, CI still runs and deploy stays skipped.
