import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Shares one Postgres with every other package's suite and truncates between
    // runs. Same reason as the ingest worker: parallel files wipe each other.
    fileParallelism: false,
    setupFiles: ['./test/helpers/setup.ts'],
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://shikoo:shikoo_local@127.0.0.1:5433/shikoo',
    },
  },
});
