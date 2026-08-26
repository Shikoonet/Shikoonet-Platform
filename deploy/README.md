# Deploying — three services that do not have to share a host

> **Two machines are described in this file.** Everything up to «CI/CD» was
> written for the earlier server — nginx `shikoo-tls`, port `:9443`, the
> `mahamsteel.ir` names, certbot with DNS-01. The server the pipeline deploys
> to today is a different box: Coolify **4.3.11**, its own **Traefik** on
> `:80`/`:443`, and the `chopon.uk` names. Inspected 2026-08-26; see «CI/CD».
> Where the two disagree, the CI/CD section is the one measured against a live
> machine.


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
`shikoo`. DNS-01 rather than HTTP-01 because that would need `:80`.

**Both halves of what this paragraph used to claim were false, and both were
measured false on 2026-08-23 rather than argued about.** It said renewal "must
reload the container — a `renewal-hooks/deploy` script does it — and it needs a
DNS API token that outlives the certificate", in the present tense, as though
describing the box. What was actually there:

- `renewal-hooks/deploy/` held `reload-nginx.sh` and `reload-nginx-cdn.sh`, and
  **both reload the host nginx**, which serves neither of our hostnames. No hook
  touched `shikoo-tls`. A successful renewal would have reported success and
  left the expired certificate on the wire. `deploy/reload-shikoo-tls.sh` in
  this repo is the missing hook; install it with the `install -m 0755` line in
  its header.
- the DNS token did **not** outlive the certificate. It expired
  `2026-08-22T23:59:59Z`; the certificate runs to `2026-11-15`. `certbot renew
  --cert-name shikoo --dry-run` answers
  `Error determining zone_id: 9109 Invalid access token`.

Two things follow for whoever sets this up next:

**The token must have no expiry.** A `Zone:DNS:Edit` token on `mahamsteel.ir`,
written to `/root/.secrets/cloudflare.ini` as `dns_cloudflare_api_token = …`.
Cloudflare's default when you create one is a short window, and the wrong end of
that window is silent: certbot's timer runs twice a day and writes its failure
to `/var/log/letsencrypt/`, which nothing reads.

**Check the token by its status, not by `success`.** `GET
/client/v4/user/tokens/verify` answers `"success": true` for an EXPIRED token —
the call succeeded, the token did not. The field that matters is
`result.status`, which must be `active`:

```sh
curl -s -H "Authorization: Bearer $CF_TOKEN"   https://api.cloudflare.com/client/v4/user/tokens/verify |
  grep -o '"status":"[a-z]*"'
```

After replacing the token, prove the whole chain rather than the token alone:
`certbot renew --cert-name shikoo --dry-run` must reach `Congratulations`, and
after a real renewal `openssl s_client -connect shikoo.mahamsteel.ir:9443` must
show the NEW `notAfter` — that second half is the part the missing hook broke.

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

## CI/CD — build once, verify once, promote the same digest

Until 2026-08-26 every deploy was a person in the Coolify panel, and Coolify
rebuilt the image from git each time. That is one artifact tested and a
different artifact deployed — same source, different bytes, and nothing able
to say afterwards which build is actually running. The pipeline below exists
to close exactly that gap, and nothing wider.

```
feature branch ──▶ pull request ──▶ gate · e2e · workflows-lint     no secrets, no deploy
                                          │
                        merge to main ────┤
                                          ▼
                                      publish            build → the 3 artifact gates → push
                                          │              ghcr.io/<repo>:sha-<commit>  ⇒ DIGEST
                                          ▼
                                   deploy-staging        automatic, no approval
                                          │
                            a person runs │ «Promote to production»
                                          ▼
                                      promote            same DIGEST, never rebuilt
```

The digest is the identity all the way through. A tag is a pointer for humans
reading a registry listing; `latest` does not exist here at all.

### Two environments, one machine, nothing shared

The existing server — the one `docs/threat-model.md` describes — is the
**staging** box. It was called "practice" in the older sections of this file;
same machine, clearer name. Production is a
second, entirely separate deployment which does **not exist yet**, and which
this pipeline can address the day it does, initially on the same host and
later on another one by changing GitHub Environment values alone.

Separate, per environment, with no exceptions:

| | staging | production |
| --- | --- | --- |
| Postgres | the existing Coolify resource | its own Coolify database resource, own volume, own credentials, own backups |
| Docker network | the existing `coolify` network | its own network |
| Coolify project/environment | `shikoo` / `staging` | `shikoo` / `production` |
| env files | `/etc/shikoo/staging/` | `/etc/shikoo/production/` |
| deploy history | `/var/lib/shikoo/staging/deployed` | `/var/lib/shikoo/production/deployed` |
| Telegram bot token | the test bot | the real bot |
| SMS device credentials | test devices only | real devices |
| operators | staging rows | production rows |
| hostnames | `shikoo.chopon.uk`, `sms.chopon.uk` | its own names, its own Traefik certificates |

`deploy.sh` refuses to run if the environments are not actually separate: each
env file's `ENV_NAME` must match the environment being deployed, and
`DATABASE_URL` and `TELEGRAM_BOT_TOKEN` are compared **as sha256 hashes**
against the other environment's files — so the collision is caught and neither
value is ever printed. A shared bot token would mean two pollers on one
Telegram token; a shared database would mean staging test data in production.

### Coolify keeps the containers — it just stops rebuilding them

Coolify writes the Traefik labels that put `shikoo.chopon.uk` and
`sms.chopon.uk` in front of these services, and renews their certificates
through ACME. Taking the containers away from it would mean owning fifteen
labels per service and the ACME wiring by hand, forever, to gain nothing.

The one thing it could not do was deploy an image built somewhere else. The
three applications were `dockerfile` build-packs — every deploy rebuilt from
git, so the artifact CI tested was never the artifact that ran. That is the
whole change, and it is three fields on an application record:

| field | value |
| --- | --- |
| `build_pack` | `dockerimage` |
| `docker_registry_image_name` | `ghcr.io/shikoonet/shikoonet-platform` |
| `docker_registry_image_tag` | **`sha256-<hex>`** — note the hyphen |

The hyphen is not a typo and not a workaround. `ApplicationDeploymentJob.php`
lines 1191-1193 in the installed version read a tag beginning `sha256-` and
pull `name@sha256:<hex>`: a digest, not a tag. It is Coolify's own spelling for
a digest deploy, read out of the source of **4.3.11** rather than assumed.

Applications are addressed by **UUID**, which is stable across deploys, and
their containers are found by the `coolify.name` label, which carries that same
UUID. Neither is a container name — those change every deploy, which is the
trap this project has already been caught by twice.

| application | UUID |
| --- | --- |
| `shikoo-bot` | `3xetld1oi3x7viq8cr8is0ls` |
| `shikoo-dashboard` | `huneuqvzyw0cjd4u0f7s37cf` |
| `shikoo-ingest` | `d9ulbwkdjpvg2ajalecruxzh` |

The API is called on **`http://localhost:8000`, from the server itself**, over
SSH. That is the reason SSH is in this pipeline at all: the Coolify panel
answers plain HTTP, so a token sent to it from GitHub would cross the internet
in clear text. Called from localhost, the token never leaves the machine. If
the panel is ever put behind TLS, the SSH hop can go away.

### The deploy sequence

`deploy/host/deploy.sh <env> <image@digest> <commit-sha>`, run on the server
over SSH by the deploy workflow, which copies the script up from the commit
being deployed first — a deploy script that lives only
on the server is a script nobody reviews.

1. `flock` on `/var/lock/shikoo-deploy-<env>.lock`. Fails fast rather than
   queueing: GitHub already queues, so a second copy here means a hand-run
   racing CI and should be looked at.
2. The four env files exist; `ENV_NAME` agrees; the cross-environment
   credential check passes; `docker login` with a **server-side** GHCR
   credential — GitHub never sends a registry token per run.
3. The previous digest is read from the state file. That is the rollback
   candidate.
4. Pull by digest, then check `org.opencontainers.image.revision` on the
   pulled image equals the commit sha that was passed. A digest that was not
   built from that commit is refused.
5. **Migrate**, in a one-off `SERVICE=migrate` container, *before any service
   is touched*. If it fails the deploy stops here — nothing changed, the
   running containers are still consistent with the schema they booted on, and
   there is nothing to roll back.
6. `schema gate` against the migrated database — `gate`, not `status`, so a
   rollback deploy onto an ahead schema is a warning rather than a refusal.
7. `ingest` and `dashboard`, then wait for the image's own health checks.
8. **The bot last, by itself.** `up -d` on a single-replica service is a stop
   of the old container followed by a start of the new one, so the old
   poller's advisory-lock session is gone before the new one asks for it.
9. Smoke tests from a throwaway container **on the same network**, resolving
   the same aliases nginx resolves: `ingest`'s `/version` must return the
   deployed commit, the dashboard's health must answer 200, and
   `/api/v1/version` must answer **401** — proof the session gate did not fall
   off a route.
10. Exactly one advisory-lock holder in that environment's database
    (`classid = 1399324672`, the namespace in `apps/bot/src/singleton.ts`). Two
    means a deploy overlapped; zero means the bot is not polling however
    healthy it looks.
11. No container publishes a host port. There is no firewall on this box, so a
    published port is a public port.
12. Append `<time> <digest> <sha>` to the state file.

`deploy/host/deploy-test.sh` proves those steps against real containers — a
throwaway database, registry and network it builds and removes itself. It runs
in CI on every change, because the interesting half of that script is the half
that only executes on a bad day:

```bash
docker build -t shikoo-ci .
deploy/host/deploy-test.sh shikoo-ci      # ~3 minutes, 9 checks
```

Any failure after step 7 restores the previous digest, re-runs the health
checks against it, and still exits non-zero — a successful rollback is not a
successful deploy. The summary says which of three things happened: rolled
back, rollback also failed, or no rollback candidate existed.

**The schema is never rolled back.** Migrations are additive and the boot gate
only warns when the database is ahead, which is exactly what makes yesterday's
image deployable while something is already wrong.

### Secrets and variables — names only

GitHub, per environment (`staging` and `production` carry the same names with
different values, which is what makes moving production to another host a
configuration change rather than a redesign):

| Name | What it is |
| --- | --- |
| `DEPLOY_HOST` | the server this environment lives on |
| `DEPLOY_PORT` | its SSH port |
| `DEPLOY_USER` | `shikoo-deploy` |
| `DEPLOY_SSH_KEY` | that user's private key — **a dedicated key, never the root key from `.notes/`** |
| `DEPLOY_KNOWN_HOSTS` | the host's public key line, pinned from a session you trust |

Nothing else is sent from GitHub. In particular the registry pull credential
and the Coolify database container id stay on the server, in
`/etc/shikoo/<env>/deploy.env`:

| Name | What it is |
| --- | --- |
| `GHCR_USER`, `GHCR_TOKEN` | a fine-grained token with `read:packages` **only** |
| `DB_CONTAINER` | that environment's Postgres container |
| `SHIKOO_NETWORK` | that environment's docker network |
| `PGUSER` | optional, defaults to `postgres` |

The application secrets — bot token, database password, HMAC key — never enter
GitHub at all. They stay in `/etc/shikoo/<env>/{bot,ingest,dashboard}.env`,
root-owned and group-readable by the deploy user.

### One-time setup

From the machine that holds the server key:

```bash
# 1. a key that exists only for this
ssh-keygen -t ed25519 -f ./shikoo-deploy-key -C 'deploy@github' -N ''

# 2. the deployment user (as root, once)
scp deploy/host/provision-deploy-user.sh root@<host>:/tmp/
ssh root@<host> "bash /tmp/provision-deploy-user.sh \"$(cat ./shikoo-deploy-key.pub)\""

# 3. pin the host key from a session you trust — not with ssh-keyscan at deploy time
ssh-keyscan -p 22 <host> 2>/dev/null

# 4. the GitHub environments and their secrets
gh api -X PUT repos/Shikoonet/Shikoonet-Platform/environments/staging
gh api -X PUT repos/Shikoonet/Shikoonet-Platform/environments/production
for e in staging production; do
  gh secret set DEPLOY_HOST        --env "$e" --body '<host>'
  gh secret set DEPLOY_PORT        --env "$e" --body '22'
  gh secret set DEPLOY_USER        --env "$e" --body 'shikoo-deploy'
  gh secret set DEPLOY_SSH_KEY     --env "$e" < ./shikoo-deploy-key
  gh secret set DEPLOY_KNOWN_HOSTS --env "$e" --body '<the ssh-keyscan line>'
done
rm ./shikoo-deploy-key           # GitHub has it; this machine does not need it
```

Then write `/etc/shikoo/staging/*.env` by copying each Coolify application's
environment verbatim, with `ENV_NAME=staging` and the `MIRZABOT_*` /
`AUTO_*` switches decided out loud — ingest refuses to boot without them.

### Cutover — switching the applications from git-build to digest

Do this once, in this order, with the merge pipeline already green:

1. Create the API token (Coolify → Keys & Tokens → API tokens) with the
   abilities `read`, `write` and `deploy`, and write `/etc/shikoo/staging/deploy.env`
   as shown above. Nothing else needs the token, and it never leaves the box.
2. Let a merge run to the end of `publish`. Note the digest from the summary.
3. `deploy.sh staging <image@digest> <sha> --dry-run` — it verifies the token,
   the image and its revision label, and that all three applications answer,
   then stops before the migration.
4. Run it for real, by hand the first time, and watch it. It is the run that
   flips each application from `dockerfile` to `dockerimage`.
5. Check from outside: `https://shikoo.chopon.uk/admin/` answers and
   `https://sms.chopon.uk/health` returns 200. Traefik routes by labels Coolify
   still owns, so this should be unchanged — but it is the one thing this move
   could break, so look rather than assume.
6. Turn off automatic deploys on the three applications, so nothing redeploys
   them from git behind the pipeline's back.

**Going back** is a Coolify UI change, not a code change: set the application's
build pack to Dockerfile and deploy. Worth knowing before step 4 rather than
during it.

### Rollback

```bash
gh workflow run rollback.yml -f environment=staging -f image=<digest-or-commit-sha>
```

The history is on the server: `/var/lib/shikoo/<env>/deployed`, one line per
successful deploy, newest last. Either half of the pair works as input — the
workflow resolves the other from the image's own label.

The database is not part of this. A schema rollback in a system holding
payments is a data-loss decision and belongs to a person, with the restore
drill above, not to a workflow.

### Branch protection — not configured, and it cannot be today

`gh api repos/Shikoonet/Shikoonet-Platform/branches/main/protection` answers
**403: «Upgrade to GitHub Pro or make this repository public»**. Rulesets
answer the same. So merging into `main` is **not** blocked by anything right
now, no matter how green CI is, and the same limitation means the
`production` environment cannot have a required reviewer. Running the promote
workflow by hand is the approval instead.

The moment the repository is on a plan that allows it, the required checks are
exactly these three names — they are stable and safe to write into settings:

```
gate
e2e
workflows-lint
```

```bash
gh api -X PUT repos/Shikoonet/Shikoonet-Platform/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["gate", "e2e", "workflows-lint"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

and on the `production` environment, add yourself as a required reviewer —
after which `promote.yml` becomes a request rather than the decision itself.

### Production is not enabled, and these are the reasons

The pipeline can address production. Production must not receive real customer
data until every one of these is resolved — they are recorded here rather than
fixed, because fixing them is a separate piece of work with its own decisions:

- **The production environment does not exist yet**: no database resource, no
  network, no hostname or certificate, no terminator container, no bot token,
  no device credentials, no operator rows, no env files.
- **Coolify's panel is on `:8000` over plain HTTP** — its root token crosses
  the wire in clear text on every call (`docs/threat-model.md`).
- **There is no firewall.** `ufw` is not installed and `DOCKER-USER` is empty,
  so any published port is public. The deploy script asserts none appear; that
  is a smaller claim than a firewall.
- **Only the root SSH key exists.** Until `provision-deploy-user.sh` has run,
  CD has no way in that is not root — this is a blocker by design.
- **Tokens need rotating.** The Coolify and Cloudflare tokens have been pasted
  into chat; the Coolify token expires 2026-09-16 and the Cloudflare DNS token
  expired 2026-08-22, which means certificate renewal fails silently today.
- **No offsite backup** — `save_s3=false`, every copy on the same disk as the
  database it came from.
- **The TLS renewal hook is not installed** on the server, so a renewed
  certificate is not served until nginx is reloaded by hand.
- **Capacity is unmeasured.** Two environments on one VPS is a decision that
  needs numbers. Measure before creating production:
  ```bash
  free -m; df -h /var/lib/docker; docker system df; docker stats --no-stream
  ```
  Each service was 49–54 MB in 2026-08; a second Postgres plus three services
  is roughly another 400 MB plus its volume. **If it does not fit, production
  goes on a second VPS** — it does not get merged back into staging. Moving it
  is a change of `DEPLOY_HOST` and the server-side env files, nothing else.
- **Rollback has been proven in simulation, not on this server.** The three
  failure paths are exercised in a throwaway environment; the first real one
  should be watched by a person.

### What has been proven, and what has not — 2026-08-26

Written down because "the workflow files exist" and "the pipeline works" are
different claims, and only one of them is true today.

**Exercised, with output:**

| | |
| --- | --- |
| `actionlint` on all four workflows | clean |
| `shellcheck` on every script in `deploy/` | clean |
| the image builds and carries its revision label | yes |
| the three artifact gates, against that image | pass |
| all four `SERVICE` values | `migrate` idempotent, `ingest` 200 on `/health`, `dashboard` 200 on `/api/v1/health`, an invalid value refused |
| `pnpm typecheck` · `pnpm lint` | exit 0 |
| `pnpm test` | **2,272 passed, 52 skipped, 180 files, 9 packages** — the skips are the MySQL tests, which need the production dump and skip themselves under `CI` |
| `schema up` + `status` + `verify_invariants.sql` | 31 migrations, **32 invariants PASS** |
| Playwright | **100 passed**, on schema → `seed:sim` → e2e |
| `deploy/host/deploy-test.sh` — **9 checks**, part of CI | pass |
| a failing migration | stops the deploy with **zero** services touched and no state written |
| the digest that reaches Coolify | `build_pack=dockerimage` and `docker_registry_image_tag=sha256-<hex>`, ingest first — asserted against a fake API that records every call |
| two deploys at once | the second dies immediately on the lock and succeeds once it is released |
| a mutable tag as the image argument | refused |
| a digest whose commit label disagrees | refused |
| the two environments sharing a bot token | refused |

**Not exercised, and why:**

- **No deployment to any server has happened.** The deploy key, the Coolify
  token and the server address live on the operator's other machine. Every
  server-side step above is a runbook, not a completed action.
- **No GitHub Environment or secret has been created.** The names are settled
  and the `gh` commands are above; the values are not this session's to hold.
- **`publish` has never pushed to GHCR** — it needs a merge to `main`, and
  nothing here has been pushed.
- **Branch protection is not configured and cannot be** on this plan (403).
  Merging into `main` is unprotected right now.
- **Production deployment is disabled** in the only sense that matters: the
  environment does not exist, so `promote.yml` has nothing to deploy to.
- **The deploy-and-rollback path has not run against a real Coolify.** The
  harness fakes the API deliberately — a fake that also started containers
  would be a reimplementation, and testing a reimplementation proves nothing.
  So the first real deploy is a `--dry-run` followed by a watched run, and the
  rollback is unproven on this server until a deploy fails or is made to.
