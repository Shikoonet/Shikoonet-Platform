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

One image, three services. `SERVICE` picks which entry point runs — there is no
default, because an image that guesses starts the wrong process on a typo and
looks healthy doing it.

```bash
docker build -t shikoo .
docker run -e SERVICE=bot       -e DATABASE_URL=... -e TELEGRAM_BOT_TOKEN=... shikoo
docker run -e SERVICE=ingest    -e DATABASE_URL=... -p 8787:8787 shikoo
docker run -e SERVICE=dashboard -e DATABASE_URL=... -p 8788:8788 shikoo
```

Measured on 2026-08-15: **18 s to build, 587 MB image, and 49–54 MB of memory
per running service.**

### What used to be written here, and why none of it worked

This section described `pnpm deploy --prod` into `/opt/shikoo/<service>`, run by
the three `*.service` units. That recipe could not start the project, for three
independent reasons, and the units are retired along with it:

1. All three units ran `node dist/server.js`. **No package has a `build` script
   and no `tsconfig` has an `outDir`** — `dist/` was never produced by anything.
2. The alternative, `pnpm start` → `tsx src/server.ts`, needs `tsx`, which was
   a root devDependency. `--prod` prunes exactly that. `tsx` is a real
   dependency of each of the three apps now.
3. **`pnpm deploy` does not run in this workspace at all**:
   `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`, because `inject-workspace-packages`
   is not set.

A plain `tsc` emit would not have rescued it either: the tree is written for
`moduleResolution: "Bundler"`, so imports carry no file extension and the output
is not loadable by Node ESM. That is why TypeScript is still TypeScript at
runtime here, with `tsx` resolving it.

The old warning still applies in a new form: **a runtime import from a
devDependency is a deploy-time failure and nothing else.** It has already
happened once — `apps/dashboard-worker` imported `@shikoo/sms-parser` at runtime
while declaring it under `devDependencies`. If you add an import, check which
list it is in.

### Health checks

Deliberately not in the Dockerfile, because they differ per service and a
Dockerfile `HEALTHCHECK` takes precedence over the panel's. Configure them in
Coolify:

| Service | Check |
| --- | --- |
| `ingest` | `GET /health` on 8787 |
| `dashboard` | `GET /health` on 8788 |
| `bot` | **none — disable it.** The bot opens no port; it long-polls outward, which is why it needs no inbound rule, no certificate and no DNS name |

## The edge — how a browser reaches any of this

Nothing above opens a port to the internet. Something in front has to, and since
2026-08-17 that is a small nginx container rather than a Cloudflare tunnel.

```
browser ──▶ :9443 ──▶ shikoo-tls ──▶ dashboard:8788
                    (nginx:alpine) ──▶ ingest:8787
```

`shikoo-tls` joins the same Docker network as the services, publishes only
`:9443`, and mounts `/etc/letsencrypt` read-only. The host's own `:80` and `:443`
are deliberately untouched — they belong to unrelated sites on that box — which
is the whole reason the port appears in the URL.

Two lines in that config are load-bearing and neither is obvious:

- **`proxy_set_header Host $http_host`** — not `$host`. `originGuard` compares
  `new URL(origin).host` on both sides and `URL.host` keeps the port. `$host`
  strips it, and every state-changing request then answers
  `cross_origin_forbidden`.
- **the upstream in a variable, with `resolver 127.0.0.11`** — `proxy_pass` with
  a literal name resolves once at startup, and every deploy gives the app a new
  container and a new IP.

That second one is not hypothetical. The tunnel it replaced addressed the
container by name, a deploy renamed the container, and the panel answered 502
until somebody read `docker logs`. The services carry stable network aliases now
(`dashboard`, `ingest`) via Coolify's `custom_network_aliases` — **not**
`custom_docker_run_options`, which accepts `--network-alias` and silently never
applies it.

Certificates: Let's Encrypt over DNS-01, both hostnames, one lineage named
`shikoo`. DNS-01 rather than HTTP-01 because that would need `:80`. Renewal must
reload the container — a `renewal-hooks/deploy` script does it — and it needs a
DNS API token that outlives the certificate.

## Environment, per service

On Coolify these are the environment variables of each application, not files.
The tables below keep their old headings because the variable names are what
matter; wherever one says `/etc/shikoo/*.env`, read "this service's environment
in Coolify". They hold the bot token, the HMAC secret and the database
password, so they are secrets there too.

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
| ~~`ACCESS_AUD`, `ACCESS_ISSUER`, `ADMIN_ACCESS_AUD`~~ | **gone** | Cloudflare Access was removed 2026-08-16. The panel has its own login; see «اپراتورها» below |
| `ENV_NAME` | yes | Set to `production` |
| `SPA_DIST` | no | The payment hub SPA. Set absolutely in the image |
| `ADMIN_DIST` | no | **The shop admin panel SPA**, served at `/admin`. One process serves both; this row was missing while the code read it, and an unbuilt SPA is a 500 rather than a failed deploy |
| `PORT`, `HOST` | no | Default `8788`, `127.0.0.1` |
| `INGEST_URL` | recommended | Printed into the SMS-relay phone configuration. There is no fallback any more: the routes that need it answer 503 `INGEST_URL_MISSING` |
| `TEST_ACCESS_USER` | **never in production** | Skips the login and pins an identity. Refused twice: the process will not start with it set while `ENV_NAME=production`, and the identity path refuses it there again |

### اپراتورها — the bootstrap nobody can skip

Access used to decide who reached the panel. It does not exist any more, so the
only way in is a row in `access_users` **with a password**, and the screen that
creates that row is itself behind the panel. Somebody has to make the first one
from outside, once:

```bash
export DATABASE_URL=...                      # never guessed; the script refuses without it
corepack pnpm --filter @shikoo/dashboard operator create you@example.com ADMIN
corepack pnpm --filter @shikoo/dashboard operator set-password you@example.com
corepack pnpm --filter @shikoo/dashboard operator enroll-totp you@example.com   # optional
corepack pnpm --filter @shikoo/dashboard operator list
```

The password is read from stdin, never from the command line — an argument is
visible in `ps` to every user on the box and lands in a shell history file.

Rows migrated from the Access era have no password and **cannot sign in** until
`set-password` runs on them. That is the intended direction of failure: an
operator who cannot get in says so immediately, where a default password nobody
changed says nothing at all.

`enroll-totp` prints the secret once and then asks for a code before it enables
anything, so a second factor is never switched on for an app that cannot produce
it. `operator unlock` clears a lockout (five wrong passwords, fifteen minutes).

### `/etc/shikoo/ingest.env`

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | |
| `PORT`, `HOST` | no | Default `8787`, `127.0.0.1` |
| `SWEEP_INTERVAL_MS` | no | Default 60000 |
| `DEVICE_RATE_LIMIT`, `IP_RATE_LIMIT`, `RATE_LIMIT_WINDOW_MS` | no | Second layer; the edge is the first |
| `MIRZABOT_INTEGRATION_*`, `AUTO_MATCH_ENABLED`, `AUTO_FULFILLMENT_ENABLED` | while the PHP bot lives | HMAC integration with the legacy bot |

A raw bank SMS body is never written to a log, under any setting. There used to
be a `LOG_SMS_BODY` row here; the variable was read by nothing, so the
instruction protected nothing and implied a switch that could turn it on.

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

## ~~Still hardcoded at deploy time~~ — settled

Both strings that assumed the retired Cloudflare hostnames are gone.
`security.ts` reads `ALLOWED_ORIGINS` from the environment, and
`DEFAULT_INGEST_URL` was replaced by a nullable `ingestUrl()` — the routes that
need it answer 503 `INGEST_URL_MISSING` rather than pointing a phone at a
hostname that is no longer ours.
