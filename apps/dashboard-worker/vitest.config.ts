import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    // `e2e/` is Playwright's, and vitest's default glob claims every `*.spec.ts`
    // in the package. Left alone it collects the browser specs, fails on
    // `@playwright/test` and turns `pnpm test` red while reporting no failing
    // test — a suite that says "1 file failed, 464 tests passed".
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
    setupFiles: ['./test/helpers/setup.ts'],
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://shikoo:shikoo_local@127.0.0.1:5433/shikoo',
    },
  },
});
