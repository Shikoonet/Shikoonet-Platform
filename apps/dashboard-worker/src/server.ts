/**
 * Node entry point for the dashboard.
 *
 * The Hono app is untouched; only the platform edges change:
 *
 *   the D1 binding      -> the Postgres adapter
 *   env bindings        -> process.env
 *   wrangler [assets]   -> serveStatic over the SPA build
 *
 * Authentication is unchanged. `access.ts` still verifies a Cloudflare Access
 * JWT with `jose` against the issuer's JWKS, which works the same behind a
 * Cloudflare Tunnel as it did on Workers. The app never trusts an email header,
 * only a verified `email` claim.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createPostgresD1 } from '@shikoo/db';
import { app, type Env } from './index.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

const PASSTHROUGH = [
  'ACCESS_AUD',
  'ACCESS_ISSUER',
  'ENABLE_PURCHASE_TYPE',
  'DEV_BLOCK_DEVICE_ADMIN',
  'INGEST_URL',
] as const satisfies readonly (keyof Env)[];

export function buildEnv(db: Env['DB']): Env {
  const env: Env = {
    DB: db,
    ENV_NAME: optional('ENV_NAME') ?? 'local',
    APP_VERSION: optional('APP_VERSION') ?? 'dev',
  };
  for (const key of PASSTHROUGH) {
    const value = optional(key);
    if (value !== undefined) env[key] = value;
  }
  // TEST_ACCESS_USER bypasses JWT verification entirely. It is a local and
  // Playwright convenience and must never reach a deployed environment, so it
  // is only honoured when the app is not running as production.
  const testUser = optional('TEST_ACCESS_USER');
  if (testUser !== undefined) {
    if (env.ENV_NAME === 'production') {
      throw new Error('TEST_ACCESS_USER must not be set when ENV_NAME=production');
    }
    env.TEST_ACCESS_USER = testUser;
  }
  return env;
}

export function start(): { stop: () => Promise<void> } {
  const { db, pool } = createPostgresD1({ connectionString: required('DATABASE_URL') });
  const env = buildEnv(db);

  // wrangler mounted ../dashboard-web/dist as [assets]; here it is plain static
  // serving with an SPA fallback, because the dashboard has no router on the
  // server side — every unknown path is the same index.html.
  const spaRoot = process.env.SPA_DIST ?? join(process.cwd(), '../dashboard-web/dist');
  app.use('/assets/*', serveStatic({ root: spaRoot }));
  app.get('*', async (c, next) => {
    if (c.req.path.startsWith('/api/')) return next();
    try {
      const html = await readFile(join(spaRoot, 'index.html'), 'utf8');
      return c.html(html);
    } catch {
      return c.text('SPA build not found — run `pnpm --filter @shikoo/dashboard-web build`', 500);
    }
  });

  const port = positiveInt('PORT', 8788);
  const server = serve({
    fetch: (request: Request) => app.fetch(request, env),
    port,
    hostname: process.env.HOST ?? '127.0.0.1',
  });

  console.log(`dashboard listening on ${process.env.HOST ?? '127.0.0.1'}:${port}`);

  return {
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  start();
}
