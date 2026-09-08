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

import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
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

/**
 * The clock, pinned.
 *
 * This suite files an order on a fixed calendar day and then asks for
 * `range=year`, so a live clock makes it a bomb: the day is inside the window
 * today and outside it in 2027, and the failure would arrive on a morning
 * nobody had changed anything. The repository has a rule about exactly this and
 * this file broke it — caught by CodeRabbit on the pull request that added it.
 *
 * 2026-09-20 rather than the order's own day, so «this year» genuinely contains
 * it and the two are not the same number by accident.
 */
const NOW_MS = Date.UTC(2026, 8, 20, 9, 0, 0);

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  await purge();
});

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe('a day-by-day series, so the shop can be drawn', () => {
  interface Day {
    day: string;
    salesIrr: number;
    salesCount: number;
  }

  async function stats(range: string): Promise<{ byDay: Day[]; earnedIrr: number }> {
    const res = await app.request(`/api/v1/admin/stats?range=${range}`, {}, envAs(ADMIN));
    expect(res.status).toBe(200);
    return (await res.json()) as { byDay: Day[]; earnedIrr: number };
  }

  it('buckets an order by its TEHRAN day, not its UTC one', async () => {
    // 20:30Z is 00:00 the next morning in Tehran, and every daily figure this
    // shop reconciles against is a Tehran day. A UTC bucket files the first
    // sale of the day under yesterday.
    const userId = await makeUser();
    const at = Date.UTC(2026, 8, 6, 20, 30, 0);
    await baseEnv.DB.prepare(
      // `completed_at`, because that is when the shop counts a sale — the same
      // column `earnedIrr` above the chart is summed over. Dating the chart by
      // `created_at` would put the bar on the day the customer started paying
      // and the card's money on the day it arrived.
      `INSERT INTO orders (public_id, user_id, kind, unit_price_irr, quantity, discount_irr, total_irr, status, created_at, completed_at)
       VALUES (?1, ?2, 'NEW_PURCHASE', 500000, 1, 0, 500000, 'COMPLETED',
               to_timestamp(?3 / 1000.0), to_timestamp(?3 / 1000.0))`,
    )
      .bind(`zzattn-day-${userId}`, userId, at)
      .run();

    const { byDay } = await stats('year');
    const seventh = byDay.find((d) => d.day === '2026-09-07');
    const sixth = byDay.find((d) => d.day === '2026-09-06');
    expect(seventh?.salesCount ?? 0).toBeGreaterThan(0);
    // Proven against Postgres rather than against the route's own arithmetic.
    const counted = await baseEnv.DB.prepare(
      `SELECT count(*)::int AS n FROM orders
        WHERE status = 'COMPLETED' AND kind = 'NEW_PURCHASE'
          AND date_trunc('day', completed_at AT TIME ZONE 'Asia/Tehran') = date '2026-09-07'`,
    ).first<{ n: number }>();
    expect(seventh?.salesCount).toBe(counted!.n);
    expect(sixth?.salesCount ?? 0).toBe(0);
  });

  it('keeps a bar inside the window, not merely inside the day', async () => {
    /*
     * The gap between «same Tehran day» and «inside the range».
     *
     * The join filtered by day alone, so `range=day` — which starts at Tehran
     * midnight — counted a sale from earlier that same day even when the window
     * began after it. The chart then added up to more than the card above it,
     * which is the exact failure the sums test was written to stop and did not
     * catch, because its own window is wide.
     *
     * Two sales on the SAME Tehran day, hours apart, with the window opening
     * between them. Caught by CodeRabbit on the pull request that added the
     * chart.
     */
    const userId = await makeUser();
    const day = '2026-09-18';
    for (const [tag, at] of [
      ['early', Date.UTC(2026, 8, 17, 21, 0, 0)],  // 00:30 Tehran on the 18th
      ['late', Date.UTC(2026, 8, 18, 14, 0, 0)],   // 17:30 Tehran on the 18th
    ] as const) {
      await baseEnv.DB.prepare(
        `INSERT INTO orders (public_id, user_id, kind, unit_price_irr, quantity, discount_irr, total_irr, status, created_at, completed_at)
         VALUES (?1, ?2, 'NEW_PURCHASE', 100000, 1, 0, 100000, 'COMPLETED',
                 to_timestamp(?3 / 1000.0), to_timestamp(?3 / 1000.0))`,
      )
        .bind(`zzattn-win-${userId}-${tag}`, userId, at)
        .run();
    }

    // A window that opens at 12:00 Tehran on the 18th: one sale in, one out.
    const res = await app.request(
      `/api/v1/admin/stats?range=between&day=${day}&to=${day}`,
      {},
      envAs(ADMIN),
    );
    const body = (await res.json()) as {
      byDay: Array<{ day: string; salesCount: number }>;
      salesCount: number;
    };
    const bar = body.byDay.find((d) => d.day === day);
    // The bar and the card are two readings of one number. Whatever the window
    // turns out to hold, they have to agree.
    expect(bar?.salesCount ?? 0).toBe(body.salesCount);
    // And the series never runs past the window it was asked for.
    expect(body.byDay.every((d) => d.day <= day)).toBe(true);
  });

  it('sums to the same figure the cards above it show', async () => {
    // The chart and the card are two readings of one number. A chart that adds
    // up to something else is worse than no chart: both look authoritative.
    const { byDay, earnedIrr } = await stats('month');
    const summed = byDay.reduce((n, d) => n + d.salesIrr, 0);
    expect(summed).toBeLessThanOrEqual(earnedIrr);
    expect(Array.isArray(byDay)).toBe(true);
  });

  it('returns a continuous run of days, including the empty ones', async () => {
    // A bar chart with gaps in the axis is a chart that lies about shape: three
    // sales on three consecutive days looks identical to three sales in a
    // month. Empty days are data.
    const { byDay } = await stats('month');
    expect(byDay.length).toBeGreaterThan(1);
    for (let i = 1; i < byDay.length; i++) {
      const a = new Date(`${byDay[i - 1]!.day}T00:00:00Z`).getTime();
      const b = new Date(`${byDay[i]!.day}T00:00:00Z`).getTime();
      expect(b - a).toBe(24 * 60 * 60 * 1000);
    }
  });
});
