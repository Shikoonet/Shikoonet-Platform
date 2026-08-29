import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { resolve } from 'node:path';

export default defineWorkersConfig({
  test: {
    // No setupFiles: schema + seed live in beforeAll inside each test file,
    // so they share the same isolate as the Worker invoked via app.fetch().
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          compatibilityFlags: ['nodejs_compat'],
          d1Persist: resolve(process.cwd(), '.wrangler/state/v3/d1'),
        },
      },
    },
  },
});
