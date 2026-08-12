import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 8788 is the dashboard worker, which serves every route this SPA calls
      // (/api/v1/payments, /analytics, /notifications, /version). 8787 is the
      // ingest worker and answers only POST /api/v1/sms, so pointing here made
      // `pnpm dev` return 500 for the whole dashboard.
      '/api': {
        target: 'http://localhost:8788',
        changeOrigin: true,
      },
    },
  },
});
