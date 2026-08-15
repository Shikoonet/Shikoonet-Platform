import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These read the simulation MySQL and Postgres, so they must not run
    // alongside another package's suite on the same databases.
    fileParallelism: false,
    env: {
      // Here rather than as a fallback inside `loadConfig`, which is the whole
      // point: a destination this tool would invent for itself is a
      // destination it can silently target on a night when someone forgets to
      // export one. The convenience belongs to the tests, not to the migration.
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://shikoo:shikoo_local@127.0.0.1:5433/shikoo',
    },
  },
});
