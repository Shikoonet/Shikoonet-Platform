/**
 * Coverage floors for this package.
 *
 * The numbers live in `vitest.coverage.ts` at the repository root, together
 * with the reason each one was chosen and what it measured on the day it was
 * set. They are a RATCHET: their job is to stop coverage falling, not to
 * describe where it should get to.
 *
 * `thresholds` only applies when `--coverage` is passed, so `pnpm test`
 * is unaffected — the gate runs `pnpm coverage`.
 */

import { defineConfig } from 'vitest/config';
import { COVERAGE_FLOORS } from '../../vitest.coverage.js';

const floor = COVERAGE_FLOORS['@shikoo/sms-parser']!;

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // A report a human reads and one a machine reads. No lcov: it carries
      // absolute paths from the runner, and nothing here consumes it.
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
