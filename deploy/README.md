# Deploying — three services that do not have to share a host

## The short version

The bot and the dashboard have **zero code coupling**. No import edge, no HTTP
call, no shared secret between them. Grep for it: `apps/bot/src` makes exactly
one kind of outbound request, to `api.telegram.org`.

What they share is a database. That is the entire integration, and it is also
the answer to "how do they stay in sync": they do not sync, they read the same
Postgres.

```
        host A                    host B                    host C
  ┌───────────────┐        ┌───────────────┐        ┌───────────────┐
  │  Postgres 16  │◄───────│  bot          │        │  dashboard    │
  │               │◄───────┼───────────────┼────────│  + SPA :8788  │
  │               │◄───────│  ingest :8787 │        └───────────────┘
  └───────────────┘        └───────────────┘
```

Any grouping of those boxes onto machines works. Everything on one host is the
current plan; the bot on its own host is what the head admin asked for on
2026-08-13 and needs no code change to do.

## How an admin action reaches a customer across two hosts

This is worth being explicit about, because it looks like it should need a
message queue and does not.

An admin approves a payment in the dashboard on host C. That writes
`payment_claims.status = 'VERIFIED'`. The bot on host B sweeps for verified
claims every polling cycle (`apps/bot/src/settle.ts`), joins them to its own
`payments` and `orders`, marks the sale paid and messages the customer.

The handoff is a SQL join, not a callback. That is deliberate: the deciding
event happens in another process, and a sweep survives a restart in the middle
of one because the work still to do is derived from the rows rather than from
anything held in memory. Put the two processes on different continents and the
behaviour is identical, only later.

## Building a deployable copy

`pnpm deploy` produces a self-contained directory with workspace dependencies
resolved and devDependencies pruned:

```bash
corepack pnpm install
corepack pnpm --filter @shikoo/dashboard-web build   # dashboard only: builds the SPA
corepack pnpm deploy --filter @shikoo/bot        --prod /tmp/out/bot
corepack pnpm deploy --filter @shikoo/dashboard  --prod /tmp/out/dashboard
corepack pnpm deploy --filter @shikoo/ingest     --prod /tmp/out/ingest
```

Then `robocopy`/`rsync` the one directory you need to the one host that needs
it, into `/opt/shikoo/<service>`.

Because the prune is real, **a runtime import from a devDependency breaks the
deployed copy and nothing else**. That was already true of one package:
`apps/dashboard-worker` imports `@shikoo/sms-parser` at runtime in `index.ts`
while declaring it under `devDependencies`. It is a `dependencies` entry now.
If you add an import, check which list it is in.

## Environment, per service

Keep each of these at mode 0600. They hold the bot token, the HMAC secret and
the database password.

### `/etc/shikoo/bot.env`

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Add `?sslmode=require` when Postgres is on another host |
| `TELEGRAM_BOT_TOKEN` | yes | Never logged. Never point this at the real bot from a test host |
| `TELEGRAM_API_BASE` | no | Defaults to `https://api.telegram.org` |
| `TELEGRAM_POLL_TIMEOUT_SEC` | no | Default 25 |

No `PORT`. The bot does not listen.

### `/etc/shikoo/dashboard.env`

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | |
| `ACCESS_AUD`, `ACCESS_ISSUER` | yes in production | Cloudflare Access JWT verification |
| `ENV_NAME` | yes | Set to `production` |
| `SPA_DIST` | no | Defaults to `../dashboard-web/dist` relative to cwd |
| `PORT`, `HOST` | no | Default `8788`, `127.0.0.1` |
| `INGEST_URL` | recommended | Printed into the SMS-relay phone configuration. The compiled fallback still points at the retired Workers hostname |
| `TEST_ACCESS_USER` | **never in production** | Bypasses JWT verification. The process refuses to start with it set while `ENV_NAME=production` |

### `/etc/shikoo/ingest.env`

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | |
| `PORT`, `HOST` | no | Default `8787`, `127.0.0.1` |
| `SWEEP_INTERVAL_MS` | no | Default 60000 |
| `DEVICE_RATE_LIMIT`, `IP_RATE_LIMIT`, `RATE_LIMIT_WINDOW_MS` | no | Second layer; the edge is the first |
| `MIRZABOT_INTEGRATION_*`, `AUTO_MATCH_ENABLED`, `AUTO_FULFILLMENT_ENABLED` | while the PHP bot lives | HMAC integration with the legacy bot |
| `LOG_SMS_BODY` | **leave unset** | A raw bank SMS body is never written to a log |

## Postgres, when a service is on another host

The three services connect as ordinary clients, so this is standard Postgres
setup rather than anything this project invents:

1. `listen_addresses` on the database host, and a firewall rule that admits only
   the service hosts.
2. TLS on, and `?sslmode=require` in every `DATABASE_URL`. Without it the
   password and every card number crosses the network in the clear.
3. A role per service. The bot does not need to read `audit_logs`; the dashboard
   does not need to write `orders`. Least privilege is cheap here because the
   table ownership is already clean.

## Selling a customer their own branded bot and dashboard

The white-label case the head admin described — a reseller who wants their own
Telegram bot and their own dashboard — works today as **one Postgres and one set
of processes per customer**, with no schema change at all.

That is worth stating plainly, because the alternative reading of the request is
a multi-tenant phase: a `tenant_id` column on all 53 tables, per-tenant bot
tokens, per-tenant branding. None of that is needed unless two customers have to
share one database.

The one place the single-tenant assumption is written down is already annotated
in the schema (`migrations/0006_bot.sql`): `telegram_updates` is keyed on
`update_id`, which is unique per bot token, so two bots on one database would
collide. In the database-per-customer model that never arises.

Branding is confined to `apps/dashboard-web` — the page title, the logo file,
the wordmark, the theme storage key. Those are build-time today; making them
env-driven is the work if and when a second brand is sold.

## Still hardcoded at deploy time

Two strings assume the retired Cloudflare hostnames. Neither blocks running the
services on separate hosts — same-origin requests are always accepted, and
`INGEST_URL` overrides the second — but both should be settled before a second
deployment exists:

- `apps/dashboard-worker/src/security.ts` — the cross-origin allowlist
- `apps/dashboard-worker/src/index.ts` — `DEFAULT_INGEST_URL`
