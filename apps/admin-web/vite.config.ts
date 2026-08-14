import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// `base` is not cosmetic: the worker serves this build under /admin/, so the
// asset URLs Vite writes into index.html must be absolute from there. Left at
// the default "/" they point into the payment hub's asset folder and the panel
// loads a blank page with two 404s.
export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: { input: resolve(__dirname, 'index.html') },
  },
  server: {
    // Not 5173 — that is the payment hub's dev server, and two apps on one
    // port is the same mistake as two apps on one bundle.
    port: 5174,
    proxy: { '/api': { target: 'http://localhost:8788', changeOrigin: true } },
  },
});
