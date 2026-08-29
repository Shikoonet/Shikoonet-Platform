# Cloudflare Deployment

Reference for the individual Cloudflare commands and one-time account setup.

> **For day-to-day releases, use `docs/release-process.md`, not this file.**
> `pnpm release:dev` / `pnpm release:prod` wrap everything below in the right
> order with the necessary guards. The raw commands here are for first-time
> setup and for debugging a failed release.

## Prerequisites

- Cloudflare account with Workers + Pages + D1 enabled.
- `wrangler` authenticated (`wrangler login` or `CLOUDFLARE_API_TOKEN` env).
- D1 database created:

  ```bash
  wrangler d1 create reconciliation-hub
  # note the database_id
  ```

  Update `apps/ingest-worker/wrangler.toml` and
  `apps/dashboard-worker/wrangler.toml` with the same `database_id`.

## Migrations

**`wrangler deploy` does not apply migrations.** They must be run explicitly, and
before the deploy — omitting this is what caused the production 500s on
2026-08-05 (`docs/verification/final-report.md`). `release.sh` does it for you.

```bash
pnpm --filter @hub/dashboard-worker db:migrate:dev    # payment-hub-dev
pnpm --filter @hub/dashboard-worker db:migrate:prod   # payment-hub-staging (PRODUCTION)
```

Both databases share the single `migrations/` directory. See
`docs/release-process.md` for why filenames must never be renumbered.

## Deploy the ingest Worker

```bash
pnpm --filter @hub/ingest-worker deploy:dev   # ingest-worker-dev
pnpm --filter @hub/ingest-worker deploy       # ingest-worker (PRODUCTION)
```

Secrets are **per worker name** — `ingest-worker-dev` does not inherit anything
from `ingest-worker`. Set the dev ones against the dev config:

```bash
cd apps/ingest-worker
pnpm exec wrangler secret put MIRZABOT_INTEGRATION_HMAC_SECRET -c wrangler.dev.toml
pnpm exec wrangler secret put MIRZABOT_WEBHOOK_URL             -c wrangler.dev.toml
```

`LOG_SMS_BODY` is a plain `[vars]` entry, not a secret, and is `"false"` in both
configs. Device API keys are never held by the Worker — only their hashes are in D1.

Rate limits use the modern `[[ratelimits]]` syntax (namespaces 1001/1002 in
production, 2001/2002 in dev), not the old `[[unsafe.bindings]]` form.

## Deploy the dashboard Worker

The SPA must be built first — `dist/` is gitignored and the Worker mounts it via
`[assets]`, so deploying without a build ships a stale or empty bundle.

```bash
pnpm --filter @hub/dashboard-web build
pnpm --filter @hub/dashboard-worker deploy:dev   # dashboard-worker-dev
pnpm --filter @hub/dashboard-worker deploy       # dashboard-worker (PRODUCTION)
```

`ACCESS_AUD`, `ACCESS_ISSUER`, and `ACCESS_TEAM_DOMAIN` are committed `[vars]` in
each `wrangler.toml` — **not** secrets. Setting them as secrets as well would
create a silent conflict. Do NOT set `TEST_ACCESS_USER` in production.

## Deploy the SPA

```bash
pnpm --filter @hub/dashboard-web build
# The dist/ directory is served by Cloudflare Pages (preferred) or
# bundled into the dashboard Worker via the [[site]] / [assets] config.
```

### Option A: Cloudflare Pages

```bash
wrangler pages deploy apps/dashboard-web/dist \
  --project-name reconciliation-hub
```

Configure the Pages project:

- Build command: `pnpm --filter @hub/dashboard-web build`
- Build output: `apps/dashboard-web/dist`
- Root directory: `apps/dashboard-web`
- Environment variables (production):
  - `VITE_API_BASE` = `https://dashboard.<your-domain>`

### Option B: Workers Assets (recommended for a single-worker topology)

In `apps/dashboard-worker/wrangler.toml`:

```toml
[assets]
directory = "../dashboard-web/dist"
binding = "ASSETS"
```

Then `wrangler deploy` from `apps/dashboard-worker`. The Worker serves
`ASSETS` for paths that don't match an API route.

## DNS

Map `dashboard.<your-domain>` to the dashboard Worker (or Pages project)
and `ingest.<your-domain>` to the ingest Worker. Cloudflare Access policy
on the dashboard host: `Allow Emails reviewer@your-domain.com`.

## Smoke test

After deploy, send a curl:

```bash
curl -X POST https://ingest.<your-domain>/api/v1/sms \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "<a registered device apiKey>",
    "deviceId": "phone-a",
    "deviceName": "Test Phone 1",
    "message": "واریز 50,000 ریال به کارت *1234 - مانده 250,000 ریال",
    "sender": "BANK",
    "timestamp": "1735689600000",
    "checksum": "00000000000000000000000000000000"
  }'
```

A 200 OK with `{ ok: true, eventId: "..." }` confirms the ingest path.

## Rollback

`wrangler rollback --name ingest-worker` reverts to the previous
deployment. Each `wrangler deploy` creates a new version, so rollback is
one command. Worker versions are also immutable, so you can `wrangler
versions list` and pin a specific version via `wrangler versions deploy`.

## Disabling a device

```bash
wrangler d1 execute reconciliation-hub \
  --command "UPDATE devices SET active = 0 WHERE device_code = 'phone-a'"
```

Or use the dashboard's **Disable** action.
