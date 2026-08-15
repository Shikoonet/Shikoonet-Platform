/**
 * What a READ_ONLY operator may read.
 *
 * Every write route on the admin surface has been behind `role !== 'ADMIN'`
 * since it was written. Every read route was behind nothing: a READ_ONLY row
 * could open a named customer, their phone number, their wallet ledger and
 * every order they had ever placed. The role existed, was recorded in
 * `audit_logs`, and stopped nothing — the same "a record is not a guard" the
 * bot's admin panel was fixed for.
 *
 * Two halves, and both are needed. The table below is the rule itself, stated
 * once so it can be read; the requests underneath prove the rule is actually
 * wired into the middleware, because a pure function nothing calls is a rule
 * nobody follows.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';
import { mayRead } from '../src/access.js';

const ADMIN = 'admin@example.com';
const READER = 'read-only-suite@example.com';
const REVIEWER = 'reviewer-reads@example.com';

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

beforeAll(applySchema);

beforeEach(async () => {
  const now = Date.now();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [READER, 'READ_ONLY'],
    [REVIEWER, 'REVIEWER'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)
       ON CONFLICT (email) DO UPDATE SET role = excluded.role, active = 1`,
    )
      .bind(crypto.randomUUID(), email, role, now)
      .run();
  }
});

afterAll(async () => {
  await baseEnv.DB.prepare(`DELETE FROM access_users WHERE email IN (?1, ?2)`)
    .bind(READER, REVIEWER)
    .run();
});

/** Paths that name a person, and paths that describe the shop. */
const PERSONAL = [
  '/api/v1/admin/customers',
  '/api/v1/admin/customers/41',
  '/api/v1/admin/orders',
  '/api/v1/admin/subscriptions',
  '/api/v1/admin/wallet-entries',
  '/api/v1/admin/reseller-requests',
  '/api/v1/admin/discounts/7/redemptions',
  '/api/v1/admin/access-users',
  '/api/v1/admin/bot-admins',
];

const OPERATIONAL = [
  '/api/v1/admin/overview',
  '/api/v1/admin/products',
  '/api/v1/admin/product-categories',
  '/api/v1/admin/panels',
  '/api/v1/admin/discounts',
  '/api/v1/admin/settings',
  '/api/v1/admin/bot-texts',
  '/api/v1/admin/bot-keyboard/main',
];

describe('the rule', () => {
  it('keeps a READ_ONLY operator away from anything that names a person', () => {
    for (const path of PERSONAL) {
      expect(mayRead(path, 'READ_ONLY'), path).toBe(false);
    }
  });

  it('leaves the shop’s own operations readable', () => {
    for (const path of OPERATIONAL) {
      expect(mayRead(path, 'READ_ONLY'), path).toBe(true);
    }
  });

  it('does not apply to the roles that are meant to see customers', () => {
    for (const path of [...PERSONAL, ...OPERATIONAL]) {
      expect(mayRead(path, 'REVIEWER'), path).toBe(true);
      expect(mayRead(path, 'ADMIN'), path).toBe(true);
    }
  });

  it('covers a route under a personal prefix that does not exist yet', () => {
    // The point of matching prefixes rather than listing routes: route sixteen
    // inherits the rule without anybody remembering it.
    expect(mayRead('/api/v1/admin/customers/41/something-new', 'READ_ONLY')).toBe(false);
  });

  it('leaves the payment hub alone', () => {
    // A different Cloudflare Access audience with its own operators. This rule
    // is the shop panel's, and reaching into the hub would change who can work
    // a payment queue that has nothing to do with it.
    expect(mayRead('/api/v1/claims', 'READ_ONLY')).toBe(true);
    expect(mayRead('/api/v1/transactions', 'READ_ONLY')).toBe(true);
  });
});

describe('the rule, as the server applies it', () => {
  it('answers 403 to a reader and 200 to a reviewer, on the same path', async () => {
    // Through the real middleware. The table above could be perfect and
    // uncalled.
    for (const path of ['/api/v1/admin/customers', '/api/v1/admin/wallet-entries']) {
      const refused = await app.request(path, {}, envAs(READER));
      expect(refused.status, path).toBe(403);
      expect(((await refused.json()) as { detail: string }).detail).toContain('نقش شما');

      const allowed = await app.request(path, {}, envAs(REVIEWER));
      expect(allowed.status, path).toBe(200);
    }
  });

  it('still lets a reader see the catalogue', async () => {
    const res = await app.request('/api/v1/admin/products', {}, envAs(READER));
    expect(res.status).toBe(200);
  });

  it('refuses a reader’s write for the older reason too', async () => {
    // Belt and braces: the read guard would already have stopped this one, and
    // the route's own ADMIN check stops it again.
    const res = await app.request(
      '/api/v1/admin/customers/1/status',
      { method: 'POST', body: JSON.stringify({ status: 'BLOCKED' }) },
      envAs(READER),
    );
    expect(res.status).toBe(403);
  });
});
