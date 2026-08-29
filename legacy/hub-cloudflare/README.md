# Payment Reconciliation Hub

Cloudflare-native payment reconciliation for a VPN business. Reads SMS forwarded by the existing [sms-relay](https://github.com/automagen-ab/sms-relay) Android app, classifies and parses them, matches against payment claims, and exposes an RTL React dashboard.

The Android app is **not** modified, forked, or rebuilt. See [`docs/current-app-contract.md`](docs/current-app-contract.md) for the exact wire format.

## Stack

- Cloudflare Workers (TypeScript, Hono)
- Cloudflare D1
- Cloudflare Access (dashboard auth)
- Cloudflare Workers Rate Limiting binding
- React + Vite + TypeScript (dashboard SPA)
- Vitest + `@cloudflare/vitest-pool-workers` for unit + integration
- Playwright for E2E

## Layout

```
apps/
  ingest-worker/      POST /api/v1/sms (public, API-key)
  dashboard-worker/   dashboard.example.com (Cloudflare Access)
packages/
  contracts/          shared types
  database/           D1 client helpers
  domain/             state machines, scoring
  sms-parser/         normalize + parsers + classifiers
migrations/           D1 SQL
docs/                 architecture, contracts, threat model
.claude/agents/       project subagents
```

## Quick start (local)

```bash
pnpm install
pnpm --filter @hub/ingest-worker exec wrangler d1 migrations apply DB --local
pnpm --filter @hub/dashboard-worker exec wrangler d1 migrations apply DB --local
pnpm --filter @hub/ingest-worker test
pnpm --filter @hub/ingest-worker dev
```

## Status

Vertical slice in progress. See [`docs/verification/final-report.md`](docs/verification/final-report.md) for current state and remaining work.
