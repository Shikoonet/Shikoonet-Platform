/**
 * Node entry point for the dashboard.
 *
 * The Hono app is untouched; only the platform edges change:
 *
 *   the D1 binding      -> the Postgres adapter
 *   env bindings        -> process.env
 *   wrangler [assets]   -> serveStatic over the SPA build
 *
 * Authentication is this deployment's own, as of 2026-08-16: a password, an
 * optional TOTP code and a session cookie, in `operatorSession.ts`. It replaced
 * Cloudflare Access, which used to stand in front of the origin — so the origin
 * is now the only wall, and `TEST_ACCESS_USER` below is refused in production
 * for that reason rather than out of tidiness.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { isRelaxedEnv, parseEnvName, resolveAppVersion } from '@shikoo/contracts';
import { createPostgresD1 } from '@shikoo/db';
import {
  createLogger,
  createPostgresEventSink,
  parseAlertChatId,
  setEventSink,
} from '@shikoo/domain';

const log = createLogger('dashboard');
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
  'ENABLE_PURCHASE_TYPE',
  'DEV_BLOCK_DEVICE_ADMIN',
  'INGEST_URL',
  // Comma-separated. Names the SPA's own host when it is served from a second
  // domain; same-origin never needs listing. Unset means "nowhere else".
  'ALLOWED_ORIGINS',
  // Which header the proxy sets to the real client address. See `clientIp`.
  'TRUSTED_PROXY_IP_HEADER',
  // The bot's token, for `GET /payment-claims/:id/receipt`. Absent, that one
  // route answers 503 with a sentence and everything else is unaffected.
  'TELEGRAM_BOT_TOKEN',
] as const satisfies readonly (keyof Env)[];

export function buildEnv(db: Env['DB']): Env {
  const env: Env = {
    DB: db,
    // Throws rather than defaulting: `?? 'local'` meant a typo switched off the
    // origin check, the cookie's Secure flag and the refusal below. See
    // `parseEnvName`.
    ENV_NAME: parseEnvName(optional('ENV_NAME')),
    // Falls back to the sha Coolify already injects — see `resolveAppVersion`.
    APP_VERSION: resolveAppVersion(optional('APP_VERSION'), optional('SOURCE_COMMIT')),
  };
  for (const key of PASSTHROUGH) {
    const value = optional(key);
    if (value !== undefined) env[key] = value;
  }
  // TEST_ACCESS_USER skips the login entirely. It is a local and Playwright
  // convenience and must never reach a deployed environment. Refused twice, on
  // purpose: here at startup, and again in `devBypassActive` at the moment an
  // identity would be granted — one refusal living in a single entry point is
  // how a bypass reaches production.
  //
  // Asked as an allowlist rather than `!== 'production'`: a staging box on the
  // public internet with the login skipped is open in exactly the way this is
  // meant to prevent, and it is not called production.
  const testUser = optional('TEST_ACCESS_USER');
  if (testUser !== undefined) {
    if (!isRelaxedEnv(env.ENV_NAME)) {
      throw new Error(
        `TEST_ACCESS_USER must not be set when ENV_NAME=${env.ENV_NAME} — it skips the ` +
          'login entirely and is only allowed in local and test.',
      );
    }
    env.TEST_ACCESS_USER = testUser;
  }
  warnAboutMissingGuards(env);
  return env;
}

/**
 * Says out loud which defences this configuration has switched off.
 *
 * `deploy/README.md:369` promises "the process says so in the log at boot",
 * and that was true of ingest and of nothing else. The dashboard read
 * `TRUSTED_PROXY_IP_HEADER` — it is in PASSTHROUGH above — and said nothing
 * when it was absent, so the one signal an operator has after a deploy did not
 * exist for the login wall.
 *
 * What is lost without it is not a nicety. `clientIp` returns null when the
 * header name is unset, and `operatorSession.ts` skips the whole per-IP branch
 * on a null — so `POST /api/v1/auth/login` keeps only the shop-wide limit, on a
 * panel that has been directly on the internet since Cloudflare Access left the
 * path on 2026-08-17. Every session row also records a null address, so the
 * audit cannot say where a login came from.
 *
 * A warning and not a refusal, for the same reason ingest chose one: refusing
 * to boot would take the whole panel down over a defence in depth. Off is
 * acceptable; off and silent is not.
 */
function warnAboutMissingGuards(env: Env): void {
  if (env.TRUSTED_PROXY_IP_HEADER === undefined) {
    log.warn('boot.trusted_proxy_unset', {
      consequence:
        'the per-IP rate limit on /api/v1/auth/login is OFF and session rows record no address; ' +
        'set TRUSTED_PROXY_IP_HEADER=X-Real-IP',
    });
  }
}

export function start(): { stop: () => Promise<void> } {
  const { db, pool } = createPostgresD1({ connectionString: required('DATABASE_URL') });
  setEventSink(
    createPostgresEventSink(db, { alertChatId: parseAlertChatId(process.env['ALERT_CHAT_ID']) }),
  );
  const env = buildEnv(db);

  // One build now. There used to be two mounts here — the payment hub at `/`
  // and the admin panel under `/admin/` — because they were two SPAs behind two
  // Cloudflare Access applications. They are one package as of 2026-08-16, so
  // `/` has nothing of its own left to serve and redirects.
  //
  // The Vite config sets `base: '/admin/'`, which is why the bundle's own asset
  // URLs land back inside this mount. `rewriteRequestPath` strips the prefix
  // because `dist/` has no `admin/` directory in it.
  const adminRoot = process.env.ADMIN_DIST ?? join(process.cwd(), '../admin-web/dist');
  app.use(
    '/admin/assets/*',
    serveStatic({ root: adminRoot, rewriteRequestPath: (p) => p.slice('/admin'.length) }),
  );
  // Vite copies everything in `public/` to the ROOT of dist, not into assets/ —
  // the logo, the favicon. Without this they fall through to the SPA fallback
  // and are answered with index.html: `/shikoonet-logo.png` used to return 853
  // bytes of HTML, so the header logo was a broken image on every screen. A
  // miss calls next(), so unknown paths still reach the fallback.
  app.use(
    '/admin/*',
    serveStatic({ root: adminRoot, rewriteRequestPath: (p) => p.slice('/admin'.length) }),
  );
  app.get('/admin', (c) => c.redirect('/admin/', 302));
  app.get('/admin/*', async (c, next) => {
    if (c.req.path.startsWith('/admin/assets/')) return next();
    try {
      return c.html(await readFile(join(adminRoot, 'index.html'), 'utf8'));
    } catch {
      return c.text(
        'Admin panel build not found — run `pnpm --filter @shikoo/admin-web build`',
        500,
      );
    }
  });

  // Everything that is not the API and not the panel is an address somebody
  // bookmarked before the merge — the payment hub's old home, or one of the
  // `?tab=` links its notification mails and its own bell have been handing out
  // for months. A redirect rather than a 404, and `?tab=` is what says the
  // bookmark meant the payments screen rather than the panel's front page.
  // `async` so both arms return a promise. Hono resolves the handler overload
  // from the return type, and a mix of `next()` and a bare `Response` matches
  // neither the handler nor the middleware signature.
  app.get('*', async (c, next) => {
    if (c.req.path.startsWith('/api/')) return next();
    const url = new URL(c.req.url);
    const section = url.searchParams.has('tab') ? 'payments' : '';
    return c.redirect(`/admin/${section}${url.search}`, 302);
  });

  const port = positiveInt('PORT', 8788);
  const server = serve({
    fetch: (request: Request) => app.fetch(request, env),
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
