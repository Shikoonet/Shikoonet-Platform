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
 */

import type { AccessRole } from '@shikoo/contracts';
import type { D1Database } from '@shikoo/database';

export interface VerifiedIdentity {
  email: string;
  role: AccessRole;
}

export async function verifyAccess(
  req: Request,
  env: { TEST_ACCESS_USER?: string; ACCESS_AUD?: string; ACCESS_ISSUER?: string },
): Promise<VerifiedIdentity | null> {
  if (env.TEST_ACCESS_USER) {
    return { email: env.TEST_ACCESS_USER, role: 'ADMIN' };
  }
  const jwt = req.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return null;
  if (!env.ACCESS_AUD || !env.ACCESS_ISSUER) return null;
  try {
    const { jwtVerify, createRemoteJWKSet } = await import('jose');
    const jwks = createRemoteJWKSet(new URL(`${env.ACCESS_ISSUER}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(jwt, jwks, {
      audience: env.ACCESS_AUD,
      issuer: env.ACCESS_ISSUER,
    });
    const email = payload['email'];
    if (typeof email !== 'string') return null;
    return { email, role: 'ADMIN' }; // role comes from `access_users` table in real flow
  } catch {
    return null;
  }
}

export async function lookupRole(db: D1Database, email: string): Promise<AccessRole | null> {
  const row = await db
    .prepare(`SELECT role, active FROM access_users WHERE email = ?1`)
    .bind(email)
    .first<{ role: AccessRole; active: number }>();
  if (!row || row.active !== 1) return null;
  return row.role;
}
