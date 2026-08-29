# Test Strategy

What we test, how, and why.

## Layers

```
┌─────────────────────────────────────────┐
│ E2E (Playwright)                        │  apps/dashboard-worker/e2e/
│   - Dashboard 15-step happy path        │
│   - Mocks API responses                 │
├─────────────────────────────────────────┤
│ Worker integration (Vitest + Miniflare) │  apps/*/test/
│   - Hono app.fetch(req, env)            │
│   - Real D1 binding in test scope       │
├─────────────────────────────────────────┤
│ Domain units                            │  packages/domain/test/
│   - State machines                      │
│   - Reconciliation scoring              │
├─────────────────────────────────────────┤
│ Parser units                            │  packages/sms-parser/test/
│   - Normalization                       │
│   - Each parser                         │
└─────────────────────────────────────────┘
```

## Unit tests

- **`packages/sms-parser/test/`** — 24 tests across `normalize.test.ts`
  (Persian/Arabic digits, ZWNJ/NBSP, thousand separators, currency
  detection, ambiguity, multi-amount) and `parsers.test.ts` (OTP wins,
  promo, credit/debit/balance, unknown, ambiguous currency, account hint
  extraction, reference extraction).
- **`packages/domain/test/`** — 13 tests across `state.test.ts` (7
  transaction/claim/match transitions, `IllegalTransitionError`) and
  `score.test.ts` (6 scoring scenarios including exact match, ambiguous,
  wrong direction, time penalty, suggestion decision).

These tests have no Workers runtime. Plain Vitest in Node.

## Worker integration tests

- **`apps/ingest-worker/test/integration.test.ts`** — 12 tests, all
  exercising the full request → D1 → response cycle. Schema is applied
  in `beforeAll` via `env.DB.prepare(stmt).run()`, devices are seeded
  the same way. The Worker is invoked via `app.fetch(request, env)` so
  the test module and the Worker share the same D1 binding instance.

- **`apps/dashboard-worker/test/access.test.ts`** — 7 tests covering
  auth bypass, RBAC, security headers, and origin guard.

- **`apps/ingest-worker/test/seed.test.ts`** — 2 tests asserting the
  deterministic seed generator's row counts.

### Why `app.fetch` (Option 2) and not `SELF.fetch` (Option 3)

The original harness used `SELF.fetch(...)`, which enters a fresh Worker
isolate. Setup-file seed inserts were not visible to `authenticateDevice`
inside the worker because each isolate gets its own D1 binding instance.
See `docs/verification/d1-isolate-root-cause.md` for the full diagnosis.

`app.fetch(request, env)` invokes the Worker module in the test's own
isolate, so the seed inserts are visible. There is no setupFiles phase —
schema and rows are inserted in `beforeAll` inside the test file.

## E2E tests

- **`apps/dashboard-worker/e2e/dashboard.spec.ts`** — a single 15-step
  test that drives the React SPA through:

  1. Visit
  2. Header check
  3. Matches tab
  4. Match card visible
  5. Click match
  6. Type + submit comment
  7. Comment visible
  8. Approve
  9. Success
  10. Today tab
  11. Devices tab
  12. Accounts tab
  13. Force 401
  14. Force 403
  15. Refresh

  All `/api/*` calls are mocked. The test runs without a real worker.
  Execute with `pnpm --filter @hub/dashboard-worker test:e2e`.

## What's NOT tested

- **Real Cloudflare Access JWT verification** — uses `jose.jwtVerify`
  against a JWKS, which requires a real Cloudflare Access app. The
  `TEST_ACCESS_USER` bypass covers local + CI.
- **D1 migrations on a fresh DB** — the `applySchema` helper applies
  statements sequentially; the production path uses
  `wrangler d1 migrations apply DB`. Migration equivalence is verified
  by the `applyD1Migrations` helper in the seed test setup.
- **Network latency, real browser quirks** — Playwright covers the
  latter; the former is a load-test concern out of scope.

## Coverage goals

- 100% of the security-critical paths (auth, RBAC, OTP redaction,
  apiKey handling).
- ≥ 80% line coverage on the parser.
- Every parser has at least one positive and one negative test.

## CI

This repo has no CI config yet. The spec's deployment verification
expects:

```bash
pnpm -r typecheck
pnpm -r test
pnpm --filter @hub/dashboard-web build
pnpm --filter @hub/ingest-worker exec wrangler deploy --dry-run
pnpm --filter @hub/dashboard-worker exec wrangler deploy --dry-run
```
