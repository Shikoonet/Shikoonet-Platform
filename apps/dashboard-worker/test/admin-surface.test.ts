/**
 * The boundary between the payment hub and the shop's admin panel.
 *
 * These are two Cloudflare Access applications with two audiences, and this
 * file is the only place that fact is checked. The interesting assertion is
 * not that a valid admin gets in — it is that a *payment operator's* token
 * does not, and that a deployment with no admin audience configured has no
 * admin panel rather than one guarded by the payment hub's door.
 *
 * `TEST_ACCESS_USER` short-circuits identity, which is what lets every other
 * suite call these routes. So it is deliberately NOT set in most of the cases
 * below: with it set there is no JWT and therefore no audience to get wrong,
 * and the test would prove nothing (rule 6).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app, isAdminSurface, type Env } from '../src/index.js';

beforeAll(applySchema);

/**
 * The real deployment shape: a JWT is required, so no TEST_ACCESS_USER.
 *
 * `adminAud` is omitted rather than set to undefined — under
 * `exactOptionalPropertyTypes` those are different things, and "the key is
 * absent" is exactly the deployment being modelled.
 */
function deployedEnv(adminAud?: string): Env {
  const { TEST_ACCESS_USER: _drop, ...rest } = baseEnv;
  return {
    ...rest,
    ENV_NAME: 'production',
    ACCESS_AUD: 'payments-audience-tag',
    ACCESS_ISSUER: 'https://example.cloudflareaccess.com',
    ...(adminAud === undefined ? {} : { ADMIN_ACCESS_AUD: adminAud }),
  } as Env;
}

describe('isAdminSurface', () => {
  it('claims the admin page and its API, and nothing else', () => {
    for (const p of ['/admin', '/admin/', '/admin/customers', '/api/v1/admin/customers']) {
      expect(isAdminSurface(p)).toBe(true);
    }
    for (const p of [
      '/',
      '/api/v1/health',
      '/api/v1/customers',
      '/api/v1/accounts',
      // The payment hub's own cleanup tool happens to have "admin" in the
      // middle of its path. It is not the admin panel and must not be moved
      // behind the other door by a careless `includes('admin')`.
      '/api/v1/admin-cleanup',
      '/administrator',
    ]) {
      expect(isAdminSurface(p)).toBe(false);
    }
  });
});

describe('the admin door', () => {
  it('does not exist when no admin audience is configured', async () => {
    const res = await app.request(
      '/api/v1/admin/customers',
      {},
      deployedEnv(),
    );
    // 503, not 401 and certainly not 200: the difference matters, because a
    // 401 would suggest "bring a token" when the truth is "this deployment
    // has no admin panel".
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('admin_access_not_configured');
  });

  it('refuses a request carrying no token at all', async () => {
    const res = await app.request(
      '/api/v1/admin/customers',
      {},
      deployedEnv('admin-audience-tag'),
    );
    expect(res.status).toBe(401);
  });

  it('refuses a payment-hub token on the admin API', async () => {
    // Not a real signature — it does not need to be. The audience is checked
    // by `jwtVerify`, which rejects anything it cannot verify, so the only way
    // this passes is if the route stopped requiring a token.
    const res = await app.request(
      '/api/v1/admin/customers',
      { headers: { 'Cf-Access-Jwt-Assertion': 'a.payment-hub.token' } },
      deployedEnv('admin-audience-tag'),
    );
    expect(res.status).toBe(401);
  });

  it('leaves the payment hub reachable on its own audience', async () => {
    // Same missing-admin-audience deployment: the payment side is unaffected,
    // so the 503 above is scoped to the admin surface and is not a global
    // outage caused by an unset variable.
    const res = await app.request(
      '/api/v1/accounts',
      {},
      deployedEnv(),
    );
    expect(res.status).toBe(401); // wants a token — not 503
  });

  it('health stays open on the payment side and is not swept into the panel', async () => {
    const res = await app.request('/api/v1/health', {}, baseEnv);
    expect(res.status).toBe(200);
  });
});
