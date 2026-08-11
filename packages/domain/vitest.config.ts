import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // test/integration/* share one Postgres schema and TRUNCATE between cases.
    fileParallelism: false,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://shikoo:shikoo_local@127.0.0.1:5433/shikoo',
    },
  },
});
