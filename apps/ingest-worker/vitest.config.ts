import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These suites share one Postgres schema and truncate between runs, so they
    // must not execute concurrently with each other.
    fileParallelism: false,
    setupFiles: ['./test/helpers/setup.ts'],
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://shikoo:shikoo_local@127.0.0.1:5433/shikoo',
    },
  },
});
