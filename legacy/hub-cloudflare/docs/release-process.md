# Release process

Nothing goes straight to production. Every change ships to dev first, is reviewed
as a pull request, and only reaches production after the admin merges it.

```
dev/<topic>-<YYYYMMDD>  ──pnpm release:dev──▶  dev workers
        │
        └── PR to main ──▶ admin merges (this is the approval)
                                │
                                └── pnpm release:prod ──▶ production workers
```

## Environments

| | dev | production |
|---|---|---|
| Dashboard | `dashboard-worker-dev` | `dashboard-worker` |
| Ingest | `ingest-worker-dev` | `ingest-worker` |
| D1 | `payment-hub-dev` | `payment-hub-staging` |
| Config | `wrangler.dev.toml` | `wrangler.toml` |
| Tag | `v0.2.0-dev.1` | `v0.2.0` |

> **`payment-hub-staging` is the production database.** The name is historical.
> Anything that treats "staging" as a safe sandbox will corrupt real payment data.

Both environments sit behind the same Cloudflare Access policy and serve the same
SPA bundle. The **version badge** in the dashboard header is the only visual tell:
production shows a muted `v0.2.0`, dev shows an amber `DEV v0.2.0-dev.1`. It is
fed by `GET /api/v1/version`, which reads the `APP_VERSION` var injected at deploy
time and the `ENV_NAME` var baked into each wrangler config.

## Versioning

The `version` field in the **root** `package.json` is the single source of truth.
Package versions inside `apps/` and `packages/` are unused — they are private and
never published.

```bash
npm version 0.2.0-dev.1 --no-git-tag-version   # start a dev cycle
npm version 0.2.0-dev.2 --no-git-tag-version   # each subsequent dev deploy
npm version 0.2.0 --no-git-tag-version         # promote (before opening the PR)
```

`scripts/release.sh` creates the git tag; do not tag by hand.

## Shipping to dev

```bash
git fetch --all --prune
git checkout -b dev/<topic>-$(date +%Y%m%d) origin/main
# ...work...
npm version 0.2.0-dev.1 --no-git-tag-version
git commit -am "feat: ..."
pnpm release:dev
```

`release:dev` refuses to run unless the tree is clean, the branch is `dev/*`, the
version carries a `-dev.N` suffix, and `HEAD` is not behind `origin/main` — the
last guard exists because other developers push to this repo too.

## Promoting to production

1. Bump to the release version (`npm version 0.2.0 --no-git-tag-version`), commit, push the branch.
2. Open a PR to `main`. **Merging it is the admin's approval.**
3. After the merge:
   ```bash
   git checkout main && git pull
   pnpm release:prod
   ```

`release:prod` refuses unless `HEAD` is on `main` and identical to `origin/main`,
then asks for an interactive `yes` (or `DEPLOY_CONFIRM=yes` in the environment).
It backs up the production D1 to `.deploy-backups/` with a SHA-256 before applying
any migration, and writes `.deploy-backups/release-v<version>.md` afterwards.

Use `--plan` on either mode to run the guards and print the steps without changing
anything.

## Migrations

One directory, `migrations/`, shared by both databases. Dev runs ahead; production
catches up at release time. Wrangler tracks applied migrations per database in a
`d1_migrations` table keyed by **filename**, so a migration must keep the same
filename in both environments — never renumber a file that has already been applied
anywhere.

`wrangler deploy` does **not** apply migrations. `release.sh` runs them explicitly.
Skipping that step is what caused the production 500s on 2026-08-05
(`docs/verification/final-report.md`).

## Rollback

| Level | Action | When |
|---|---|---|
| 0 | `cd apps/dashboard-worker && pnpm exec wrangler rollback` | Bad deploy, need it gone now |
| 1 | `git checkout v<previous> && pnpm release:prod --skip-tests` | Level 0 not enough |
| — | **Migrations are not rolled back** | All migrations are additive |

The D1 backup taken before each release is for **verification and dev seeding
only** — do not restore it over production. This matches the existing rule in
`.production-backups/dashboard-before-dev-*/ROLLBACK.md`.

## First-time setup for the dev ingest worker

Secrets are per-worker and are not inherited from production. Generate a fresh
HMAC secret for `ingest-worker-dev` — never copy the production one:

```bash
cd apps/ingest-worker
pnpm exec wrangler secret put MIRZABOT_INTEGRATION_HMAC_SECRET -c wrangler.dev.toml
```

`AUTO_FULFILLMENT_ENABLED` is `"false"` in the dev config so a test SMS can never
provision real VPN service through Mirzabot.
