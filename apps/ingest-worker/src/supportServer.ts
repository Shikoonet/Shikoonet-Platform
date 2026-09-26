/**
 * The support bot's own service: `SERVICE=support`.
 *
 * The same door as `integrations/support.ts`, in a container and on a domain
 * of its own (Sam, 2026-09-26: not inside the SMS service). Whatever the
 * support bot does, it no longer shares a process with the bank-SMS path.
 * There is no SMS route here, no Mirzabot door and no sweep.
 *
 * It exists only to serve that door, so it refuses to boot with the door off.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { parseEnvName, resolveAppVersion } from '@shikoo/contracts';
import { createPostgresD1 } from '@shikoo/db';
import {
  createLogger,
  createPostgresEventSink,
  fixedWindowRateLimit,
  parseAlertChatId,
  setEventSink,
} from '@shikoo/domain';
import type { Env } from './index.js';
import { support, SUPPORT_BASE_PATH } from './integrations/support.js';
import { assertSupportDoorConfig, optional, positiveInt, required } from './server.js';

const log = createLogger('support');

export const supportApp = new Hono<{ Bindings: Env }>();
supportApp.get('/health', (c) => c.json({ ok: true }));
// What the deploy's smoke test asks: which build answers here.
supportApp.get('/version', (c) =>
  c.json({ ok: true, version: c.env.APP_VERSION ?? 'unknown', env: c.env.ENV_NAME ?? 'unknown' }),
);
supportApp.route(SUPPORT_BASE_PATH, support);

export function buildSupportEnv(db: Env['DB']): Env {
  const env: Env = {
    DB: db,
    // A wrong token is charged to its address, so a guesser slows down
    // without touching the caller that holds the token.
    IP_LIMIT: fixedWindowRateLimit({
      limit: positiveInt('IP_RATE_LIMIT', 120),
      windowMs: positiveInt('RATE_LIMIT_WINDOW_MS', 60_000),
    }),
    SUPPORT_LIMIT: fixedWindowRateLimit({
      limit: positiveInt('SUPPORT_RATE_LIMIT', 60),
      windowMs: 60_000,
    }),
    ENV_NAME: parseEnvName(optional('ENV_NAME')),
    APP_VERSION: resolveAppVersion(optional('APP_VERSION'), optional('SOURCE_COMMIT')),
  };
  for (const key of [
    'TRUSTED_PROXY_IP_HEADER',
    'SUPPORT_INTEGRATION_ENABLED',
    'SUPPORT_INTEGRATION_TOKEN',
  ] as const) {
    const value = optional(key);
    if (value !== undefined) env[key] = value;
  }
  if (env.SUPPORT_INTEGRATION_ENABLED !== 'true') {
    throw new Error(
      'SERVICE=support serves only the support door: set SUPPORT_INTEGRATION_ENABLED=true ' +
        'and SUPPORT_INTEGRATION_TOKEN, or do not run this service.',
    );
  }
  assertSupportDoorConfig(env);
  return env;
}

export function start(): { stop: () => Promise<void> } {
  const { db, pool } = createPostgresD1({ connectionString: required('DATABASE_URL') });
  setEventSink(
    createPostgresEventSink(db, { alertChatId: parseAlertChatId(process.env['ALERT_CHAT_ID']) }),
  );
  const env = buildSupportEnv(db);
  // Its own port, so the image's health check can tell it from the ingest.
  const port = positiveInt('PORT', 8789);
  const server = serve({
    fetch: (request: Request) => supportApp.fetch(request, env),
    port,
    hostname: process.env.HOST ?? '127.0.0.1',
  });
  log.info('boot.listening', { host: process.env.HOST ?? '127.0.0.1', port });
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
