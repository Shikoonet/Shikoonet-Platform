# D1 Isolate Root Cause — Diagnostic Evidence

Generated: 2026-08-04.

## Symptom

Three positive integration tests (`accepts a valid credit SMS`, `is idempotent on retry`, `redacts OTP bodies`) failed with HTTP 401 even though:

- The `beforeAll` seed in the test file logged the inserted device and credential.
- The seed's SELECT verified the row existed immediately after INSERT.

The two negative tests (`returns generic 401 on invalid apiKey`, `returns generic 401 on unknown device`) passed because they expected 401.

## Versions in play (from `pnpm ls`)

| Package                           | Version        |
| --------------------------------- | -------------- |
| `@cloudflare/vitest-pool-workers` | `0.5.34`       |
| `@cloudflare/workers-types`       | `4.20241112.0` |
| `vitest`                          | `2.1.4`        |
| `wrangler`                        | `4.106.0`      |
| `hono`                            | `4.6.7`        |
| `zod`                             | `3.23.8`       |

`compatibility_date = "2024-11-12"`, `compatibility_flags = ["nodejs_compat"]`.

## Diagnostic test (`test/diag.test.ts`)

Two patterns:

- **A**: insert a row via `env.DB.prepare(...).run()`, read it back via the same `env.DB`.
- **B**: insert via `env.DB.prepare(...).run()`, call `app.fetch(new Request('https://example.com/__diag'), env)`, have the Worker read the same row.

Both pass. Pattern B required a one-shot `/__diag` route handler that calls `c.env.DB.prepare(...).first(...)` — same env binding the test seeded.

```text
 ✓ test/diag.test.ts  (2 tests) 46ms
   ✓ D1 isolate diagnostic > A: env.DB reads its own insert
   ✓ D1 isolate diagnostic > B: Worker reads the same D1
```

## Why the previous tests failed

The failing tests called `SELF.fetch(...)`. `SELF` in `@cloudflare/vitest-pool-workers` dispatches through a fresh Worker isolate that does **not** share module-level state with the test file. Specifically:

1. The seed in `setupFiles` (and the earlier `beforeAll`) ran in the test module's isolate.
2. `SELF.fetch` enters a second isolate where `env.DB` is a **different** D1 binding instance — empty.
3. The Worker's `authenticateDevice` queried that empty D1 → returned `unknown_device` → generic 401.

`app.fetch(request, env)` is an in-isolate invocation: the Worker module is loaded into the test's own isolate, so `env.DB` is the same instance the test seeded.

## Decision: Option 2

Direct `app.fetch(request, env)` invocation. No `SELF.fetch`. No `setupFiles` for seeding.

Schema and seed now live in `beforeAll` inside the test file, using `env.DB` directly.

## Cleanup

The diagnostic `/__diag` route is removed after the integration test goes green. The diagnostic test file `test/diag.test.ts` is also removed.

## Binding-name audit

Single binding across the project: `DB` (D1). Matches `wrangler.toml`, the Worker `Env` interface, the test imports, and the migration script.
