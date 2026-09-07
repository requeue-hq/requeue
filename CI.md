# CI / CD

GitHub Actions (`.github/workflows/ci.yml`) uses the free tier only: `ubuntu-latest`, Node 22, no paid Actions features.

## CI

On every pull request and every push to `main`:

1. `npm ci`
2. `npm run typecheck`
3. `npm test`

The job **fails** if typecheck or tests fail. Tests use Miniflare / local D1; they do not need Cloudflare credentials.

## Deploy

On push to `main` only, after CI passes and both deploy secrets are set:

1. **Apply remote D1 migrations** — `scripts/ci-apply-remote-migrations.sh` runs `npx wrangler d1 migrations apply requeue --remote` (same as `npm run db:migrate:remote`). Wrangler applies each file **not** already listed in the remote `d1_migrations` table. Confirmation is skipped in CI (wrangler 4.x has no `--yes`). Does **not** run `scripts/seed-local.sql`.
2. **Deploy Worker** — `npx wrangler deploy` → Worker at [api.getrequeue.com](https://api.getrequeue.com)

These are separate jobs. Deploy runs whenever the secrets are present (it is not blocked if migrate fails). If remote schema is already up to date but Wrangler tries to re-run `0001` (`table projects already exists` / `duplicate column`), the migrate script treats that as already applied and exits 0 so both jobs can stay green.

The deploy jobs are **skipped** (the workflow still succeeds) unless both secrets below are set. They do not run on pull requests. A small `deploy-gate` job on `main` checks that the secrets exist without printing them (GitHub does not allow `secrets` in a job-level `if`).

### One-time: sync `d1_migrations` if it is empty

Hosted D1 was migrated manually before CI tracked applies. Wrangler only skips a file when its name is in `d1_migrations`. If that table is missing or empty, every deploy will attempt `0001_init.sql` again and hit `already exists`.

CI does **not** DROP tables and does **not** auto-insert tracking rows (that could hide a migration that is not actually on remote). After you confirm the live schema already matches `0001`–`0003`, record those files once:

```bash
npx wrangler d1 execute requeue --remote --command "SELECT name FROM d1_migrations ORDER BY id;"
npx wrangler d1 execute requeue --remote --command "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY 1;"
```

If `projects`, `endpoints`, `events`, `replay_attempts`, `api_keys`, and `ingest_rate_windows` exist, `events` has `retry_count` / `next_retry_at`, and `d1_migrations` is empty or missing those names:

```bash
npx wrangler d1 execute requeue --remote --command \
  "INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0001_init.sql'), ('0002_revoke_public_demo_key.sql'), ('0003_ingest_limits_and_replay_backoff.sql');"
```

If `d1_migrations` does not exist yet, run `npx wrangler d1 migrations apply requeue --remote` once (CI also creates it) and then insert the names. After this, new files under `migrations/` apply as pending and are recorded automatically. Do not DROP production tables.

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
