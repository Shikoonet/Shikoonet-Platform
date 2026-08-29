# Local Development

How to set up the project on a developer laptop.

## Prerequisites

- Node.js ≥ 20.
- `pnpm` ≥ 9.
- `wrangler` is invoked via `pnpm` scripts; no global install needed.
- A Cloudflare account is NOT required for the unit + integration test
  suite. Wrangler's local mode (`miniflare`) provides D1 in-memory.

## One-time setup

```bash
git clone <repo> sms-reconciliation-hub
cd sms-reconciliation-hub
pnpm install
```

## Running tests

```bash
# All packages
pnpm test

# One package
pnpm --filter @hub/ingest-worker test
pnpm --filter @hub/dashboard-worker test
pnpm --filter @hub/sms-parser test
pnpm --filter @hub/domain test
```

Each Vitest run applies the D1 schema from `migrations/0001_init.sql` into a
fresh in-memory instance via `env.DB.prepare(...).run()`. No wrangler
login required.

## Running the Workers locally

```bash
# Ingest Worker
pnpm --filter @hub/ingest-worker dev
# → http://localhost:8787

# Dashboard Worker (separate terminal)
pnpm --filter @hub/dashboard-worker dev
# → http://localhost:8788
```

Both Workers use the local D1 via `wrangler dev`. Migrations run
automatically on first start (per `wrangler.toml` `migrations_dir`).

## Seeding mock data

The deterministic seed generator lives in `packages/seed`. Run it via the
Vitest harness in `apps/ingest-worker/test/seed.test.ts`:

```bash
pnpm --filter @hub/ingest-worker test test/seed.test.ts
```

That test asserts the spec-mandated counts:

- 6 devices
- 36 financial accounts
- 600 raw_sms_events (with 25 OTP, 25 PROMO, 30 BANK_DEBIT, ≥ 25
  transaction candidates in DEBIT direction, 30 AMBIGUOUS, 40 duplicates,
  20 malformed, 10 parser failures)
- 350 payment_claims (10 FAKE_RECEIPT)
- ≥ 250 reconciliation_matches

## Running the SPA

```bash
# Build the React SPA once
pnpm --filter @hub/dashboard-web build
# → apps/dashboard-web/dist

# Dev mode with HMR + Vite proxy to the dashboard Worker
pnpm --filter @hub/dashboard-web dev
# → http://localhost:5173
```

The Vite dev server proxies `/api/*` to the dashboard Worker running on
`:8787`.

## Running the E2E test

```bash
# Install browsers (one time, downloads ~150 MB)
pnpm --filter @hub/dashboard-worker exec playwright install chromium

pnpm --filter @hub/dashboard-worker test:e2e
```

The test file lives at `apps/dashboard-worker/e2e/dashboard.spec.ts` and
mocks all `/api/*` responses so it does not require a real worker.

## Linting / formatting

This project does not enforce a specific formatter or linter yet — the
spec doesn't require one. Each package's `pnpm lint` exits 0 as a no-op.

## TypeScript

All packages extend `tsconfig.base.json` which enables `strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`verbatimModuleSyntax`, and other strict checks.

```bash
pnpm -r typecheck
```
