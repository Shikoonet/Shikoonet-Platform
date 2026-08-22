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
docker run -e SERVICE=migrate   -e DATABASE_URL=... shikoo   # applies, then exits
```

### The schema gate — why a container may refuse to start

Before any of the three services starts, the entrypoint asks whether this
database carries the migrations this image was built from. If it does not, the
container **refuses to start** and names the files.

That refusal is the whole point. On 2026-08-17 the dashboard was deployed with
the operator-login code while `0021_operator_auth.sql` had never been run: the
image built, the container started, the health check passed, and every login
answered 500 with `column "password_hash" does not exist`. A container that
cannot serve should say so at boot, not one request at a time.

Two cases are treated differently on purpose:

| what the ledger sees                                                    | what happens           |
| ----------------------------------------------------------------------- | ---------------------- |
| a migration on disk with no ledger row, or an applied file edited since | **refuses to start**   |
| a ledger row with no file — the database is AHEAD of the image          | starts, with a warning |

The second is what a **rollback** looks like. Putting yesterday's image back is
a deploy you make while something is already broken, and a gate that blocks it
fires exactly when it must not. Migrations here are additive, so older code on a
newer schema runs.

To fix what the gate finds, run the same image with `SERVICE=migrate`. It
applies and exits — safe to run twice and safe to run while another copy is
doing it, because `up` holds an advisory lock. It is a one-off container rather
than a step inside the services, because a service that migrates on boot
migrates once per replica and once per restart loop, at whatever moment the
scheduler chose.

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

**In the Dockerfile** (`Dockerfile:117`), one `HEALTHCHECK` that branches on
`SERVICE`. Every sentence in this section said the opposite until 2026-08-22 —
that they were deliberately left out, that the dashboard answers `/health`, and
that the bot's should be disabled — and all three were wrong in the direction
that costs something: an operator following them would point a probe at a route
that does not exist and watch a healthy container restart-loop, or switch off
the bot probe and lose the only thing that can see a wedged poller.

A Dockerfile `HEALTHCHECK` does take precedence over the panel's, which is why
there is nothing to configure in Coolify. Leave those fields empty.

| Service     | What the image actually checks                                                                                                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingest`    | `GET /health` on `$PORT` (8787) — 200                                                                                                                                                                                                         |
| `dashboard` | `GET /api/v1/health` on `$PORT` (8788) — 200, **or 401**, because the route sits behind the session gate and a refusal still proves the process is answering. There is no `/health` on the dashboard                                          |
| `bot`       | the heartbeat file's mtime, fresher than 90s. The bot opens no port — it long-polls outward, which is why it needs no inbound rule, no certificate and no DNS name — so a file the poll loop touches every cycle is what "alive" means for it |

## Schema, before anything else

On 2026-08-17 the dashboard was deployed carrying the operator-login code while
`0021_operator_auth.sql` had never been run against the production database. The
entire symptom was `POST /api/v1/auth/login` answering 500 with `column
"password_hash" does not exist`. Nobody could sign in, and nothing said why —
the database had no record of which migrations it had seen, so a gap between
deployed code and deployed schema was invisible by construction.

There is a ledger now. `schema_migrations` holds a row per applied file with the
sha256 of what actually ran.

```bash
export DATABASE_URL=...
corepack pnpm --filter @shikoo/db schema status   # exit 1 if the DB is behind
corepack pnpm --filter @shikoo/db schema up       # apply what is pending
```

`status` is meant to be read by a script, not a person: **exit 0 means this
database matches this checkout**, 1 means it does not. Run it before deploying
and the class of failure above stops being possible.

It reports three kinds of disagreement, and the last two are worth knowing
about because nothing else can see them:

|           |                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pending` | a migration on disk with no row — the 2026-08-17 bug                                                                           |
| `DRIFT`   | an applied file edited afterwards. Two databases quietly stop being the same schema; `up` refuses                              |
| `UNKNOWN` | a row with no file: the database is ahead of this checkout, which is what a code rollback without a schema rollback looks like |

Everything runs under one Postgres advisory lock, so two replicas deploying at
the same moment cannot both apply the same migration. Each file gets its own
transaction with its ledger row inside it, so a run that dies halfway keeps what
it finished and re-running continues.

### Once per existing database: baseline

A database that predates the ledger has the schema and no rows to say so, and
`up` **refuses** rather than trying to `CREATE TABLE users` on a database that
already has 11,241 customers in it. Tell it what it already has, once:

```bash
corepack pnpm --filter @shikoo/db schema baseline 0021_operator_auth.sql
```

That records everything through that file as applied without running any of it.
Afterwards `up` applies only what came later.

**Still owed:** nothing yet stops a service from starting against a database it
is ahead of. Making startup or readiness depend on `status` turns today's silent
500 into a loud refusal to boot, which is the right direction for a payment
system and a real change in deploy behaviour — so it is a decision, not a
detail.

## Backups, and the drill that proves they are backups

What runs today, measured on 2026-08-19 rather than assumed:

|                    |                                                                       |
| ------------------ | --------------------------------------------------------------------- |
| schedule           | Coolify scheduled backup, `0 3 * * *` (03:00 UTC / 06:30 Tehran)      |
| what               | `pg_dump` custom format of the whole `shikoo` database                |
| where              | `/data/coolify/backups/databases/root-team-0/shikoo-postgres-<uuid>/` |
| retention          | 14 dumps locally, no day or size cap                                  |
| offsite            | **none — `save_s3=false`**                                            |
| encryption at rest | none beyond the host's own disk                                       |
| history            | 4 runs, all `success`, 188K → 200K                                    |

### RPO and RTO, stated so they can be argued with

- **RPO — 24 hours.** One dump a day. A failure at 02:59 UTC loses everything since
  03:00 the previous day. That is a deliberate choice for a shop whose database is
  under a megabyte, and it is the wrong choice the day real customer money is moving
  through it hourly. Revisit at cutover, not before.
- **RTO — minutes, and only for the database.** The restore itself takes seconds at this
  size. What actually costs time is the step below that the drill discovered.
- **The real exposure is neither.** Every copy sits on the same disk as the database it
  came from. A lost host is a lost shop. Turning on an S3 target closes it and needs a
  bucket and credentials nobody has picked yet — that decision is open, and until it is
  made this row is the honest answer to "are we backed up?".

### The drill

```bash
scp -i .notes/deploy_key migrations/verify_invariants.sql root@<server>:/tmp/
ssh -i .notes/deploy_key root@<server> 'sh -s' < deploy/restore-drill.sh
```

Restores the newest dump into a throwaway database beside the real one, and tears it
down afterwards. It never writes to the live database and never stops a service, which
is what makes it safe to run whenever — the property that decides whether it gets run
at all.

Restoring is not the check. Three things are: `pg_restore` finishes, the ledger in the
restored copy is readable, and `verify_invariants.sql` passes against it. The last one is
the point — a structurally perfect restore with a broken money invariant is worse than a
failed one, because it looks fine.

First run, 2026-08-19, against `pg-dump-shikoo-1787108404.dmp` (9h old, 200K): **passed**.
2 users, 1 order, 2 wallet entries, 10 audit rows, and every invariant green.

### What the first drill found

The restored copy's ledger read **24 applied**, because the dump was taken at 03:00 and
`0025`–`0027` were applied later that day. So a real restore lands a database three
migrations behind the deployed code — and the boot gate then refuses to start every
service, correctly.

**A restore is therefore two steps, never one:**

```bash
# 1. restore (into the real database this time, services stopped)
docker exec -i <pg> pg_restore -U postgres -d shikoo --clean --if-exists --no-owner --no-acl < <dump>
# 2. bring the schema up to the image that is deployed
docker run --rm -e SERVICE=migrate -e DATABASE_URL=... <image>
```

Skip the second and the containers stay down with `BLOCK … never applied here`, which is
the gate doing its job and reads like a broken restore. That is exactly the kind of thing
a drill exists to find on a quiet afternoon rather than during an outage.

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

Three lines in that config are load-bearing and none is obvious:

- **`proxy_set_header X-Real-IP $remote_addr;`** — the only thing that can tell
  one client from another once the request is inside the network. `$remote_addr`
  is the socket peer, so nginx **overwrites** whatever the client sent; the app
  then reads it because `TRUSTED_PROXY_IP_HEADER=X-Real-IP` says the operator
  vouches for that header, and reads nothing at all otherwise. Do not use
  `X-Forwarded-For` for this: nginx _appends_ to it, so a value the client
  invented stays in the string.

  ```nginx
  # inside each `location /` block, beside the Host line
  proxy_set_header X-Real-IP $remote_addr;
  ```

  Then set `TRUSTED_PROXY_IP_HEADER=X-Real-IP` on both the dashboard and the
  ingest application in Coolify. Until both halves are done the per-IP limits
  are off — ingest prints a warning at boot saying exactly that.

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

| Variable                    | Required | Notes                                                           |
| --------------------------- | -------- | --------------------------------------------------------------- |
| `DATABASE_URL`              | yes      | Add `?sslmode=require` when Postgres is on another host         |
| `TELEGRAM_BOT_TOKEN`        | yes      | Never logged. Never point this at the real bot from a test host |
| `TELEGRAM_API_BASE`         | no       | Defaults to `https://api.telegram.org`                          |
| `TELEGRAM_POLL_TIMEOUT_SEC` | no       | Default 25                                                      |

No `PORT`. The bot does not listen.

### `/etc/shikoo/dashboard.env`

| Variable                                              | Required                                           | Notes                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                        | yes                                                |                                                                                                                                                                                                                                                                                                                                                                         |
| ~~`ACCESS_AUD`, `ACCESS_ISSUER`, `ADMIN_ACCESS_AUD`~~ | **gone**                                           | Cloudflare Access was removed 2026-08-16. The panel has its own login; see «اپراتورها» below                                                                                                                                                                                                                                                                            |
| `ENV_NAME`                                            | **yes, and the process will not start without it** | One of `local`, `test`, `staging`, `production` — nothing else, and no default. It decides the origin check on writes, the session cookie's `Secure` flag and the bypass refusal below. Until 2026-08-18 it defaulted to `local`, so `prod`, `Production` and forgetting it entirely all switched those three off with nothing said                                     |
| `SPA_DIST`                                            | no                                                 | The payment hub SPA. Set absolutely in the image                                                                                                                                                                                                                                                                                                                        |
| `ADMIN_DIST`                                          | no                                                 | **The shop admin panel SPA**, served at `/admin`. One process serves both; this row was missing while the code read it, and an unbuilt SPA is a 500 rather than a failed deploy                                                                                                                                                                                         |
| `PORT`, `HOST`                                        | no                                                 | Default `8788`, and `HOST` is **`0.0.0.0` in the image** (`Dockerfile:81`), not the `127.0.0.1` this row claimed until 2026-08-22. It has to be: a container that binds loopback is unreachable from the proxy. Do not "correct" it in the panel                                                                                                                        |
| `INGEST_URL`                                          | recommended                                        | Printed into the SMS-relay phone configuration. There is no fallback any more: the routes that need it answer 503 `INGEST_URL_MISSING`                                                                                                                                                                                                                                  |
| `TRUSTED_PROXY_IP_HEADER`                             | recommended                                        | `X-Real-IP`. Names the header the terminator sets to the real client address — see «The edge» below, which must be configured to send it. Unset, the login's per-IP limit is skipped and a session stores no address, rather than either of them trusting a value the visitor typed — **and the process says so in the log at boot**, which it did not until 2026-08-22 |
| `TEST_ACCESS_USER`                                    | **`local` and `test` only**                        | Skips the login and pins an identity. Refused twice: the process will not start with it set anywhere else, and the identity path refuses it there again. Asked as an allowlist rather than "not production" — a staging box on the public internet with the login skipped is open in exactly the way this exists to prevent                                             |

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

| Variable                                                                   | Required                                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                             | yes                                                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ENV_NAME`                                                                 | **yes, and the process will not start without it** | Same four values as the dashboard. Here it is what forces `MIRZABOT_INTEGRATION_ENABLED` and `AUTO_MATCH_ENABLED` to be decided out loud — and while it defaulted to `local`, a typo meant nobody was asked, every bank SMS was stored, and no payment was ever verified                                                                                                                                                                                                                                                                                                                                                            |
| `TRUSTED_PROXY_IP_HEADER`                                                  | recommended                                        | `X-Real-IP`. Without it the per-IP limit on `POST /api/v1/sms` and on the claims endpoint is **off** — and the process says so in the log at boot. It is off rather than shared because the old shared bucket meant one busy phone rate-limited the whole fleet                                                                                                                                                                                                                                                                                                                                                                     |
| `INGEST_MAX_BODY_BYTES`                                                    | no                                                 | Default 8192. Enforced on real bytes before the body is in memory, on the declared length and on a chunked stream alike. **The process refuses to start on a value that is not a positive whole number** — `8kb` used to parse as `NaN`, and every comparison against NaN is false, so that typo removed the cap rather than widening it                                                                                                                                                                                                                                                                                            |
| `PORT`, `HOST`                                                             | no                                                 | Default `8787`, and `HOST` is **`0.0.0.0` in the image** (`Dockerfile:81`) — see the dashboard's row above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SWEEP_INTERVAL_MS`                                                        | no                                                 | Default 60000                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `DEVICE_RATE_LIMIT`, `IP_RATE_LIMIT`, `RATE_LIMIT_WINDOW_MS`               | no                                                 | Second layer; the edge is the first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `MIRZABOT_INTEGRATION_*`, `AUTO_MATCH_ENABLED`, `AUTO_FULFILLMENT_ENABLED` | while the PHP bot lives                            | HMAC integration with the legacy bot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ALERT_CHAT_ID`                                                            | recommended                                        | Where a fault is announced — `ingest.sms.failed`, `match.failed`, `settle.failed`, `provision.failed`, `notify.dead`, `webhook.dead`, `boot.schema_behind`, and nothing else. At most **one message an hour per event**, enforced by the `UNIQUE` on `bot_notifications.dedupe_key` rather than by a counter. Set it on all three services: an alert is a row in the queue, and the bot is what flushes it. On the bot it falls back to `REPORT_CHAT_ID`; on ingest and the dashboard it does not, because those have no report channel of their own. Unset means the events are still recorded in `app_events` and nobody is told. |
| `REPORT_CHAT_ID`                                                           | optional, **fallback only**                        | Where the shop's reports go — the nightly report and the anti-spam block notice, which read one field. The shop's own `setting.Channel_Report` wins wherever it is set; this covers a database whose settings have never been migrated, which is the practice box. Unset AND unmigrated means no report. A channel id is negative.                                                                                                                                                                                                                                                                                                  |

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
