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


## Green main → staging → production, at one immutable digest

**This is the live path**, and it replaced the polling timer described in the
next section. `.github/workflows/deploy-staging.yml` fires on a successful CI run of
`main`, builds ONE image, pushes it to `ghcr.io/shikoonet/shikoonet-platform`,
and hands the digest to `deploy/deploy.sh` over SSH — first to `staging`, then
to `production`. Both environments run the identical bytes, and `deploy.sh`
refuses any digest whose `org.opencontainers.image.revision` label is not the
commit it was told to deploy.

`deploy.sh` runs ON the box as `shikoo-deploy` and owns everything a deploy
decides: migrations before any application is touched, the bot last, the smoke
test, the bot-singleton check, and the rollback. `deploy/over-ssh.sh` is the
GitHub half — it copies `deploy.sh` up from the commit being deployed, so what
runs is always what was reviewed.

### Two approval modes, and why the second one exists

`DEPLOY_APPROVAL_MODE` in `.github/workflows/deploy-staging.yml`. There is **no
default**: unset, empty or misspelled denies. Both tempting defaults are wrong —
`team` turns a typo into a deploy that never runs, `solo` turns a typo into a
deploy nobody reviewed.

| mode | what stands in for review |
| ---- | ------------------------- |
| `team` | an `APPROVED` review on the final head from a human who is not the author |
| `solo` | the allowlisted owner **wrote** the PR **and merged** it, and CI passed on the final head **and on the merge commit** |

`solo` exists because the team policy became unsatisfiable. This repository has
one person with access, so "a human other than the author" is a condition
nobody can meet, and the gate denied four merges in a row — correctly, and
uselessly. The fix was **not** to accept any merged PR, which would have deleted
the provenance chain. Solo mode replaces the review requirement with the
narrowest thing that is checkable for one person, and **no approval is
invented**: the audit line reads `policy=solo-owner` and says in words that
nobody else reviewed it.

Both modes still refuse a direct push, an unmerged PR, an ambiguous PR
association, an outstanding `CHANGES_REQUESTED`, a red `Required Quality Gate`,
a moved `main`, and any API error.

`DEPLOY_APPROVAL_MODE` and `SOLO_DEPLOY_OWNER` live in the workflow file rather
than in a repository variable **on purpose**: a variable can be changed in the
settings UI, silently, with no diff and no review. Who may ship unreviewed code
is exactly the decision that must not be changeable that way. Set the mode back
to `team` the day a second regular reviewer joins — nothing else changes, and
the team path stays tested.

Which policy shipped a given release is recorded on the box, as a fourth field
in `/var/lib/shikoo/<env>/deployed`.

### Docker Image is an application TYPE, not a build strategy

Coolify 4.3.11 offers exactly five build strategies, and this is the list from
its own view (`livewire/project/application/general.blade.php`):

```text
railpack · nixpacks · static · dockerfile · dockercompose
```

**`dockerimage` is not among them, and no UI dropdown or API PATCH can set it.**
It is decided when the application is created, by
`Livewire/Project/New/DockerImage.php`, and an application created from a Git
source stays a Git application for life. `BuildPackTypes` — the enum the API
validates against — does not contain it either, which is why any PATCH carrying
it returns:

```json
{"message":"Validation failed.",
 "errors":{"build_pack":["The selected build pack is invalid."]}}
```

So `deploy.sh` never sends it. It **asserts** the type instead, before the
migration, and the refusal does not suggest a setting to change, because there
is none:

> `ingest is a 'dockerfile' application, not a Docker Image application. Coolify
> would clone the repository and rebuild… A Docker Image application has to be
> created beside this one and cut over.`

**Why the assertion is load-bearing.** `ApplicationDeploymentJob` dispatches on
the type: `deploy_dockerimage_buildpack()` pulls the image and never clones,
while a Git application runs `deploy_dockerfile_buildpack()`, which clones and
rebuilds and ignores `docker_registry_image_name` entirely. A Git application
asked to deploy would go green, report a healthy container, and be running a
tree this pipeline never verified.

The same path is what makes digests work at all — Coolify reads a `sha256-`
prefixed tag and pulls `name@sha256:<hex>`:

```php
$isImageHash = str($this->dockerImageTag)->startsWith('sha256-');
```

### Where each environment stands

| | type | digest deploys |
| --- | --- | --- |
| `shikoo-dev-*` (staging) | Docker Image | ✅ supported today |
| `shikoo-*` (production) | Git / Dockerfile | ❌ refused, by design |

Production cannot be converted in place. Moving it onto this pipeline means
creating Docker Image applications beside the existing ones and cutting the
domains over — planned, owner-approved, and **not** part of this change.

### Promotion to production

Never automatic, in either mode. `workflow_dispatch` with:

- `staging_run_id` — the Deploy run whose digest **passed staging**. The digest
  is read from that run's artifact, which exists only because the staging deploy
  ran and smoke-tested. There is no digest input, so an arbitrary tag, sha or
  digest cannot be promoted: there is nowhere to type one.
- `confirm` — the literal word `PROMOTE`.

The actor must be `SOLO_DEPLOY_OWNER`. Both checks run in `promote-gate`, a job
with **no `environment:`**, so an unauthorised promotion is refused before any
job holding a production secret exists. Nothing is rebuilt.

### The approval gate, and why it is not an Environment reviewer

This repository is **private on GitHub Free**: no rulesets, no required reviews,
and **no required reviewers on Environments**. The gate everybody reaches for
first does not exist on this plan, and a workflow that relied on it would look
gated and be wide open.

So `deploy/approval-gate.sh` re-derives it from the API, before anything is
built and before any job that can read a deployment secret exists:

| it refuses | because |
| ---------- | ------- |
| a commit no merged PR produced | a direct push to `main` must not deploy, and nothing else can stop one here |
| an approval by the PR's author | self-approval is not review |
| an approval by a bot | a machine agreeing with a machine is not the guarantee being rebuilt |
| a `COMMENTED` review | it is not an approval |
| an approval on a superseded head | GitHub keeps the old row for ever; the reviewer approved a different tree |
| any outstanding `CHANGES_REQUESTED` on the final head | somebody looked and said no, which is worse than nobody looking |
| a red or missing `Required Quality Gate` on that final head | — |
| a `main` that moved while this was being evaluated | the log would name a commit that is not what went out |
| any API call that fails | fail closed, always |

`deploy/test/deploy-pipeline.test.sh` drives every one of those against a fake
GitHub, and runs in CI under `Required Quality Gate`.

### Production is OFF

`vars.PRODUCTION_AUTO_DEPLOY == 'true'`, an exact string comparison — missing,
empty, `false`, `TRUE`, `1` and `yes` are all OFF. **That variable does not
exist**, and creating it is a deliberate act. While it is absent the production
job does not run at all, so `environment: production` is never entered and its
secrets are never loaded onto a runner.

To promote a digest that staging has already run, use the workflow's
`workflow_dispatch` with the run id of the Deploy run that reached staging. It
re-deploys that run's recorded digest and never rebuilds.

### The bot ships with production, and only with production

`DEPLOY_BOT_ENABLED`, and only the exact lowercase string `true` enables it.
When it is off the bot is not pinned, not deployed, not started, not
health-checked, not counted in the singleton assertion and not rolled back — its
Coolify safety configuration is still validated. Both `over-ssh.sh` and
`deploy.sh` fail closed on their own.

| job | bot |
| --- | --- |
| staging | **off** |
| production | on |
| promote | on |

**Staging must stay off.** It shares the shop's Telegram token, and a second
poller would take updates away from the bot real customers are talking to. The
deploy test counts the occurrences so the mistake cannot arrive by somebody
copying the production block.

Production carries it because excluding it everywhere had a cost that showed:
the bot sat on `7b21ba3` for five hours while the panel moved on, so a shipped
feature was invisible to every customer and nothing said why. `deploy.sh`
deploys it LAST — after the migrations, after the two services that only answer
ports — and then asserts that exactly one poller holds the advisory lock, so a
restart that produced zero or two fails the deploy rather than being discovered
by a customer whose message goes unanswered.

### Superseded: the polling timer

`deploy/autodeploy.sh` and `shikoo-autodeploy.timer` were the earlier design.
The timer is **disabled** on the server and the section below is kept for the
guards it explains, not as a description of what runs. Do not enable it: two
deployers racing for the same applications is worse than either alone.

`deploy/autodeploy.sh` ran on the Coolify server every two minutes under
`shikoo-autodeploy.timer`. It deployed a commit only when all of the following
were true of that one sha:

```
merged PR into main  →  approved by a non-author  →  push run green
   →  «Required Quality Gate» green on that sha  →  main still unmoved
   →  ENV_NAME matches  →  migrations safe  →  Coolify pinned to the sha
```

### Why the approval check lives here

The right place for "no unreviewed commit reaches main" is a branch ruleset, and
this repository cannot have one: rulesets on a private repository need GitHub
Team, and `GET /repos/:r/rulesets` answers `403 Upgrade to GitHub Pro` — measured
2026-08-27. So the deployment controller checks it itself.

That is not a workaround to delete when the plan is upgraded. A ruleset governs
what may land on `main`; this governs what may reach customers. Keep both.

What it demands of the candidate sha, each one a test in
`deploy/test/autodeploy.test.sh`:

| | |
| --- | --- |
| merged | an approval on an **open** PR deploys nothing |
| base `main` | a PR merged into another branch does not authorise a `main` deploy |
| this sha | the sha is the PR's `merge_commit_sha` or its head — covers merge-commit, squash, rebase and the merge queue. A PR that merely *mentions* the commit does not qualify |
| APPROVED | by somebody other than the author. Self-approval is not review |
| current | the approval's `commit_id` must be the PR's final head, so an approval given before another push is stale |
| latest | one review per reviewer, theirs most recent — an APPROVED later superseded by CHANGES_REQUESTED does not count |
| fails closed | a sha GitHub cannot associate with a merged PR is refused, not assumed |

### `:8000` IS on the public internet — correcting what this file used to say

This section previously claimed that "the router forwards only 80 and 443", so
GitHub could not reach Coolify. **That was false, and it was load-bearing.**
Measured from off-site on 2026-08-27:

```
GET  http://164.132.198.184:8000/api/v1/version   →  401 {"message":"Unauthenticated."}
GET  http://164.132.198.184:8000/                 →  302  (Coolify login page)
POST http://164.132.198.184:8000/webhooks/source/github/events/manual  →  200
```

The Coolify **control plane — API and UI — is reachable from the internet over
plaintext HTTP**, and the GitHub webhook endpoint answers. `docs/threat-model.md`
had this right all along; the deployment documentation contradicted it.

**Nothing about polling makes the control plane private.** Do not describe it
that way.

**What actually stops a push from deploying** is `is_auto_deploy_enabled = false`
on every application. Coolify's webhook handler calls
`Application::isDeployable()`, which returns `false` when that flag is off — so a
correctly-signed webhook is accepted and then does nothing. One flag, one UI
click away from being wrong, which is why `assert_coolify_safe` re-checks all
three applications on every tick and abandons the tick if any of them has it on.

**The open port is an accepted staging risk, and only that.** Before production,
or before this host holds real customer data, `:8000` must be bound to a private
interface, firewalled, or placed behind TLS and a VPN. It is listed as an
accepted risk in `docs/threat-model.md` §5 for the test period only.

### Why it polls anyway

Two reasons that survive the correction, neither of them "the box is
unreachable":

* **The Coolify token stays on loopback.** `COOLIFY_URL` is `127.0.0.1:8000`, so
  the bearer token never crosses an interface — least of all the plaintext one
  above. A webhook or an Actions-driven deploy would put a credential on that
  wire or in GitHub.
* **Nothing external needs a credential into this box.** The alternative designs
  hand GitHub an SSH private key or a deploy token. This one hands out nothing,
  which is a smaller blast radius than a shorter deploy latency is worth.

### The exact sha, not "latest main"

`POST /api/v1/deploy?uuid=` on its own means *deploy whatever main is now*, which
would report one sha and ship another. So each application is first pinned:

```
PATCH /api/v1/applications/<uuid>  {"git_commit_sha": "<sha>"}
GET   /api/v1/applications/<uuid>  → must read back that sha, on branch main
POST  /api/v1/deploy?uuid=<uuid>   → deployment_uuid
GET   /api/v1/deployments/<uuid>   → poll to a terminal state; .commit must match
```

Coolify's `ApplicationDeploymentJob::shouldResolveBranchHeadCommit()` resolves the
branch head **only** when `git_commit_sha` is empty or the literal `HEAD`, and
checks out the exact commit otherwise. That same value becomes the image tag and
the container's `SOURCE_COMMIT` — which is what the health checks read back. So

```
candidate sha = pinned sha = deployment .commit = container SOURCE_COMMIT
```

is checked, not assumed. The pin also stays put, which is what makes a rollback a
redeploy of the previous sha rather than a rebuild of something new.

### The bot is opt-in, and off by default

`AUTODEPLOY_BOT_ENABLED` in `/etc/shikoo/autodeploy.env`. **Anything that is not
the exact string `true` is off** — unset, empty, `yes`, `1`, `TRUE`, a typo.

Deploying the bot is not like deploying the other two. Ingest and the dashboard
answer a port when somebody calls it. The bot **connects out**: it starts
long-polling Telegram as a real bot account, and it begins sweeping verified
payment claims and messaging customers. A bot deploy is an act with effects
outside this host, so it is a decision somebody makes rather than a side effect
of merging.

When off, the bot is excluded from the deployment order entirely — no
`git_commit_sha` pin, no deploy call, no container, no health check, and a
rollback never touches it either. The log says so on every tick rather than
staying quiet about it.

Its **safety** configuration is still checked. `assert_coolify_safe` validates
native auto-deploy and preview deployments on all three applications including
the bot, because a bot with native Auto Deploy enabled is exactly as dangerous
whether or not this script is the thing deploying it. Rollout and safety are
different questions.

To turn it on, once the bot is wanted on staging: set
`AUTODEPLOY_BOT_ENABLED=true`, confirm the Telegram credential is a staging bot
and not the live customer one, and let the next tick take it.

### Order, and why

| | |
| --- | --- |
| 1. migrations | `deploy/entrypoint.sh` refuses to start a service whose ledger is behind, so the schema moves first or nothing starts |
| 2. `ingest` | `dashboard` is configured with `INGEST_URL`; the reverse edge does not exist |
| 3. `dashboard` | |
| 4. `bot` | last, and alone. `apps/bot/src/singleton.ts` holds a Postgres advisory lock keyed on the token, and a second poller **blocks** rather than racing — so Coolify's start-new-then-stop-old window cannot make two `getUpdates` callers |

Postgres is never in that list. It is a Coolify **database** resource; the script
only ever names the three application uuids.

### The schema, and what is refused

Before anything is deployed, the candidate's `migrations/` is fetched at that sha
and compared to `schema_migrations`:

* a migration in the ledger that the candidate does not have → the database is
  **ahead** of the code. Refused.
* a pending migration containing `DROP TABLE/COLUMN/CONSTRAINT`, `TRUNCATE`, a
  column type change or a rename → refused **unless** the file itself carries the
  line `-- autodeploy: reviewed-destructive`. That marker is in the migration
  rather than in a flag on the deployer: it travels with the change, it is in the
  diff the approving reviewer read, and whoever is deploying cannot set it.

Migrations are applied through the existing `schemaCli` — advisory lock, one
transaction and one ledger row per file — then `status` must come back clean and
`verify_invariants.sql` must pass. **A forward migration is never reversed.** What
makes a code rollback survivable is that the startup gate treats a database
*ahead* of the checkout as a warning rather than a refusal.

### Failure

The first application that does not come up healthy stops the run. Everything
behind it in the order is left untouched, everything already moved is pinned back
to the previous sha and re-checked, and the candidate is **not** recorded. If
there is no previous sha to return to, it says `ROLLBACK IMPOSSIBLE` rather than
claiming success.

### The one-time bootstrap exception

**The applications on staging do not run commits that are on `main`.** Measured
2026-08-27:

| app | running sha | ancestor of `main` | associated PR |
| --- | --- | --- | --- |
| `shikoo-ingest` | `d48e19b0` | **no** | none |
| `shikoo-dashboard` | `74b0a85d` | **no** | none |
| `shikoo-bot` | *not running* | — | — |
| *(`main` head)* | `9cb0d89f` | yes | **none — a direct push** |

Both running shas are orphaned: reachable objects on no branch, produced by no
pull request. So there is no sha that is simultaneously *deployed* and
*approved-on-main*, and the rule this pipeline exists to enforce cannot be
satisfied by anything currently running.

That creates a deadlock. `ENV_NAME=staging` is set in Coolify but a container
carries the environment it was **started** with, so the three applications still
report `production` at runtime — and the guard reads the runtime value, so it
refuses every tick. Only a redeploy makes the new value live, and the guard
blocks the redeploy.

It is broken exactly once, deliberately, and narrowly:

* `shikoo-ingest` may be redeployed **only** at `d48e19b0`;
* `shikoo-dashboard` may be redeployed **only** at `74b0a85d`;
* the sole purpose is to inject `ENV_NAME=staging`;
* the database schema must remain at `0031` — the ledger is at `0031` and both
  shas carry `0031`, so nothing migrates;
* **this is not an approved-main deployment** and must never be recorded or
  described as one. It changes no code: same commit in, same commit out.

**Do not manually deploy `main` to break the deadlock.** `main` carries
migrations through `0033` while the database is at `0031`, so
`deploy/entrypoint.sh`'s schema gate would refuse to start every container — a
manual Coolify deploy does not run the migration preflight that
`autodeploy.sh` does. It would fail, and it would fail after having stopped the
running containers.

The **first approved-main deployment** must therefore go through autodeploy,
after PR #3 is merged: its preflight reads the ledger, compares it to the
candidate's `migrations/`, refuses destructive DDL without a reviewed plan,
applies `0032` and `0033` under the advisory lock, proves `schema status` clean,
runs the invariants, and only then deploys in dependency order with health
checks and rollback.

Order, therefore: **bootstrap redeploy → merge PR #3 → install `GH_TOKEN`**.

### Where things live

| where | what |
| --- | --- |
| `/opt/shikoo/autodeploy.sh` | the script, root-owned, 0755 |
| `/etc/shikoo/autodeploy.env` | **0600 root:root**, in a 0700 directory, never in git |
| `/var/lib/shikoo-autodeploy/last-sha` | the last sha that fully deployed — the rollback target |
| `/var/lib/shikoo-autodeploy/rejected-sha` | the last sha refused for a terminal reason, so the refusal is said once |
| `/var/lib/shikoo-autodeploy/deployments.jsonl` | one line per attempt: candidate, previous, deployment uuids, timestamps, verdict |
| `systemctl status shikoo-autodeploy` | the last run |
| `journalctl -u shikoo-autodeploy -f` | every decision, with its reason |

`/opt/shikoo/autodeploy.sh --dry-run` does every read and no write: it resolves
the candidate, runs all the gates, prints the run id, the gate verdict, the
matched uuids and the sha each application is actually running, and says what it
would decide. Run that first, always.

### The credential file

`LoadCredential=` in the unit, **not** `EnvironmentFile=`. `EnvironmentFile=`
loads every value into the unit's environment, where `systemctl show -p
Environment` prints it back to anyone who can run systemctl — turning a 0600 file
into something a diagnostic leaks. `LoadCredential=` passes the file itself
through a per-invocation ramfs at mode 0400 and appears in no `systemctl show`
property. The script prefers `$CREDENTIALS_DIRECTORY/autodeploy.env` and falls
back to `/etc/shikoo/autodeploy.env` for a hand-run.

Neither token is ever passed on a command line. `curl` reads both from a config
file in a 0700 temp directory removed on exit, so `ps` shows a path and never a
bearer token.

**Values are UNQUOTED, and the file is read as text rather than `.`-sourced.**
It used to be sourced, which meant every value was a shell expression: the
Coolify token begins `N|`, and unquoted that `|` became a pipe into a command
named after the rest of the token. The fix was a rule — quote everything — that
a human had to remember. Reading the file as text needs no rule, because nothing
is interpreted: a `|`, a `$` or a space in a secret is just a character. It also
closes the larger hole, which is that sourcing a credentials file hands anybody
who can write it arbitrary code as root.

Surrounding quotes are still stripped if present, so a file written the old way
keeps working — but new values should carry none.

```text
GH_REPO=<redacted>          COOLIFY_URL=<redacted>      APP_INGEST=<redacted>
GH_TOKEN=<redacted>         COOLIFY_TOKEN=<redacted>    APP_DASHBOARD=<redacted>
BRANCH=<redacted>           DB_CONTAINER=<redacted>     APP_BOT=<redacted>
EXPECT_ENV_NAME=<redacted>  PGUSER=<redacted>           PGDATABASE=<redacted>
```

`GH_TOKEN` is left **absent** rather than empty. Absent lets a one-off
verification run supply it through the environment; systemd sets no environment
at all, so the unit still fails closed on it.

### The GitHub token needs `Actions: Read-only`, and «Checks» is not on offer

The obvious permission for reading a CI verdict is `Checks`, and the obvious
endpoint is `/commits/:sha/check-runs`. GitHub no longer lists `Checks` among the
fine-grained token permissions at all — checked 2026-08-26. `Commit statuses` is
the substitute it looks like and is not: Actions reports through check runs, so
the legacy combined status is empty here and would read as "no CI configured",
the one answer that must never pass. So the verdict comes from
`/actions/runs?head_sha=`, which `Actions: Read-only` opens.

The whole scope list this needs, and nothing beyond it:

| permission | for |
| --- | --- |
| Metadata: Read | required by every other one |
| Contents: Read | the branch head, and the `migrations/` tarball at the candidate sha |
| Pull requests: Read | the merged PR and its reviews |
| Actions: Read | the workflow runs and their jobs |

No write anywhere: it must not be able to push, merge, delete a branch, change a
setting or read a secret.

### The Coolify token

A dedicated token on the correct team, abilities `read`, `write`, `deploy` —
never `root`, and not `read:sensitive`. `write` is needed for exactly one thing:
`PATCH /api/v1/applications/<uuid>` is what sets `git_commit_sha`, and that same
verb is what turned native Auto Deploy off. Without `write` there is no way to
pin an immutable sha, and the deploy degrades to "latest main".

### How Coolify fetches the repository

A **read-only deploy key**, `shikoo-staging-source`, held in Coolify's own
private-key store and registered on the repository as
`coolify-france-staging (read-only source)`.

It replaced an HTTPS clone URL with a classic personal access token embedded in
it. That token carried `repo` scope — read *and write* on every repository its
owner could reach — to do a job that needs read on one. It sat in plaintext in
the Coolify database, and rotating it into another URL-embedded token would have
changed the value and none of the properties that made it wrong.

The key is proven, not assumed: it resolves `Shikoonet-Platform`, it is refused
by other repositories in the same organisation, and `git push --dry-run` against
it fails. Coolify still needs this and it must not be removed — turning off
native Auto Deploy does not turn off Coolify's ability to fetch what it is told
to build.

The applications were not recreated to do this. Same uuids, same domains, same
environment variables; two fields changed on each.

### One trigger, and only one

Coolify's native **Auto Deploy** is off on all three applications
(`is_auto_deploy_enabled: false`, set 2026-08-27) and preview deployments were
already off. There is no GitHub Actions deployment job and no second timer.

The webhook secrets remain set, and they are **not** harmless because of the
network — GitHub *can* reach `:8000`, see above. They are inert because
`is_auto_deploy_enabled` is false, and for no other reason. No webhook is
configured on the repository today (`GET /repos/:r/hooks` → `[]`), so nothing
sends to that endpoint either; but if one were added, the flag is what would
still refuse it.

That is why the flag is a checked precondition of every tick rather than a
setting somebody remembers.

Coolify's own access to the private repository is **not** touched by any of this
and must not be: it still needs to fetch the code it is told to build.


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
