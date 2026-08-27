import { defineConfig } from 'vitest/config';
import { COVERAGE_FLOORS } from '../../vitest.coverage.js';

/**
 * Coverage floors live in `vitest.coverage.ts` at the repository root, with
 * the reason each number was chosen beside it. They are a RATCHET — their job
 * is to stop coverage falling, not to say where it should reach.
 *
 * `thresholds` only applies when `--coverage` is passed, so `pnpm test` is
 * unaffected; the gate runs `pnpm coverage`.
 */
const floor = COVERAGE_FLOORS['@shikoo/domain']!;

export default defineConfig({
  test: {
    // test/integration/* share one Postgres schema and TRUNCATE between cases.
    fileParallelism: false,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://shikoo:shikoo_local@127.0.0.1:5433/shikoo',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: {
        ...(floor.statements === null ? {} : { statements: floor.statements }),
        ...(floor.branches === null ? {} : { branches: floor.branches }),
        ...(floor.functions === null ? {} : { functions: floor.functions }),
      },
    },
  },
});
