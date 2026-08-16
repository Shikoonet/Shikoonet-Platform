/**
 * Cloudflare Access JWT validation.
 *
 * Production path: fetch JWKS from `${ISSUER}/.well-known/jwks.json`, verify
 * the `Cf-Access-Jwt-Assertion` header with `jose.jwtVerify`. The dev/test
 * path: if `TEST_ACCESS_USER` is set in env, skip JWT verification and pin
 * that identity — useful for local development and Playwright.
 *
 * The Worker NEVER trusts an email header directly. Only the verified JWT
 * claim `email` is used as the actor identity.
 *
 * ## Two doors, not one
 *
 * The payment hub and the shop's admin panel are separate surfaces with
 * separate audiences. Each Cloudflare Access application issues a JWT whose
 * `aud` is that application's tag, so a token minted for the payment dashboard
 * simply does not verify against the admin panel's audience — the boundary is
 * the Access policy itself, enforced by the signature, not a role column
 * somebody can edit.
 *
 * That is why `expectedAudience` is a parameter rather than always
 * `env.ACCESS_AUD`. Passing the wrong one is not a soft failure: `jwtVerify`
 * rejects it.
 *
 * ## The development bypass yields to a real deployment
 *
 * `TEST_ACCESS_USER` skips verification entirely and returns an ADMIN. There is
 * a guard in `server.ts` that refuses to start when it is set alongside
 * `ENV_NAME=production`, and that guard is correct — but it lives in one entry
 * point and depends on somebody having remembered to set `ENV_NAME`. Two
 * omissions at once (a stray `TEST_ACCESS_USER` in the deployment environment
 * and a missing `ENV_NAME`) would open the whole panel to anyone who reached
 * the origin.
 *
 * So the bypass is also refused here, at the only place that can actually grant
 * an identity, whenever the deployment is configured for Cloudflare Access at
 * all: `ACCESS_ISSUER` is present only on a real deployment, and never in
 * `sim/.env.local`. A machine that has both is misconfigured, and the safe
 * reading of "verify against Access, but also trust this env var" is the
 * former.
 */

import type { AccessRole } from '@shikoo/contracts';
import type { D1Database } from '@shikoo/database';

export interface VerifiedIdentity {
  email: string;
  role: AccessRole;
}

/**
 * Whether the development identity bypass applies to this environment.
 *
 * Exported so the admin surface's "is this door configured at all" check and
 * the identity check cannot disagree about it. One of them concluding the
 * bypass is live while the other concludes it is not would mean a request that
 * passes the gate and then has no identity, or worse.
 */
export function devBypassActive(env: {
  TEST_ACCESS_USER?: string;
  ACCESS_ISSUER?: string;
}): boolean {
  return Boolean(env.TEST_ACCESS_USER) && !env.ACCESS_ISSUER;
}

export async function verifyAccess(
  req: Request,
  env: { TEST_ACCESS_USER?: string; ACCESS_AUD?: string; ACCESS_ISSUER?: string },
  expectedAudience?: string,
): Promise<VerifiedIdentity | null> {
  // Never on a deployment that has Access configured — see the header.
  if (devBypassActive(env)) {
    return { email: env.TEST_ACCESS_USER as string, role: 'ADMIN' };
  }
  const jwt = req.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return null;
  // An unset audience is a closed door, never an open one. The caller decides
  // which audience this surface requires; if it has none configured there is
  // nothing to verify against and the request does not get in.
  const audience = expectedAudience ?? env.ACCESS_AUD;
  if (!audience || !env.ACCESS_ISSUER) return null;
  try {
    const { jwtVerify, createRemoteJWKSet } = await import('jose');
    const jwks = createRemoteJWKSet(new URL(`${env.ACCESS_ISSUER}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(jwt, jwks, {
      audience,
      issuer: env.ACCESS_ISSUER,
    });
    const email = payload['email'];
    if (typeof email !== 'string') return null;
    return { email, role: 'ADMIN' }; // role comes from `access_users` table in real flow
  } catch {
    return null;
  }
}

/**
 * What a READ_ONLY operator may not read on the admin surface.
 *
 * Every write route on this surface is behind `role !== 'ADMIN'`, and every
 * *read* route was behind nothing at all: a READ_ONLY row could open a named
 * customer, their phone number, their wallet ledger and every order they have
 * ever placed. The only thing separating the roles was the audit trail, and a
 * record is not a guard — the same sentence the bot's admin panel earned.
 *
 * The line drawn here is the shop's operations versus its customers: the
 * catalogue, the panels, the bot's wording and the aggregate overview are
 * readable by anyone signed in, and anything that names a person is not. Moving
 * a path across that line is one entry in this list.
 *
 * Prefix-matched rather than checked per route, so a route added under
 * `/customers/` tomorrow is covered without anybody remembering.
 */
const PERSONAL_DATA_PREFIXES = [
  '/api/v1/admin/customers',
  '/api/v1/admin/orders',
  '/api/v1/admin/subscriptions',
  '/api/v1/admin/wallet-entries',
  '/api/v1/admin/reseller-requests',
  // Who may operate the shop is not an operations detail.
  '/api/v1/admin/access-users',
  '/api/v1/admin/bot-admins',
  // Nor is what the shop spends. Not personal data — the other reason a path is
  // on this list — but the same answer: `nav.ts` does not draw «هزینه‌ها و
  // تعدیل‌ها» for a READ_ONLY operator, and a section hidden in the sidebar
  // while the API still answers is decoration rather than a boundary.
  '/api/v1/admin/revenue-adjustments',
];

/**
 * Whether this role may read this path.
 *
 * Pure, and exported, so the rule can be asserted directly rather than only
 * through fifteen route tests that would each have to remember to exist.
 */
export function mayRead(path: string, role: AccessRole): boolean {
  if (role !== 'READ_ONLY') return true;
  if (PERSONAL_DATA_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return false;
  // The discount codes themselves are catalogue; who redeemed one is a name.
  return !path.endsWith('/redemptions');
}

export async function lookupRole(db: D1Database, email: string): Promise<AccessRole | null> {
  const row = await db
    .prepare(`SELECT role, active FROM access_users WHERE email = ?1`)
    .bind(email)
    .first<{ role: AccessRole; active: number }>();
  if (!row || row.active !== 1) return null;
  return row.role;
}
