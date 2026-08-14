/**
 * Security middleware for the dashboard Worker.
 *
 * Adds:
 *   - Strict-Transport-Security (HSTS) — 2 years, include subdomains.
 *   - X-Content-Type-Options: nosniff
 *   - X-Frame-Options: DENY (defense in depth alongside CSP frame-ancestors)
 *   - Referrer-Policy: strict-origin-when-cross-origin
 *   - Content-Security-Policy — locked down to self, no inline scripts.
 *     SPA bundles use only the bundled JS so 'unsafe-inline' is unnecessary.
 *   - Permissions-Policy — disables unused browser features.
 *
 * CSRF: the dashboard relies on Cloudflare Access for auth
 * (Cf-Access-Jwt-Assertion).
 * Cross-origin POSTs without a valid Access JWT are rejected by the auth
 * middleware, so no separate CSRF token is needed. State-changing endpoints
 * also reject cross-origin Origin headers that don't match the host.
 */

import type { MiddlewareHandler } from 'hono';

/**
 * The origins that may post to this worker from somewhere else.
 *
 * Same-origin is always allowed and is computed from the request, so this list
 * only ever names a SECOND host — the SPA on its own domain, and the two
 * development servers. It was four hard-coded strings including a
 * `.workers.dev` hostname that stops being ours the day the platform moves,
 * which is exactly the deploy this was blocking.
 *
 * `ALLOWED_ORIGINS` is read from the environment, comma-separated. An unset or
 * empty value leaves only same-origin and the development servers, which is the
 * safe direction to fail: a missing setting locks the second host out rather
 * than letting an unknown one in.
 */
const DEV_ORIGINS = ['http://localhost:8787', 'http://localhost:5173'];

export function allowedOrigins(configured: string | undefined): Set<string> {
  const extra = (configured ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
  return new Set([...DEV_ORIGINS, ...extra]);
}

function isApiPath(path: string): boolean {
  return path.startsWith('/api/');
}

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();

  // HSTS — 2 years, subdomains, preload-ready.
  c.res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');

  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  const csp = [
    `default-src 'self'`,
    `script-src 'self'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `connect-src 'self'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
  ].join('; ');

  c.res.headers.set('Content-Security-Policy', csp);

  c.res.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );
};

/**
 * Reject cross-origin POST/PUT/PATCH/DELETE from origins we don't recognise.
 * GET is not subject to CORS preflight, but the Access JWT requirement
 * already gates auth — this is defense in depth for state-changing paths.
 */
export const originGuard: MiddlewareHandler = async (c, next) => {
  const method = c.req.method.toUpperCase();

  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next();
  }

  if (!isApiPath(c.req.path)) {
    return next();
  }

  const origin = c.req.header('origin');

  // Accept curl, SDK, or server-to-server requests without Origin.
  if (!origin) {
    return next();
  }

  // Accept requests coming from the same origin as the Worker.
  const requestOrigin = new URL(c.req.url).origin;

  if (origin === requestOrigin) {
    return next();
  }

  // Accept explicitly configured alternative and development origins.
  const configured = (c.env as { ALLOWED_ORIGINS?: string } | undefined)?.ALLOWED_ORIGINS;
  if (!allowedOrigins(configured).has(origin)) {
    return c.json(
      {
        ok: false,
        error: 'cross_origin_forbidden',
      },
      403,
    );
  }

  return next();
};
