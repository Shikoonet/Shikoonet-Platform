import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    // Playwright spec files live under e2e/ and e2e-acceptance/ and are run by
    // `pnpm test:e2e`, not by Vitest. Excluding them keeps vitest's runtime from
    // booting Playwright (which violates the "no async I/O in global scope" rule).
    exclude: ['node_modules/**', 'dist/**', 'e2e/**', 'e2e-acceptance/**'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: { compatibilityFlags: ['nodejs_compat'] },
      },
    },
  },
});
