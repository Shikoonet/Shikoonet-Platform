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
import { parseEnvName, resolveAppVersion } from '@shikoo/contracts';
import { createPostgresD1 } from '@shikoo/db';
import {
  createLogger,
  createPostgresEventSink,
  parseAlertChatId,
  setEventSink,
} from '@shikoo/domain';

const log = createLogger('ingest');
import { fixedWindowRateLimit } from '@shikoo/domain';
import { app, runScheduledSweep, type Env } from './index.js';

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
  'TRUSTED_PROXY_IP_HEADER',
  'MIRZABOT_INTEGRATION_ENABLED',
  'MIRZABOT_INTEGRATION_HMAC_SECRET',
  'MIRZABOT_INTEGRATION_ID',
  'AUTO_MATCH_ENABLED',
  'AUTO_FULFILLMENT_ENABLED',
  'MIRZABOT_WEBHOOK_URL',
] as const satisfies readonly (keyof Env)[];

/**
 * The two switches that decide whether money is ever verified.
 *
 * Every consumer compares against the literal `'true'`, so anything else —
 * absent, `True`, `1`, `yes` — means off, and off is indistinguishable from
 * working: the SMS is stored, the transaction candidate is written, and no
 * claim is ever decided. No error, no log, no failed request. It cost an
 * afternoon on this machine on 2026-08-15 and it is documented in
 * `sim/README.md` precisely because it had already cost one before.
 */
const MUST_BE_DECIDED = [
  'MIRZABOT_INTEGRATION_ENABLED',
  'AUTO_MATCH_ENABLED',
  // Third for the same reason, found on 2026-08-18: absent reads as off, and
  // off means every auto-verified payment is a customer who paid and was never
  // given anything. The failure is silent on both sides — this hub records the
  // claim as VERIFIED and considers itself finished, while the legacy bot was
  // never told there was anything to fulfil.
  'AUTO_FULFILLMENT_ENABLED',
] as const;

/**
 * What silence on each switch actually costs, in the words of whoever has to
 * read it at 3am. Kept beside the names because a message that says only
 * "X is required" sends that person to the source to find out why.
 */
const CONSEQUENCE: Record<(typeof MUST_BE_DECIDED)[number], string> = {
  MIRZABOT_INTEGRATION_ENABLED:
    'the PHP bot posts claims and every one is refused, which from its end looks like an outage.',
  AUTO_MATCH_ENABLED:
    'a bank SMS is stored and a transaction is written, but no payment is ever verified.',
  AUTO_FULFILLMENT_ENABLED:
    'payments verify normally and the legacy bot is never told, so customers pay and receive nothing.',
};

/**
 * Refuses to start rather than to work.
 *
 * Only in production, and deliberately so: the simulation is started by hand a
 * dozen times a day with defaults that are written down, and demanding five
 * variables there would teach everyone to export them without reading them.
 */
function assertProductionConfig(env: Env): void {
  if (env.ENV_NAME !== 'production') return;

  const undecided = MUST_BE_DECIDED.filter((key) => env[key] !== 'true' && env[key] !== 'false');
  if (undecided.length > 0) {
    throw new Error(
      `${undecided.join(' and ')} must be set to exactly "true" or "false" when ` +
        'ENV_NAME=production — unset, or set to anything else, reads the same as ' +
        'false and says nothing. ' +
        undecided.map((key) => `${key}: ${CONSEQUENCE[key]}`).join(' '),
    );
  }

  if (env.MIRZABOT_INTEGRATION_ENABLED === 'true') {
    // `MIRZABOT_INTEGRATION_ID` falls back to 'mirzabot-test' where it is read,
    // so without this a production integration signs and records itself under a
    // test identity. The secret's absence is quieter still: every claim the PHP
    // bot posts is answered 503, which from the other end looks like an outage.
    const unconfigured = (
      ['MIRZABOT_INTEGRATION_HMAC_SECRET', 'MIRZABOT_INTEGRATION_ID'] as const
    ).filter((key) => env[key] === undefined);
    if (unconfigured.length > 0) {
      throw new Error(
        `${unconfigured.join(' and ')} must be set when MIRZABOT_INTEGRATION_ENABLED=true ` +
          'in production: the integration would otherwise answer every claim 503, or ' +
          'record itself as the test integration.',
      );
    }
  }

  // Said out loud once, because an operator who meant it should still see it in
  // the log they check after a deploy, next to the port and the version.
  for (const key of MUST_BE_DECIDED) {
    if (env[key] !== 'true') {
      log.warn('boot.switch_off', { switch: key, consequence: CONSEQUENCE[key] });
    }
  }

  // A warning rather than a refusal, and the line between them is what is
  // actually lost: without it the per-IP limit is skipped, while the device
  // credential and the per-device limit still stand. Refusing to boot would
  // take the only public endpoint down over a defence in depth — but it is off,
  // and off should be visible in the log the operator reads after a deploy.
  if (env.TRUSTED_PROXY_IP_HEADER === undefined) {
    log.warn('boot.trusted_proxy_unset', {
      consequence: 'the per-IP rate limit is OFF; set TRUSTED_PROXY_IP_HEADER=X-Real-IP',
    });
  }
}

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
    // Throws rather than defaulting: `?? 'local'` meant a typo switched off
    // every production guard below, silently. See `parseEnvName`.
    ENV_NAME: parseEnvName(optional('ENV_NAME')),
    // Falls back to the sha Coolify already injects — see `resolveAppVersion`.
    APP_VERSION: resolveAppVersion(optional('APP_VERSION'), optional('SOURCE_COMMIT')),
  };
  // Assigned rather than spread so an unset variable stays absent instead of
  // present-and-undefined — the difference `exactOptionalPropertyTypes` cares
  // about, and the difference between "not configured" and "configured empty".
  for (const key of PASSTHROUGH) {
    const value = optional(key);
    if (value !== undefined) env[key] = value;
  }
  // Validated here rather than trusted at the route. `Number.parseInt('8kb')`
  // is `NaN` and every comparison against NaN is false, so a plausible-looking
  // typo did not widen the cap on the only public endpoint — it removed it.
  // Read for its exception; the value itself is passed through as the string.
  if (env.INGEST_MAX_BODY_BYTES !== undefined) {
    positiveInt('INGEST_MAX_BODY_BYTES', 0);
  }
  assertProductionConfig(env);
  return env;
}

export function start(): { stop: () => Promise<void> } {
  const { db, pool } = createPostgresD1({ connectionString: required('DATABASE_URL') });
  // Registered before `buildEnv`, which is where the boot-time warnings are
  // raised — those are exactly the lines that must survive the container.
  setEventSink(
    createPostgresEventSink(db, { alertChatId: parseAlertChatId(process.env['ALERT_CHAT_ID']) }),
  );
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
      log.error('sweep.failed', {}, err);
    });
  }, everyMs);
  timer.unref();

  log.info('boot.listening', { host: process.env.HOST ?? '127.0.0.1', port });

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
