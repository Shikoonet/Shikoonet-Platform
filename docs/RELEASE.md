# Releasing, and what «staging is ready» means

One direction, and nothing that skips a step.

```
merge to main ──▶ CI ──▶ Deploy Staging (automatic) ──▶ Promote Production (a person, on purpose)
                          builds ONE image                 promotes THAT digest
```

`Deploy Staging` builds the image and records the digest it deployed.
`Promote Production` has no digest input at all: it downloads that artifact and
promotes what staging actually ran. There is no path that rebuilds for
production and no field anybody can type an image reference into.

`Deploy Staging` can also be started by hand — Actions ▸ Deploy Staging ▸ Run
workflow — for a redeploy after a Coolify variable was fixed, or to roll the bot
out. **It takes no inputs at all.** It resolves `refs/heads/main` on the server,
refuses unless CI already passed on that exact commit as a push to main, and
then runs the same approval gate. This replaced pushing an empty commit purely
to make `workflow_run` fire.

## The order the owner actually acts in

Everything else in this file is a step; this is the sequence they happen in.
Nothing here is a phrase typed into a chat window — every gate is a workflow
with a branch restriction, an actor check and an audit trail.

1. Approve the release plan.
2. **Conditionally** create a Staging BotFather bot — only if neither existing
   `TELEGRAM_BOT_TOKEN` row is already a dedicated non-production bot (§2).
3. Merge the frozen pull request, once its pre-merge requirements pass.
4. Wait for post-merge CI and the automatic staging deployment of Dashboard and
   Ingest. The bot stays off: `STAGING_BOT_ENABLED` does not exist yet.
5. Enter the staging operator password at the hidden prompt (§1).
6. Enable `STAGING_BOT_ENABLED`, after §2 has proved a dedicated identity.
7. Run the no-input manual staging redeploy and verify the bot (§2).
8. Perform the real handset → ingest → dashboard SMS acceptance (§3).
9. Authorise and run the secure production-dump rehearsal, and record its
   attestation for the merged sha and the exact digest staging accepted.
10. Run **Prepare Production** — candidates, migration, temporary domains.
    Customers are still on the old applications.
11. Read the preparation evidence, then run **Cutover Production** — the only
    step that moves live domains and the bot.

Steps 10 and 11 are two separate dispatches on purpose. A production release
has one irreversible step and several reversible ones, and putting them behind
one button means the reversible ones are only ever seen in hindsight.

The rest of this file is the part that is not automatic.

---

## 1. The first operator on a fresh environment

A new environment has zero rows in `access_users`. The panel is not broken —
it answers `401 invalid_credentials` correctly, because there is no account for
it to answer anything else about. The screen that creates operators is behind
the login, so the first one has to come from outside it, once.

Run it **inside the running dashboard container**, which is the only place that
already holds `ENV_NAME` and `DATABASE_URL`:

```bash
# on the deployment host. The container name changes on every deploy; the
# application's Coolify uuid does not, and it is the container's `coolify.name`
# label — so this finds the right container without anybody reading a name off
# a list.
DASH=$(docker ps --filter 'label=coolify.name=3scafhzf40ucpgvoqbms2217' --format '{{.Names}}')

docker exec -it "$DASH" \
  sh -c 'cd /app && corepack pnpm --filter @shikoo/dashboard operator bootstrap you@example.com ADMIN'
```

`-it` matters: without a terminal the prompt cannot hide what is typed, and the
password is echoed to the screen.

It asks for the password twice, hidden, and that is the only place the password
is ever typed. It is never an argument — `ps` shows arguments to every user on
the box — never an environment variable, and never printed back.

What it does, in one step, so a run that dies half way leaves nothing usable
rather than an account nobody can sign in as:

| | |
| --- | --- |
| refuses unless `ENV_NAME` is exactly `staging` | it writes an ADMIN row; a typo must not write it somewhere else. `--env production` is how you say production out loud |
| refuses an address that is not one, a role outside `ADMIN`/`REVIEWER`/`READ_ONLY`, a password under 12 characters or with fewer than 4 distinct ones | before any statement is prepared |
| refuses an operator that already exists | `--update` is how you say «yes, change that account's password», and it revokes every session the old password opened |
| writes `audit_logs` either way | `operator.bootstrap.created` / `.updated`, `actor_role = SYSTEM`, and the row names the account and its role and nothing else |

Then check it, from the same container:

```bash
docker exec "$DASH" sh -c 'cd /app && corepack pnpm --filter @shikoo/dashboard operator list'
```

### The acceptance test for «somebody can sign in»

`operator-login.test.ts` proves the login route's behaviour against `app.fetch`
— the routes agreeing with themselves. What it cannot prove is that the
container in front of you has a database with an account in it, a cookie that
survives the proxy and a session the next request actually finds. That needs a
deployment, so it is a script rather than a test:

```bash
docker exec "$DASH" sh -c 'cd /app && corepack pnpm --filter @shikoo/dashboard verify-login'
```

It creates its own throwaway operator, generates its password in memory, and
deletes the account whatever happens — so it needs no credential to run and
leaves none behind. Eight checks, and all eight must say PASS:

```
PASS  no session is refused                    — 401
PASS  wrong password is refused                — 401
PASS  correct password signs in                — 200
PASS  cookie is HttpOnly and SameSite
PASS  the session reaches a protected route    — 200
PASS  logout is accepted                       — 200
PASS  the cookie is dead after logout          — 401
PASS  no live session row is left              — 0 live
```

The last two are the ones worth having. A logout that only clears the cookie
looks identical from a browser; this replays the same cookie value and requires
the server to refuse it on its own.

---

## 2. The staging bot

The bot is not deployed by default and that is deliberate. Telegram gives each
update to exactly one `getUpdates` caller, so a staging bot holding the
production token does not fail — it quietly takes messages away from the bot
customers are talking to.

**Before turning it on**, two things must be true, and only a person can
establish them:

1. **The staging application has a bot of its own.** Not the production token.

   Before the first boot there is no check that does not involve reading a
   token, and reading one is worse than the risk it measures — so this one is
   yours: the `TELEGRAM_BOT_TOKEN` on the staging application must be a bot you
   created for staging in @BotFather, and the production application's token is
   the shop's bot. If you are not certain, make a new bot rather than guessing.

   After the first boot it stops being a matter of certainty. Every bot asks
   Telegram who it is and writes its own `@username` into its database:

   ```sql
   SELECT value FROM settings WHERE scope = 'bot' AND key = 'username';
   ```

   Run it against the staging database and the production database. Two
   different handles means two different bots. **The same handle means one
   token in two places** — stop the staging bot immediately, because from that
   moment the two are splitting the shop's updates between them. Production's
   handle as of 2026-08-28 is `Test_Shikoo_bot`; staging must not be that.

   This is also the first thing to check after the rollout, and it is item 13
   of the checklist below for that reason.

2. **No variable is defined twice on the application.** Coolify accepts a
   variable that is already there instead of replacing it, and a form submitted
   twice leaves two rows per key. The container then gets whichever row is
   written last — which, for `DATABASE_URL` and `TELEGRAM_BOT_TOKEN`, decides
   which environment the bot joins. `deploy.sh` refuses to deploy an
   application in that state and names every duplicated key; delete the extras
   in the Coolify panel, keeping the ones with the staging values.

Then turn it on, which is a repository variable rather than a pull request:

```
Settings ▸ Secrets and variables ▸ Actions ▸ Variables
  STAGING_BOT_ENABLED = true
```

Anything but the exact string `true` is off, in the workflow and again in
`deploy.sh`. Turning it back off is the same switch.

The next `Deploy Staging` deploys the bot last, after the migration and after
ingest and dashboard are healthy. Verify:

```bash
BOT=$(docker ps --filter 'label=coolify.name=icmjwronjw3ltx0gdrtmyfve' --format '{{.Names}}')
docker logs "$BOT" 2>&1 | grep -E 'boot\.(polling|poller_lock_wait)'
docker inspect "$BOT" --format '{{.State.Health.Status}} restarts={{.RestartCount}}'
```

- `boot.polling` reached, `healthy`, `restarts=0` — a restart loop is a bot that
  is not staying up, not a slow one.
- **Exactly one poller**, asked of the database rather than of `docker ps`:

  ```sql
  SELECT count(*) FROM pg_locks WHERE locktype = 'advisory';
  ```

  One, in the staging database, and still exactly one in the production
  database. `singleton.ts` holds that lock for the life of the process, so two
  rows in one database is two pollers and a bug.
- And the bot's `@username` from the query above is the staging one.

---

## 3. SMS ingest

TLS, the health endpoints, the body cap and the refusal of an unauthenticated
device can all be checked from anywhere:

```bash
curl -s https://sms-dev.chopon.uk/health                                    # {"ok":true}
curl -s https://sms-dev.chopon.uk/version                                   # env: staging, and the deployed sha
head -c 1500000 /dev/zero | tr '\0' a > /tmp/big
curl -so /dev/null -w '%{http_code}\n' -XPOST --data-binary @/tmp/big \
     -H 'content-type: application/json' https://sms-dev.chopon.uk/api/v1/sms   # 413
curl -s -XPOST -H 'content-type: application/json' \
     -d '{"apiKey":"not-a-valid-key-000","deviceId":"probe","deviceName":"probe","message":"probe","sender":"probe"}' \
     https://sms-dev.chopon.uk/api/v1/sms                                   # 401 unauthorized
```

Note the shape of the last one: the body is validated before the credential is,
so a malformed probe answers `400 invalid_body` and proves nothing about
authentication. A well-formed body with a bogus key is what tests the refusal.

### DEFERRED: a real SMS from a real handset

**What is not tested:** an Android handset receiving a bank SMS, relaying it to
`POST /api/v1/sms`, and the panel showing the resulting transaction candidate.

**Why:** the Android relay app is unfinished. Nothing in this repository can
stand in for it — a synthetic POST exercises the endpoint, which is already
covered above, and says nothing about the half that does not exist.

**Owner:** the head admin, together with whoever finishes the relay.

**Acceptance test, exactly:**

1. A staging device is registered in the panel and its credential is installed
   in the relay build. Not a production device, and not a production credential.
2. A real SMS arrives on that handset from a bank sender the parser knows.
3. Within a minute, `raw_sms_events` in the **staging** database has the message,
   with the handset's `device_id`.
4. A `transaction_candidates` row exists for it with the amount parsed from the
   Persian text.
5. The panel's transactions screen shows it.
6. Re-sending the identical SMS creates no second candidate — the dedupe is the
   point of the checksum.
7. The production database has gained nothing during any of it.

**Until then this is a blocker for production promotion**, because auto-verified
payment is the whole reason ingest exists. It can be deferred past promotion
only by the owner saying so explicitly, accepting that every payment is
approved by hand in the panel until the relay ships.

---

## 4. The staging acceptance checklist

Everything above, in the order it has to hold. Staging is release-ready when
every line is true on the same deployment.

| # | Check | How |
| --- | --- | --- |
| 1 | CI is green on the merge commit | `Required Quality Gate`, 10/10 |
| 2 | `Deploy Staging` succeeded on that commit | the run's own conclusion |
| 3 | Both apps run the digest that run built | `docker inspect --format '{{.Config.Image}}'` is `…@sha256:…`, the same digest in the run's `staging-digest` artifact |
| 4 | Both apps report the merge commit | `GET /version` on ingest; `APP_VERSION` on the dashboard |
| 5 | `ENV_NAME=staging` on every staging container | `docker inspect` — and no staging container resolves the production database |
| 6 | Staging and production are different clusters | `SELECT system_identifier FROM pg_control_system()` differs |
| 7 | The migration ledger matches the tree | `SELECT count(*) FROM schema_migrations` equals `ls migrations/*.sql` minus `verify_invariants.sql` |
| 8 | TLS on both hostnames | a certificate whose CN is the hostname and whose dates cover today |
| 9 | Protected APIs refuse without a session | `401` on `/api/v1/version`, `/api/v1/users`, `/api/v1/settings` |
| 10 | An operator exists | §1 |
| 11 | The login chain works end to end | `verify-login`, 8/8 |
| 12 | Ingest refuses an unauthenticated device and caps the body | §3 |
| 13 | The bot, **if** it is enabled | §2 — polling, healthy, exactly one lock, its own `@username` |
| 14 | Real-SMS end-to-end | DEFERRED, §3 — the one line here that may be false, and only with the owner's word |

---

## 5. Promotion

Only when the checklist holds, and never as a side effect of anything.

```
Actions ▸ Promote Production ▸ Run workflow
  confirm:        PROMOTE      (typed in full)
  staging_run_id: optional — the last successful staging run on main by default
```

`workflow_dispatch` only, from `main` only, by the owner only, and the digest
comes from the staging run's artifact rather than from anybody's keyboard. The
manifest is checksummed before a field of it is read, and cross-checked against
the run it claims to come from.

Production is not touched by anything else in this repository.

### What promotion additionally requires

A production-dump rehearsal, recorded as a checksummed attestation and
verified before any credential is in scope. It binds the merged sha, the CI
run, the Deploy Staging run, the exact digest, `49/49` dump suites, `32/32`
invariants, the financial comparison, the restore result and duration, and
whether the CURRENT production image still serves the migrated schema.

That last field is what keeps image rollback valid. If it says `fail`, rolling
back to the old image is not a recovery path and only a database restore is —
which has to be known before the migration runs, not discovered after.

The attestation cannot be produced before the merge: the digest it binds does
not exist until staging has deployed. `deploy/write-dump-attestation.sh` writes
it on the secure host; `deploy/verify-dump-attestation.sh` refuses a promotion
whose attestation is missing, malformed, stale, or for a different release.

The dump itself never leaves that host. `dump_id` is a sha256 and a date, and a
value shaped like a path is refused by the writer.

### Splitting promotion in two

`Prepare Production` and `Cutover Production` replace the single promotion for
a release that changes the schema. Preparation creates the candidates stopped,
migrates, and proves the candidates on temporary domains while customers stay
on the old applications; cutover moves the domains and hands the bot over.

Between them, `deploy/write-preparation-manifest.sh` records what preparation
observed and created — including which application currently answers on each
live domain — and `deploy/verify-preparation-manifest.sh` re-checks all of it
at cutover. Any drift aborts: a schema that moved, an unhealthy candidate, a
domain somebody already repointed, native Auto Deploy switched back on, a bot
lock count that is not exactly one, a vanished backup.

**Not yet implemented:** the two workflows' on-box execution. Creating the
Coolify candidate applications needs the Coolify API token, which is root-only
on the deployment host, and a write-API payload shape that has not been
verified against this Coolify version. The gates, both manifests and all of
their refusals exist and are tested; the step that creates and moves
applications does not, and is deliberately absent rather than guessed at.
