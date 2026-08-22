/**
 * The one door, and the boundary that now has to hold on its own.
 *
 * This file used to check that two Cloudflare Access applications with two
 * audiences kept the payment hub and the shop's admin panel apart — a payment
 * operator's token simply did not verify against the admin panel, because the
 * boundary was a signature.
 *
 * Access is gone (Sam, 2026-08-16) and the two panels are merging into one, so
 * there is one door. That makes these assertions more important rather than
 * less: what used to be enforced by a JWT audience is now enforced by a session
 * cookie plus `mayRead`, and nothing else. Every case below is therefore about
 * what a *signed-in* operator can reach, not about who can sign in.
 *
 * `TEST_ACCESS_USER` short-circuits identity, which is what lets every other
 * suite call these routes. It is deliberately absent from the production-shaped
 * cases: with it set there is no session to get wrong and the test would prove
 * nothing (rule 6).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv, signIn } from './helpers/env.js';
import { app, isAdminSurface, type Env } from '../src/index.js';

beforeAll(applySchema);

/** The real deployment shape: a session is required, so no TEST_ACCESS_USER. */
function deployedEnv(): Env {
  const { TEST_ACCESS_USER: _drop, ...rest } = baseEnv;
  return { ...rest, ENV_NAME: 'production' } as Env;
}

describe('the development identity bypass', () => {
  it('is ignored on a production deployment', async () => {
    // The two-mistake case `server.ts` cannot catch on its own: it refuses to
    // start when ENV_NAME=production and TEST_ACCESS_USER are set together, but
    // that is one entry point. The identity path refuses it too.
    const env = { ...deployedEnv(), TEST_ACCESS_USER: 'attacker@example.com' } as Env;
    for (const path of ['/api/v1/admin/customers', '/api/v1/customers']) {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(401);
    }
  });

  it('still works where the deployment is not production', async () => {
    // Local development and every other suite in this package rely on it, so
    // the hardening must not amount to "TEST_ACCESS_USER never works".
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
    )
      .bind(crypto.randomUUID(), 'bypass-dev@example.com', Date.now())
      .run();

    const res = await app.request('/api/v1/admin/customers', {}, {
      ...baseEnv,
      ENV_NAME: 'local',
      TEST_ACCESS_USER: 'bypass-dev@example.com',
    } as Env);
    expect(res.status).toBe(200);
  });

  it('grants the role the table says, not ADMIN', async () => {
    // The bypass used to hand back ADMIN unconditionally, which made it
    // stronger than any real login and meant a READ_ONLY case could not be
    // tested through it at all.
    await baseEnv.DB.prepare(
      `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, 'READ_ONLY', 1, ?3, ?3)
       ON CONFLICT (email) DO UPDATE SET role = 'READ_ONLY', active = 1`,
    )
      .bind(crypto.randomUUID(), 'bypass-reader@example.com', Date.now())
      .run();

    const res = await app.request('/api/v1/admin/customers', {}, {
      ...baseEnv,
      TEST_ACCESS_USER: 'bypass-reader@example.com',
    } as Env);
    expect(res.status).toBe(403);
  });
});

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
      // middle of its path. It is not the admin panel and must not be swept
      // into the READ_ONLY personal-data rule by a careless `includes('admin')`.
      '/api/v1/admin-cleanup',
      '/administrator',
    ]) {
      expect(isAdminSurface(p)).toBe(false);
    }
  });
});

describe('the one door', () => {
  it('refuses a request carrying no cookie at all', async () => {
    const res = await app.request('/api/v1/admin/customers', {}, deployedEnv());
    expect(res.status).toBe(401);
  });

  it('refuses a cookie that is not a session', async () => {
    const res = await app.request(
      '/api/v1/admin/customers',
      { headers: { cookie: 'shikoo_session=not-a-real-token' } },
      deployedEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('lets a signed-in ADMIN through', async () => {
    const cookie = await signIn('door-admin@example.com', 'ADMIN');
    const res = await app.request(
      '/api/v1/admin/customers',
      { headers: { cookie } },
      deployedEnv(),
    );
    expect(res.status).toBe(200);
  });

  it('refuses a signed-in READ_ONLY the customers list', async () => {
    // What the two Access audiences used to do, now done by `mayRead`. This is
    // the assertion that has to survive the merge: one door means the role is
    // the only thing left between an operator and a customer's name.
    const cookie = await signIn('door-reader@example.com', 'READ_ONLY');
    const res = await app.request(
      '/api/v1/admin/customers',
      { headers: { cookie } },
      deployedEnv(),
    );
    expect(res.status).toBe(403);
  });

  it('still lets that READ_ONLY operator read the catalogue', async () => {
    // So the refusal above is a boundary rather than a blanket denial — the
    // other half, without which "refuse everything" would pass.
    const cookie = await signIn('door-reader@example.com', 'READ_ONLY');
    const res = await app.request('/api/v1/admin/products', { headers: { cookie } }, deployedEnv());
    expect(res.status).toBe(200);
  });

  it('stops honouring a session the moment it is revoked', async () => {
    const cookie = await signIn('door-revoked@example.com', 'ADMIN');
    const before = await app.request(
      '/api/v1/admin/customers',
      { headers: { cookie } },
      deployedEnv(),
    );
    expect(before.status).toBe(200);

    await baseEnv.DB.prepare(
      `UPDATE operator_sessions SET revoked_at = now()
        WHERE access_user_id = (SELECT id FROM access_users WHERE email = ?1)`,
    )
      .bind('door-revoked@example.com')
      .run();

    const after = await app.request(
      '/api/v1/admin/customers',
      { headers: { cookie } },
      deployedEnv(),
    );
    // Not "one more request then closed": the lookup and the liveness check are
    // the same statement precisely so there is no window here.
    expect(after.status).toBe(401);
  });

  it('stops honouring a session when the operator is deactivated', async () => {
    const cookie = await signIn('door-disabled@example.com', 'ADMIN');
    await baseEnv.DB.prepare(`UPDATE access_users SET active = 0 WHERE email = ?1`)
      .bind('door-disabled@example.com')
      .run();
    const res = await app.request(
      '/api/v1/admin/customers',
      { headers: { cookie } },
      deployedEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('leaves the payment hub behind the same door', async () => {
    const res = await app.request('/api/v1/accounts', {}, deployedEnv());
    expect(res.status).toBe(401);
  });

  it('health stays open, because the container probes it from inside', async () => {
    const res = await app.request('/api/v1/health', {}, deployedEnv());
    expect(res.status).toBe(200);
  });

  it('serves the page itself without a session, or nobody could ever log in', async () => {
    // The change Access forced. It used to serve the login page; now the SPA
    // does, so the document and its assets must be reachable signed out.
    const res = await app.request('/admin/', {}, deployedEnv());
    expect(res.status).not.toBe(401);
  });
});
