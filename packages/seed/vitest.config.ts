import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `shop.test.ts` writes fixture rows and reads them back; two files doing
    // that at once on one database is a race for no gain. `guards.test.ts`
    // touches no database at all, so the cost is a few hundred milliseconds.
    fileParallelism: false,
    env: {
      // Same default as `apps/dashboard-worker`: the simulation Postgres, so
      // `pnpm test` works without `--env-file` while an explicit value still
      // wins. The seed's own `assertLocal` refuses anything that is not local,
      // which is the guard that makes a default connection string safe to ship.
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://shikoo:shikoo_local@127.0.0.1:5433/shikoo',
    },
  },
});
