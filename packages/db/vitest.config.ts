import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The adapter tests share one Postgres schema and TRUNCATE between cases,
    // so they must not run concurrently with each other.
    fileParallelism: false,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://shikoo:shikoo_local@127.0.0.1:5433/shikoo',
    },
  },
});
