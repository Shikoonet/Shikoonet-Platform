# Configuration matrix

Every configuration value, token, key and resource identifier this project
needs, where it must live, and what state it is in.

**This document contains no values.** It is checked into a private repository
anyway, so paths that would name a host, a user or a dump are placeholders.

Derived from code on 2026-08-27, not from documentation: the source of truth for
each row is the `required()` / `optional()` / `PASSTHROUGH` list in the relevant
`apps/*/src/server.ts`, the schema helpers in `packages/contracts/src/env.ts`,
`deploy/autodeploy.sh`, `Dockerfile` and `.github/workflows/ci.yml`.

## Where a value is allowed to live

| Destination | For |
| --- | --- |
| **GitHub Variable** | non-sensitive config a workflow actually reads |
| **GitHub Secret** | sensitive value a workflow actually reads |
| **GitHub Environment Secret/Variable** | only if a workflow deploys to that environment |
| **Coolify runtime variable** | application runtime configuration |
| **Coolify Source credential** | how Coolify fetches the repository |
| **Server systemd credential** | what `autodeploy.sh` needs, on the Coolify host |
| **Local operator-only** | SSH keys, production dumps, cutover material |
| **Not required** | nothing reads it |

Two rules follow from the current architecture and are worth stating before the
table, because most miscategorisation comes from ignoring them:

0. **Production is released by two dispatches, never one.** *(Added
   2026-08-28.)* `Prepare Production` does everything reversible while
   customers are still on the old applications; `Cutover Production` moves the
   live domains and hands the bot over. Neither accepts a commit, digest,
   image, ref or run id — the release is whatever the latest successful
   `Deploy Staging` run for the current `main` produced. `COOLIFY_TOKEN` is
   consumed only on the host, through the same read-as-text path `deploy.sh`
   uses, and never reaches GitHub.

1. **Deployment is driven by GitHub Actions.** *(Corrected 2026-08-28; this
   rule used to say the opposite.)* `deploy-staging.yml` builds one image and
   hands its digest to `deploy/deploy.sh` over SSH; `promote-production.yml`
   promotes that same digest by hand. The five `DEPLOY_*` environment secrets
   therefore DO have a consumer on `main` — `deploy/over-ssh.sh` — and the
   `staging` and `production` GitHub Environments are load-bearing rather than
   vestigial. `deploy/autodeploy.sh` is retired and its timer is disabled on the
   host. Coolify still needs no inbound webhook: native Auto Deploy and preview
   deployments are off on every application, and `deploy/deploy.sh` now asserts
   that on every deploy rather than trusting it.
2. **A runtime secret is not a build argument.** Coolify passes every variable
   marked build-time to `docker build` as `--build-arg`, and BuildKit records
   `ARG NAME=value` in the image's layer history. Anything sensitive must be
   runtime-only.

## Status vocabulary

`PRESENT` · `MISSING` · `WRONG_LOCATION` · `OVER_PRIVILEGED` · `UNUSED` ·
`REQUIRES_ROTATION` · `NEEDS_OWNER_ACTION`

---

## 1. Autodeploy — server systemd credential

Read by `deploy/autodeploy.sh` only. Delivered by `LoadCredential=` in
`shikoo-autodeploy.service`, which keeps them out of `systemctl show -p
Environment`. Source file is `0600 root:root` in a `0700` directory.

| Name | Consumer | Purpose | Sensitive | Required in | Build/runtime | Storage | Required permissions | Rotation | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `GH_REPO` | autodeploy | `owner/name` to ask about | no | staging, production | runtime | Server systemd credential | — | never | PRESENT |
| `GH_TOKEN` | autodeploy | branch head, merged PR, reviews, workflow runs and jobs, the `migrations/` tarball at a sha | **yes** | staging, production | runtime | Server systemd credential | see §7 — Metadata R, Contents R, Pull requests R, Actions R, and nothing else | 90 days | **MISSING — NEEDS_OWNER_ACTION** |
| `COOLIFY_URL` | autodeploy | Coolify API base. Loopback so the token never crosses an interface | no | staging, production | runtime | Server systemd credential | — | never | PRESENT |
| `COOLIFY_TOKEN` | autodeploy | pin `git_commit_sha`, queue a deploy, poll it | **yes** | staging, production | runtime | Server systemd credential | team-scoped `read` + `write` + `deploy`. Not `root`, not `read:sensitive` | 90 days | PRESENT |
| `APP_INGEST` | autodeploy | Coolify application uuid | no | staging, production | runtime | Server systemd credential | — | never | PRESENT |
| `APP_DASHBOARD` | autodeploy | Coolify application uuid | no | staging, production | runtime | Server systemd credential | — | never | PRESENT |
| `APP_BOT` | autodeploy | Coolify application uuid | no | staging, production | runtime | Server systemd credential | — | never | PRESENT |
| `EXPECT_ENV_NAME` | autodeploy | the `ENV_NAME` this host may deploy to. No default — an unanswerable "which environment is this" is a refusal | no | staging, production | runtime | Server systemd credential | — | never | PRESENT — `staging` (see §8) |
| `DB_CONTAINER` | autodeploy | Postgres container, for the migration ledger and the invariants | no | staging, production | runtime | Server systemd credential | — | never | PRESENT |
| `PGUSER` | autodeploy | ledger reads | no | staging, production | runtime | Server systemd credential | — | never | PRESENT |
| `PGDATABASE` | autodeploy | ledger reads | no | staging, production | runtime | Server systemd credential | — | never | PRESENT |
| `BRANCH` | autodeploy | branch to watch. Defaults to `main` | no | staging, production | runtime | Server systemd credential | — | never | PRESENT |
| `REQUIRED_JOB` | autodeploy | the aggregator job name. Defaults to `Required Quality Gate` | no | staging, production | runtime | Server systemd credential | — | never | PRESENT (defaulted) |
| `DEPLOY_TIMEOUT` `HEALTH_TIMEOUT` `POLL_SECS` `BOT_HEARTBEAT_MAX_AGE` | autodeploy | bounded waits | no | optional | runtime | Server systemd credential | — | never | PRESENT (defaulted) |
| `AUTODEPLOY_BOT_ENABLED` | autodeploy | opt-in for deploying the bot. Anything but the exact string `true` is off — the bot connects out to Telegram and messages customers, so its rollout is a decision, not a side effect | no | staging, production | runtime | Server systemd credential | — | never | **`false`** — bot rollout OFF for the first approved-main deployment |
| `COOLIFY_DB_CONTAINER` | autodeploy | reads `application_settings` for the safety gate; the API returns null for both flags | no | staging, production | runtime | Server systemd credential | — | never | PRESENT |

Paths, not variables, but part of the same surface:

| Path | Purpose | Mode |
| --- | --- | --- |
| `/etc/shikoo/autodeploy.env` | the credential file | `0600 root:root`, in a `0700` directory |
| `/var/lib/shikoo-autodeploy/last-sha` | last fully deployed sha — the rollback target | `0700` directory |
| `/var/lib/shikoo-autodeploy/rejected-sha` | last terminally refused sha | `0700` directory |
| `/var/lib/shikoo-autodeploy/deployments.jsonl` | one line per attempt | `0600` |
| `/run/shikoo-autodeploy.lock` | single-instance lock | `0600`, from `UMask=0077` |

---

## 2. Coolify runtime variables, per application

Set in each Coolify application. **All sensitive rows must be runtime-only.**

### `shikoo-bot`

| Name | Purpose | Sensitive | Required | Build/runtime | Status |
| --- | --- | --- | --- | --- | --- |
| `SERVICE` | selects the entry point in `deploy/entrypoint.sh`. No default by design | no | yes | build+runtime (harmless) | PRESENT |
| `DATABASE_URL` | Postgres | **yes** | yes | runtime-only | PRESENT |
| `TELEGRAM_BOT_TOKEN` | the bot identity it long-polls with | **yes** | **fallback only** — the dashboard's «پیکربندی › ربات» stores it in `bot_credentials` and that row wins. Still required on a service with no row | runtime-only | PRESENT |
| `ENV_NAME` | decides the login bypass, Origin-less writes, cookie flags. `parseEnvName` **throws** rather than defaulting | no | **yes** | runtime-only | PRESENT — `staging`, created 2026-08-27. Its absence is why the bot could not boot |
| `PANEL_SECRET_KEY` | seals the provisioning panel credential **and the bot token** | **yes** | when provisioning, or whenever a bot is connected from the dashboard | runtime-only | PRESENT |
| `PANEL_TEST_PANEL` `PANEL_TEST_PANEL_URL` | practice-panel target | **yes** (holds credentials) | practice only | runtime-only | PRESENT — moved off build-time 2026-08-27 |
| `WIRE_TEST_PANEL_ON_HOST` | guard for `scripts/wire-test-panel.ts` | no | practice only | build+runtime | PRESENT |
| `ALERT_CHAT_ID` | where alerts go | no | optional | build+runtime | PRESENT |
| `REPORT_CHAT_ID` | fallback for `ALERT_CHAT_ID` | no | optional | runtime | not set (falls back) |
| `TELEGRAM_API_BASE` | override the Telegram endpoint | no | optional | runtime | not set (defaulted) |
| `TELEGRAM_POLL_TIMEOUT_SEC` | long-poll timeout | no | optional | runtime | not set (defaulted) |
| `BOT_HEARTBEAT_PATH` | heartbeat file the image's `HEALTHCHECK` stats | no | optional | runtime | not set (defaulted) |

### `shikoo-ingest`

| Name | Purpose | Sensitive | Required | Build/runtime | Status |
| --- | --- | --- | --- | --- | --- |
| `SERVICE` | entry point | no | yes | build+runtime | PRESENT |
| `DATABASE_URL` | Postgres | **yes** | yes | runtime-only | PRESENT |
| `ENV_NAME` | environment guards | no | yes | runtime-only | PRESENT — `staging` |
| `HOST` `PORT` | listener (8787) | no | yes | build+runtime | PRESENT |
| `MIRZABOT_INTEGRATION_HMAC_SECRET` | verifies the Mirzabot webhook signature | **yes** | when integration on | runtime-only | PRESENT |
| `MIRZABOT_INTEGRATION_ID` | integration identity | no | when integration on | build+runtime | PRESENT |
| `MIRZABOT_INTEGRATION_ENABLED` | feature flag | no | optional | build+runtime | PRESENT |
| `MIRZABOT_WEBHOOK_URL` | outbound callback | no | optional | runtime | not set |
| `AUTO_MATCH_ENABLED` `AUTO_FULFILLMENT_ENABLED` | feature flags on money paths | no | optional | build+runtime | PRESENT |
| `TRUSTED_PROXY_IP_HEADER` | which header carries the client IP | no | behind a proxy | build+runtime | PRESENT |
| `INGEST_MAX_BODY_BYTES` `RATE_LIMIT_WINDOW_MS` `DEVICE_RATE_LIMIT` `IP_RATE_LIMIT` `SWEEP_INTERVAL_MS` | limits | no | optional | runtime | not set (defaulted) |
| `ALERT_CHAT_ID` | alerts | no | optional | build+runtime | PRESENT |
| `APP_VERSION` | falls back to `SOURCE_COMMIT` | no | optional | runtime | injected by Coolify |
| `SOURCE_COMMIT` | the deployed sha — **injected by Coolify, never set by hand** | no | automatic | runtime | PRESENT (automatic) |

Device authentication for SMS ingest is **not** an environment variable: it is
rows in `device_credentials`. Nothing to store here.

### `shikoo-dashboard`

| Name | Purpose | Sensitive | Required | Build/runtime | Status |
| --- | --- | --- | --- | --- | --- |
| `SERVICE` | entry point | no | yes | build+runtime | PRESENT |
| `DATABASE_URL` | Postgres | **yes** | yes | runtime-only | PRESENT |
| `ENV_NAME` | environment guards | no | yes | runtime-only | PRESENT — `staging` |
| `HOST` `PORT` | listener (8788) | no | yes | build+runtime | PRESENT |
| `INGEST_URL` | the ingest service — the only edge between the two | no | yes | build+runtime | PRESENT |
| `TELEGRAM_BOT_TOKEN` | sends operator messages and fetches receipts | **yes** | **fallback only** — same resolution as the bot (`resolveBotToken`) | runtime-only | PRESENT |
| `PANEL_SECRET_KEY` | seals the provisioning panel credential **and the bot token** | **yes** | when provisioning, or whenever a bot is connected from the dashboard | runtime-only | PRESENT |
| `TRUSTED_PROXY_IP_HEADER` | client IP header | no | behind a proxy | build+runtime | PRESENT |
| `ALLOWED_ORIGINS` | CORS / Origin allow-list | no | optional | runtime | not set |
| `ENABLE_PURCHASE_TYPE` `DEV_BLOCK_DEVICE_ADMIN` | feature flags | no | optional | runtime | not set |
| `ALERT_CHAT_ID` | alerts | no | optional | build+runtime | PRESENT |
| `ADMIN_DIST` | where the built SPA is | no | optional | build | baked into the image |
| `TEST_ACCESS_USER` | **skips login entirely.** Refused twice when `ENV_NAME` is not `local`/`test` | **yes** | never in a deployment | runtime | correctly absent |
| `APP_VERSION` / `SOURCE_COMMIT` | version reporting | no | automatic | runtime | PRESENT (automatic) |

Operator passwords, TOTP secrets and session material are **not** environment
variables — scrypt hashes and TOTP secrets live in the database
(`packages/domain/src/operatorAuth.ts`, `totp.ts`). There is no session-secret
variable to store, and one must not be invented.

---

## 3. Coolify Source credential

| Item | Purpose | Storage | Status |
| --- | --- | --- | --- |
| `shikoo-staging-source` deploy key | how Coolify fetches the private repository | Coolify Source credential | PRESENT — read-only, scoped to this repository, verified |
| classic PAT in the clone URL | *was* how Coolify fetched it | removed 2026-08-27 | REMOVED from Coolify — **still REQUIRES_ROTATION on GitHub** |
| `shikoo-github-deploy` private key | an older Coolify key | Coolify Source credential | UNUSED — its public half is already registered elsewhere, so it could not be added to this repository |
| `manual_webhook_secret_github` | inbound push webhook | Coolify application | PRESENT but inert — **not** because of the network (`:8000` IS internet-reachable) but because `is_auto_deploy_enabled=false`; no webhook is configured on the repo either |

---

## 4. GitHub Actions

`ci.yml` reads **no** repository variable and **no** repository secret. The only
credential it uses is the automatic `GITHUB_TOKEN`, whose default workflow
permission is `read` and which cannot approve pull requests.

| Name | Consumer | Storage | Status |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | automatic | GitHub (automatic) | PRESENT — never create by hand |
| `PRODUCTION_AUTO_DEPLOY` | *nothing on `main` or this branch* | GitHub Variable | **UNUSED** |
| `DEPLOY_HOST` `DEPLOY_PORT` `DEPLOY_USER` `DEPLOY_SSH_KEY` `DEPLOY_KNOWN_HOSTS` | consumed on `main` by `deploy/over-ssh.sh`, from `deploy-staging.yml` and `promote-production.yml` | GitHub Environment Secrets (`staging`, `production`) | **CORRECT — this is where they belong** *(corrected 2026-08-28)* |

GitHub Environments `staging` and `production` exist with **no protection
rules**. Under server-side deployment they should not exist at all; they are
kept only because PR #2 proposes an Actions-driven architecture that uses them.

Secrets deliberately **not** in GitHub, and which must not be added while
deployment stays server-side: `COOLIFY_TOKEN`, any Coolify deploy webhook, the
server SSH private key, any production `DATABASE_URL`, the production dump, and
any GitHub App private key.

PR workflows cannot reach deployment credentials: nothing in `ci.yml` references
`secrets.*` beyond the automatic token, and no job declares an `environment:`.

---

## 5. Local operator-only

| Item | Purpose | Storage | Status |
| --- | --- | --- | --- |
| SSH private key for the Coolify host | operator administration | operator machine, mode `0600` | PRESENT — must never enter GitHub or Coolify |
| MirzaDB production rehearsal dump | migration rehearsal | operator machine, outside Git | PRESENT — `.gitignore` and `.dockerignore` both exclude it |
| `MIGRATE_PRODUCTION_DUMP` | absolute path to that dump, for local migration tooling | operator shell only | path only, never the data |
| `MIGRATE_FIXTURE_MYSQL` `SIM_PG_CONTAINER` `MIGRATIONS_DIR` | local/CI tooling | operator shell / CI job | not a credential |

---

## 6. Aliases and near-duplicates

Checked, and each is deliberate rather than two names for one credential:

| Names | Relationship |
| --- | --- |
| `ALERT_CHAT_ID` / `REPORT_CHAT_ID` | `REPORT_CHAT_ID` is a documented fallback read only when `ALERT_CHAT_ID` is unset. Same purpose, ordered — not a duplicate credential |
| `APP_VERSION` / `SOURCE_COMMIT` | `resolveAppVersion()` prefers `APP_VERSION` and falls back to the sha Coolify injects. Not interchangeable inputs |
| `GH_TOKEN` (server) / `GITHUB_TOKEN` (Actions) | different credentials, different consumers, different privileges. Must never be the same value |

No two names were found holding the same credential without a reason.

---

## 7. `GH_TOKEN` — permission matrix, derived from the calls

Every GitHub endpoint `deploy/autodeploy.sh` makes, and the least permission
that opens it. Nothing beyond this list is exercised, so nothing beyond it
should be granted.

| Endpoint | Why | Minimum permission |
| --- | --- | --- |
| `GET /repos/{r}/commits/{branch}` | the candidate sha, and the re-read that closes the branch race | Contents: **Read** |
| `GET /repos/{r}/commits/{sha}/pulls` | which pull request produced this commit | Pull requests: **Read** |
| `GET /repos/{r}/pulls/{n}/reviews` | the approving review, its author and its commit_id | Pull requests: **Read** |
| `GET /repos/{r}/actions/runs?head_sha=…&event=push&branch=…` | the push run on that exact sha | Actions: **Read** |
| `GET /repos/{r}/actions/runs/{id}/jobs` | `Required Quality Gate` by name | Actions: **Read** |
| `GET /repos/{r}/tarball/{sha}` | the `migrations/` tree at the candidate, for the preflight | Contents: **Read** |
| *(implicit)* | required by every fine-grained token | Metadata: **Read** |

**Not required, and must not be granted:**

| Permission | Why not |
| --- | --- |
| Commit statuses | the script deliberately does not use the combined status API — Actions reports through check runs, so that endpoint is empty here and would read as "no CI configured" |
| Checks | GitHub no longer offers Checks as a fine-grained permission at all, and the script uses the runs API instead precisely because of that |
| Contents: Write | it never pushes |
| Pull requests: Write | it never merges, comments or closes |
| Administration · Secrets · Workflows · Webhooks | nothing in the script touches any of them |

## 8. Outstanding — owner action required

1. **`GH_TOKEN` does not exist.** Autodeploy fails closed on every tick until it
   is created. It cannot be created through the API; a fine-grained PAT is a UI
   action.
2. **The old classic PAT still exists on GitHub and must be revoked.** Coolify
   no longer references it — all three applications clone over SSH with a
   dedicated read-only deploy key as of 2026-08-27, and no `ghp_` string remains
   anywhere in the Coolify database. But the token itself is still live, still
   carries `repo` scope, and belongs to a user account rather than to this
   deployment, so only its owner can revoke it. Identify any other consumer
   first: it was in use long enough that something else may depend on it.
3. **`shikoo-bot` has no `ENV_NAME`** and therefore cannot start.
4. **The running containers still report `ENV_NAME=production`.** Coolify's
   configuration now says `staging` on all three, but a container carries the
   value it started with. The guard reads the *running* container, so it will
   keep refusing until the applications are restarted once — and that restart
   is a deployment, which is why it is an owner action rather than something
   done here. This is the single step that unblocks autodeploy.
5. **Sensitive values were previously build arguments**, so `ARG NAME=value` is
   recorded in existing image layer history. The flags are corrected now, but
   the already-built images still carry them — the values need rotating, not
   just re-flagging.
6. ~~`PANEL_TEST_PANEL` / `PANEL_TEST_PANEL_URL` are still build-time~~ — fixed
   2026-08-27; both are runtime-only now.
7. **Resolved, 2026-08-28.** The Actions-driven architecture won, so the five
   `DEPLOY_*` environment secrets have a consumer and stay where they are.
   `PRODUCTION_AUTO_DEPLOY` has no consumer and cannot regain one: the
   production job was deleted rather than gated on it, and a deploy test greps
   both workflows for the name so it cannot come back even as prose.
