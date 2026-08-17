/**
 * Smoke test for the dashboard Worker.
 *
 * Auth: TEST_ACCESS_USER bypass is enabled by overriding env so the
 * middleware resolves a verified identity. RBAC paths then look up the
 * role from `access_users`.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv, signIn } from './helpers/env.js';
import { app } from '../src/index.js';

// Schema now comes from migrations/000*.sql, applied to the test database.

beforeAll(async () => {
  await applySchema();
});

describe('dashboard worker — access smoke', () => {
  it('rejects unauthenticated request (TEST_ACCESS_USER disabled)', async () => {
    const envLocked = { ...baseEnv, TEST_ACCESS_USER: '' };
    const r = await app.fetch(
      new Request('https://example.com/api/v1/today', {
        headers: { 'cf-access-authenticated-user-email': '' },
      }),
      envLocked,
    );
    expect(r.status).toBe(401);
  });

  it('accepts authenticated request via TEST_ACCESS_USER bypass', async () => {
    const email = 'admin@example.com';
    const now = Date.now();
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
    )
      .bind(crypto.randomUUID(), email, now)
      .run();

    const envBypass = { ...baseEnv, TEST_ACCESS_USER: email };
    const r = await app.fetch(new Request('https://example.com/api/v1/today'), envBypass);
    expect(r.status).toBe(200);
  });

  it('rejects malformed match/approve body with 400', async () => {
    const email = 'admin@example.com';
    // Re-seed admin row defensively — lookupRole fails closed if missing.
    const now = Date.now();
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
    )
      .bind(crypto.randomUUID(), email, now)
      .run();

    const envBypass = { ...baseEnv, TEST_ACCESS_USER: email };
    const r = await app.fetch(
      new Request('https://example.com/api/v1/match/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ garbage: true }),
      }),
      envBypass,
    );
    expect(r.status).toBe(400);
  });

  it('rejects READ_ONLY role from /match/approve with 403', async () => {
    const email = 'viewer@example.com';
    const now = Date.now();
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?1, ?2, 'READ_ONLY', 1, ?3, ?3)`,
    )
      .bind(crypto.randomUUID(), email, now)
      .run();

    const envBypass = { ...baseEnv, TEST_ACCESS_USER: email };
    const r = await app.fetch(
      new Request('https://example.com/api/v1/match/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          transactionCandidateId: crypto.randomUUID(),
          matchId: crypto.randomUUID(),
        }),
      }),
      envBypass,
    );
    expect(r.status).toBe(403);
  });

  it('attaches security headers to API responses', async () => {
    const email = 'admin@example.com';
    const now = Date.now();
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
    )
      .bind(crypto.randomUUID(), email, now)
      .run();
    const envBypass = { ...baseEnv, TEST_ACCESS_USER: email };
    const r = await app.fetch(new Request('https://example.com/api/v1/today'), envBypass);
    expect(r.headers.get('Strict-Transport-Security')).toContain('max-age=');
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(r.headers.get('X-Frame-Options')).toBe('DENY');
    expect(r.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(r.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(r.headers.get('Permissions-Policy')).toContain('camera=()');
  });

  it('rejects cross-origin POST from an unrecognised origin', async () => {
    const email = 'admin@example.com';
    const now = Date.now();
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
    )
      .bind(crypto.randomUUID(), email, now)
      .run();
    const envBypass = { ...baseEnv, TEST_ACCESS_USER: email };
    const r = await app.fetch(
      new Request('https://example.com/api/v1/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ entityType: 'MATCH', entityId: 'x', body: 'y' }),
      }),
      envBypass,
    );
    expect(r.status).toBe(403);
  });

  it('allows a POST with no Origin outside production, which is how this suite writes', async () => {
    // Kept, and its name changed to say what it actually asserts. Every test in
    // this package constructs requests the way curl does rather than the way a
    // browser does, so this is a statement about the harness, not a statement
    // that no-Origin writes are acceptable.
    const email = 'admin@example.com';
    const now = Date.now();
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
    )
      .bind(crypto.randomUUID(), email, now)
      .run();
    const envBypass = { ...baseEnv, TEST_ACCESS_USER: email };
    const r = await app.fetch(
      new Request('https://example.com/api/v1/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entityType: 'MATCH',
          entityId: crypto.randomUUID(),
          body: 'test comment',
        }),
      }),
      envBypass,
    );
    expect(r.status).toBe(200);
  });

  it('refuses a write with no Origin once ENV_NAME is production', async () => {
    // The guard this pair exists for. `originGuard` is the only stand-in for a
    // CSRF token on these routes, and it used to be skippable by simply not
    // sending the header it inspects.
    const email = 'admin@example.com';
    const now = Date.now();
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
    )
      .bind(crypto.randomUUID(), email, now)
      .run();
    const envProd = { ...baseEnv, TEST_ACCESS_USER: email, ENV_NAME: 'production' };
    const r = await app.fetch(
      new Request('https://example.com/api/v1/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entityType: 'MATCH',
          entityId: crypto.randomUUID(),
          body: 'test comment',
        }),
      }),
      envProd,
    );
    expect(r.status).toBe(403);
  });

  it('refuses a write with no Origin on staging too, and refuses the bypass there', async () => {
    // Both halves of the old `!== 'production'` reading, in one request.
    //
    // `TEST_ACCESS_USER` is set here and must not grant an identity — under the
    // old comparison staging counted as development, so this request would have
    // been signed in as an admin AND allowed to skip the Origin check. Either
    // one alone is a hole; a staging box on the public internet had both.
    const email = 'admin@example.com';
    const now = Date.now();
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
    )
      .bind(crypto.randomUUID(), email, now)
      .run();
    const envStaging = { ...baseEnv, TEST_ACCESS_USER: email, ENV_NAME: 'staging' as const };
    const r = await app.fetch(
      new Request('https://example.com/api/v1/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entityType: 'MATCH',
          entityId: crypto.randomUUID(),
          body: 'test comment',
        }),
      }),
      envStaging,
    );
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: 'origin_required' });

    // And with a correct Origin it is still refused — this time for want of an
    // identity, which proves the bypass did not apply either.
    const withOrigin = await app.fetch(
      new Request('https://example.com/api/v1/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://example.com' },
        body: JSON.stringify({
          entityType: 'MATCH',
          entityId: crypto.randomUUID(),
          body: 'test comment',
        }),
      }),
      envStaging,
    );
    expect(withOrigin.status).toBe(401);
  });

  it('still allows the write the SPA really makes, in production', async () => {
    // The other half, so "refuse no Origin" cannot be satisfied by refusing
    // everything: the request a browser actually sends must still succeed.
    const email = 'admin@example.com';
    const now = Date.now();
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
    )
      .bind(crypto.randomUUID(), email, now)
      .run();
    // No TEST_ACCESS_USER: the bypass is refused under ENV_NAME=production, which
    // is the point of it. A production-shaped request needs a real session.
    const cookie = await signIn(email);
    const envProd = { ...baseEnv, TEST_ACCESS_USER: '', ENV_NAME: 'production' };
    const r = await app.fetch(
      new Request('https://example.com/api/v1/comment', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://example.com', cookie },
        body: JSON.stringify({
          entityType: 'MATCH',
          entityId: crypto.randomUUID(),
          body: 'test comment',
        }),
      }),
      envProd,
    );
    expect(r.status).toBe(200);
  });

  it('allows the SPA write when TLS ended at the proxy and the container saw http', async () => {
    // The deployed shape, which the test above cannot reach because it builds
    // the request and the Origin from the same string.
    //
    // Behind the Cloudflare Tunnel there is no TLS on the last hop: the browser
    // sends `Origin: https://<host>` and the container is handed a plain http
    // request for the same host. Comparing whole origins made those two
    // unequal, and every write from the panel came back `cross_origin_forbidden`
    // on the first real deployment — «دسترسی‌ها» could list operators and not
    // add one. Measured against the running container on 2026-08-16: identical
    // requests differing only in the Origin's scheme, one refused, one not.
    const email = 'admin@example.com';
    const now = Date.now();
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
    )
      .bind(crypto.randomUUID(), email, now)
      .run();
    const cookie = await signIn(email);
    const envProd = { ...baseEnv, TEST_ACCESS_USER: '', ENV_NAME: 'production' };
    const r = await app.fetch(
      new Request('http://shikoo.example/api/v1/comment', {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          origin: 'https://shikoo.example',
        },
        body: JSON.stringify({
          entityType: 'MATCH',
          entityId: crypto.randomUUID(),
          body: 'test comment',
        }),
      }),
      envProd,
    );
    expect(r.status).toBe(200);
  });

  it('still refuses a different host, whatever the scheme', async () => {
    // So the fix above is "ignore the scheme", not "ignore the origin".
    const envProd = { ...baseEnv, TEST_ACCESS_USER: 'admin@example.com', ENV_NAME: 'production' };
    for (const origin of ['https://evil.example', 'http://evil.example']) {
      const r = await app.fetch(
        new Request('http://shikoo.example/api/v1/comment', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin },
          body: JSON.stringify({ entityType: 'MATCH', entityId: crypto.randomUUID(), body: 'x' }),
        }),
        envProd,
      );
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ error: 'cross_origin_forbidden' });
    }
  });
});
