import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    // `globals` and the setup file arrived with the payment hub's suite when the
    // two panels became one package. Its tests were written against them.
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    // Three times the `asyncUtilTimeout` in test/setup.ts, on purpose. When
    // the two were equal a `waitFor` that ran out of budget killed its test
    // first, and the report said «Test timed out» instead of what was not
    // found — the flake in issue #168 could not even be read. A test that
    // genuinely hangs still fails inside a quarter of a minute.
    testTimeout: 15_000,
  },
});
