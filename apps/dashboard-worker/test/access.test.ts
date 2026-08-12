/**
 * Smoke test for the dashboard Worker.
 *
 * Auth: TEST_ACCESS_USER bypass is enabled by overriding env so the
 * middleware resolves a verified identity. RBAC paths then look up the
 * role from `access_users`.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
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

  it('allows same-origin POST (no Origin header) without CSRF block', async () => {
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
});
