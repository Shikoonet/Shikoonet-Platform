/**
 * Node entry point. Reads config, opens one pool, polls until told to stop.
 *
 * Same boot discipline as the ingest worker: a missing setting fails here,
 * loudly, rather than producing odd behaviour at 3am.
 */

import { createPostgresD1 } from '@shikoo/db';
import { run } from './poll.js';
import { createTelegramApi, TELEGRAM_API_BASE } from './telegram.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
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

export function start(): { stop: () => Promise<void> } {
  const { db, pool } = createPostgresD1({ connectionString: required('DATABASE_URL') });
  const api = createTelegramApi({
    // Never logged, never echoed back — see telegram.ts.
    token: required('TELEGRAM_BOT_TOKEN'),
    baseUrl: process.env.TELEGRAM_API_BASE ?? TELEGRAM_API_BASE,
  });

  const controller = new AbortController();
  const finished = run(db, api, {
    timeoutSec: positiveInt('TELEGRAM_POLL_TIMEOUT_SEC', 25),
    signal: controller.signal,
  });

  console.log('bot polling');

  return {
    async stop() {
      controller.abort();
      await finished;
      await pool.end();
    },
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const { stop } = start();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void stop().then(() => process.exit(0));
    });
  }
}
