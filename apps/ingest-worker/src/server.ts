/**
 * Node entry point — what `export default { fetch, scheduled }` used to be.
 *
 * The Hono app in index.ts is untouched: Hono runs on Node just as well as on
 * Workers, so the routes, validation and handlers all carry over as-is. Only
 * three platform pieces are replaced here:
 *
 *   the D1 binding  -> the Postgres adapter
 *   env bindings    -> process.env
 *   scheduled()     -> a plain interval
 *
 * This process listens on localhost only. The public edge is nginx (or a
 * Cloudflare Tunnel), which terminates TLS and applies the first layer of rate
 * limiting; the second layer lives in the app itself — see rateLimit.ts.
 */

import { serve } from '@hono/node-server';
import { createPostgresD1 } from '@shikoo/db';
import { app, runScheduledSweep, type Env } from './index.js';
import { fixedWindowRateLimit } from './rateLimit.js';

/** Fails loudly at boot rather than behaving oddly at 3am. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`);
  }
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

/** Optional settings, read straight from the environment by name. */
const PASSTHROUGH = [
  'INGEST_MAX_BODY_BYTES',
  'LOG_SMS_BODY',
  'MIRZABOT_INTEGRATION_ENABLED',
  'MIRZABOT_INTEGRATION_HMAC_SECRET',
  'MIRZABOT_INTEGRATION_ID',
  'AUTO_MATCH_ENABLED',
  'AUTO_FULFILLMENT_ENABLED',
  'MIRZABOT_WEBHOOK_URL',
] as const satisfies readonly (keyof Env)[];

export function buildEnv(db: Env['DB']): Env {
  const env: Env = {
    DB: db,
    // Per device and per client IP, matching the Cloudflare bindings they replace.
    DEVICE_LIMIT: fixedWindowRateLimit({
      limit: positiveInt('DEVICE_RATE_LIMIT', 60),
      windowMs: positiveInt('RATE_LIMIT_WINDOW_MS', 60_000),
    }),
    IP_LIMIT: fixedWindowRateLimit({
      limit: positiveInt('IP_RATE_LIMIT', 120),
      windowMs: positiveInt('RATE_LIMIT_WINDOW_MS', 60_000),
    }),
    ENV_NAME: optional('ENV_NAME') ?? 'local',
    APP_VERSION: optional('APP_VERSION') ?? 'dev',
  };
  // Assigned rather than spread so an unset variable stays absent instead of
  // present-and-undefined — the difference `exactOptionalPropertyTypes` cares
  // about, and the difference between "not configured" and "configured empty".
  for (const key of PASSTHROUGH) {
    const value = optional(key);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function start(): { stop: () => Promise<void> } {
  const { db, pool } = createPostgresD1({ connectionString: required('DATABASE_URL') });
  const env = buildEnv(db);

  const port = positiveInt('PORT', 8787);
  const server = serve({
    fetch: (request: Request) => app.fetch(request, env),
    port,
    hostname: process.env.HOST ?? '127.0.0.1',
  });

  // Was a Worker cron trigger. A failure here must not take the process down —
  // the sweep is retried on the next tick, and the SMS endpoint keeps serving.
  const everyMs = positiveInt('SWEEP_INTERVAL_MS', 60_000);
  const timer = setInterval(() => {
    void runScheduledSweep(env).catch((err: unknown) => {
      console.error('[sweep] failed', err);
    });
  }, everyMs);
  timer.unref();

  console.log(`ingest listening on ${process.env.HOST ?? '127.0.0.1'}:${port}`);

  return {
    async stop() {
      clearInterval(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}

// Only when run directly, so tests can import buildEnv without opening a port.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  start();
}
