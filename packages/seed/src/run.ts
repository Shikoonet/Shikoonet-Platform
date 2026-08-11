/**
 * Standalone seed runner.
 *
 *   pnpm --filter @shikoo/seed seed:dev
 *
 * Connects to the local D1 via wrangler, applies migrations, runs the
 * deterministic seed, prints row counts.
 */

/**
 * Standalone seed runner is not invoked from tests; the seed is run from
 * the Vitest harness in `apps/ingest-worker/test/seed.test.ts` which has
 * access to the workerd D1 binding and the migration SQL.
 */
export {};
