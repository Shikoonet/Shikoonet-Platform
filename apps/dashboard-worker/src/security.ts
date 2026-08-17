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
import { isRelaxedEnv, type EnvName } from '@shikoo/contracts';

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

  // A request with no Origin at all proves nothing about where it came from,
  // so in production it is refused: this check is the only thing standing in
  // for a CSRF token, and an escape hatch that is opened by omitting the very
  // header being checked is not a check. Browsers send Origin on every POST,
  // PUT, PATCH and DELETE — same-origin ones included — so the dashboard loses
  // nothing. The Access JWT does not make this moot: the Access cookie rides
  // along on a cross-site request exactly as a session cookie would, which is
  // why an origin check is here in the first place.
  //
  // Open only in local and test, and that is a real limitation rather than a
  // tidy default. Every test in this package builds its requests the way curl
  // does, and closing the hatch everywhere turned 207 of them red for a hole
  // nothing can actually reach — a non-browser has no victim's cookie to ride.
  // So the protection is applied where it is worth having and the exception is
  // named here rather than discovered later. If those requests are ever made
  // browser-shaped, drop the condition.
  //
  // Asked as an allowlist: `!== 'production'` opened the hatch on staging, and
  // on any deployment whose ENV_NAME was mistyped.
  if (!origin) {
    const envName = (c.env as { ENV_NAME?: EnvName } | undefined)?.ENV_NAME;
    if (isRelaxedEnv(envName)) return next();
    return c.json({ ok: false, error: 'origin_required' }, 403);
  }

  // Accept requests coming from the same host as this service.
  //
  // Host, not origin, and the difference is the whole deployment. TLS ends at
  // Cloudflare and the tunnel forwards plain HTTP to the container, so
  // `new URL(c.req.url).origin` is `http://shikoo.mahamsteel.ir` while the
  // browser sends `https://shikoo.mahamsteel.ir`. Comparing the two strings
  // refused every write the panel made — «دسترسی‌ها» answered
  // `cross_origin_forbidden` on the first real deployment, 2026-08-16, and
  // measured against the container it was the scheme and nothing else.
  //
  // Dropping the scheme from the comparison costs nothing this check was
  // protecting. It stands in for a CSRF token; what it has to establish is that
  // the page making the request is *this* site. A page served over http from
  // this same host is already this site — reaching that position means holding
  // the DNS name, at which point an origin check is not what is left.
  //
  // The alternative was trusting `X-Forwarded-Proto` to rebuild the scheme,
  // which makes a security decision out of a header, or naming our own domain
  // in `ALLOWED_ORIGINS`, which would make "same-origin never needs listing"
  // false for every deployment and quietly break the next hostname too.
  let sameHost = false;
  try {
    sameHost = new URL(origin).host === new URL(c.req.url).host;
  } catch {
    // An unparseable Origin is not a same-host request; fall through.
  }
  if (sameHost) {
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
