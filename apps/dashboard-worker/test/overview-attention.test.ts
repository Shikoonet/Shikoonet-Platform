/**
 * «چه چیزی مانده» — the dashboard's first question.
 *
 * The 2026-09-07 walk found the dashboard answering «how is the shop doing»
 * with six aggregates, and nothing at all about what needs a person. An
 * operator opening the panel had to visit «پرداخت‌ها», «لیست درخواست‌ها»,
 * «دستگاه‌ها» and «مدیریت پنل‌ها» one at a time to find out whether anything
 * was waiting — which is a dashboard that reports rather than one that works.
 *
 * Every count here is asserted against a query written separately from the
 * route. A figure that agrees with the code that produced it proves only that
 * the code is consistent with itself, which is the mistake this repository has
 * a rule about.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv, deleteFixtureUsers, FIXTURE_TG_BASE } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-attention@example.com';
const TG_BASE = FIXTURE_TG_BASE + 951_000_000;
let seq = 0;

function envAs(email: string) {
  return { DB: baseEnv.DB, ENV_NAME: 'local', TEST_ACCESS_USER: email } as never;
}

interface Attention {
  openClaims: number;
  pendingRequests: number;
  expiringSubscriptions7d: number;
  staleDevices: number;
  panelsWithoutSecret: number;
}

async function overview(): Promise<{ attention: Attention }> {
  const res = await app.request('/api/v1/admin/overview', {}, envAs(ADMIN));
  expect(res.status).toBe(200);
  return (await res.json()) as { attention: Attention };
}

async function makeUser(): Promise<number> {
  const telegramId = TG_BASE + ++seq;
  const row = await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, username, registered_at) VALUES (?1, ?2, now()) RETURNING id`,
  )
    .bind(telegramId, `zzattn_${seq}`)
    .first<{ id: number }>();
  return Number(row!.id);
}

async function purge(): Promise<void> {
  await deleteFixtureUsers(TG_BASE);
}

beforeAll(async () => {
  await applySchema();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
     VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
  )
    .bind(crypto.randomUUID(), ADMIN, Date.now())
    .run();
});

beforeEach(purge);
afterAll(purge);

describe('what still needs a person', () => {
  it('counts requests waiting for a decision, against the table', async () => {
    const before = (await overview()).attention.pendingRequests;

    for (let i = 0; i < 3; i++) {
      const userId = await makeUser();
      await baseEnv.DB.prepare(
        `INSERT INTO reseller_requests (user_id, description, status, created_at)
         VALUES (?1, 'می‌خواهم نماینده شوم', 'PENDING', now())`,
      )
        .bind(userId)
        .run();
    }
    // One already decided: it is not waiting for anybody.
    const decided = await makeUser();
    await baseEnv.DB.prepare(
      `INSERT INTO reseller_requests (user_id, description, status, created_at, decided_at)
       VALUES (?1, 'قبلاً', 'APPROVED', now(), now())`,
    )
      .bind(decided)
      .run();

    const counted = await baseEnv.DB.prepare(
      `SELECT count(*)::int AS n FROM reseller_requests WHERE status = 'PENDING'`,
    ).first<{ n: number }>();
    const after = (await overview()).attention.pendingRequests;
    expect(after).toBe(counted!.n);
    expect(after).toBe(before + 3);
  });

  it('counts services expiring inside seven days, and not the ones past that', async () => {
    const userId = await makeUser();
    for (const [days, status] of [
      [3, 'ACTIVE'],
      [6, 'ACTIVE'],
      // Outside the window — a renewal reminder, not something waiting today.
      [30, 'ACTIVE'],
      // Already gone: nothing to warn about.
      [2, 'REMOVED'],
    ] as const) {
      await baseEnv.DB.prepare(
        `INSERT INTO subscriptions
           (public_id, user_id, plan_name_at_sale, price_irr, status, purchased_at, expires_at)
         VALUES (?1, ?2, 'پلن', 1000, ?3, now(), now() + make_interval(days => ?4))`,
      )
        .bind(`zzattn-sub-${userId}-${days}-${status}`, userId, status, days)
        .run();
    }

    const counted = await baseEnv.DB.prepare(
      `SELECT count(*)::int AS n FROM subscriptions
        WHERE status = 'ACTIVE' AND expires_at IS NOT NULL
          AND expires_at BETWEEN now() AND now() + interval '7 days'`,
    ).first<{ n: number }>();
    expect((await overview()).attention.expiringSubscriptions7d).toBe(counted!.n);
  });

  it('carries the same open-claim figure the payments tab shows', async () => {
    // Not a second query. A badge and its list disagreeing is the oldest bug on
    // this surface, and the fix was to make them one number — so the dashboard
    // has to read that one rather than write a third.
    const a = (await overview()).attention.openClaims;
    const res = await app.request('/api/v1/payments?tab=open&page=1&pageSize=1', {}, envAs(ADMIN));
    const body = (await res.json()) as { counts?: { total?: { open?: number } } };
    expect(a).toBe(body.counts?.total?.open ?? 0);
  });

  it('answers every count even when there is nothing to report', async () => {
    // Zero is an answer. A missing key would make the screen draw «—» for a
    // shop with nothing waiting, which reads as «unknown» rather than «clear».
    const a = (await overview()).attention;
    for (const k of [
      'openClaims',
      'pendingRequests',
      'expiringSubscriptions7d',
      'staleDevices',
      'panelsWithoutSecret',
    ] as const) {
      expect(typeof a[k]).toBe('number');
    }
  });
});
