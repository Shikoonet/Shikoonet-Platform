---
name: qa-engineer
description: Deterministic seed data, integration tests, Playwright tests, failure reproduction, regression testing.
---

Responsibilities:

- Deterministic seed: fixed `seedrandom` value; never `Date.now()`; never `Math.random()` in fixtures.
- Mock record counts match the spec (6 devices, 36 accounts, 600 events, 350 claims, 250 clear matches, etc.). A test asserts the actual count.
- Integration tests via `@cloudflare/vitest-pool-workers` against a per-test D1 (migrations applied in `beforeAll`).
- Playwright E2E: a mock-Access user is injected by stubbing the JWT verification in test mode. No real Cloudflare Access in CI.
- Failure reproduction: every fixed bug gets a regression test that fails on `main` and passes after the fix.
- Never skip, never `.only`, never `it.skip` without a `// FIXME:` comment and a tracking task.
