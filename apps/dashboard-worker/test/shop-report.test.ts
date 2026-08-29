/**
 * The «آمار» screen, checked against rows this file put in the database.
 *
 * The figures are asserted against **hand-counted expectations written beside
 * the fixtures**, never against a second call to the same aggregation. A test
 * that says `shopReport('today').salesIrr === shopReport('today').salesIrr`
 * proves the function is deterministic and nothing else — and this repository
 * has already shipped a timezone bug that survived exactly that shape of test
 * for months.
 *
 * The window boundaries matter more than the sums here, so every fixture is
 * placed at a **deliberate offset from a pinned clock**: inside today, inside
 * yesterday, and one two months back that no button except «آمار کل» may see.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { statsRangeBounds } from '@shikoo/domain';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-stats@example.com';
const READER = 'readonly-stats@example.com';

/** 2026-08-29T08:00:00Z — 11:30 in Tehran, comfortably mid-day either side. */
const NOW_MS = Date.UTC(2026, 7, 29, 8, 0, 0);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `NOW_MS - 61 days`, in Tehran. See the fixture note for why it is that far back. */
const RENEWAL_ONLY_DAY = '?range=day&day=2026-06-29';

/** Everything this file writes is prefixed so the purge can find it all. */
const PREFIX = 'zz-stats-';

const envAs = (email: string) => ({ ...baseEnv, TEST_ACCESS_USER: email });
const get = (path: string, email = ADMIN) => app.request(path, {}, envAs(email));

const db = baseEnv.DB;

interface Report {
  ok: boolean;
  salesCount: number;
  salesIrr: number;
  renewalsCount: number;
  renewalsIrr: number;
  topupsIrr: number;
  buyers: number;
  newCustomers: number;
  conversionPercent: number;
  avgPerBuyerIrr: number;
  renewalSharePercent: number;
  projectedMonthlyIrr: number;
  projectionDays: number;
  resellers: number;
  panels: number;
  activeSubscriptions: number;
  walletHeldIrr: number;
  gateways: { method: string; count: number; irr: number }[];
  notMeasured: { label: string; reason: string }[];
  startMs: number | null;
  endMs: number | null;
}

const report = async (query = ''): Promise<Report> => {
  const res = await get(`/api/v1/admin/stats${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Report;
};

/**
 * What each window reported **before** this file inserted anything.
 *
 * `shopReport` aggregates whole tables, so it cannot be scoped to one test's
 * rows. Asserting absolute totals therefore only worked on an empty database —
 * and it passed for exactly as long as the run happened to follow a truncation.
 * Seeding the simulation before the suite turned every sum red at once, which
 * is the good outcome: a test that depends on what else is in the database is
 * a test that will fail on somebody else's Tuesday.
 *
 * So the assertions below are about **this file's own contribution**: the
 * baseline is captured first and subtracted. Counts of things this file did not
 * create are checked with `toBeGreaterThanOrEqual`, never with equality.
 */
const before = new Map<string, Report>();

const delta = async (query: string, field: keyof Report): Promise<number> => {
  const now = (await report(query))[field] as number;
  const was = before.get(query)![field] as number;
  return now - was;
};

/** A user whose registration instant we control. */
async function user(tag: string, registeredAtMs: number, isReseller = false): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO users (telegram_id, username, is_reseller, registered_at)
            VALUES (?1, ?2, ?3, to_timestamp(?4 / 1000.0))
         RETURNING id`,
    )
    .bind(Number(`9${Math.abs(hash(tag)) % 100000000}`), `${PREFIX}${tag}`, isReseller, registeredAtMs)
    .first<{ id: number }>();
  return row!.id;
}

/** A completed order of a given kind, at a given instant. */
async function order(
  userId: number,
  kind: 'NEW_PURCHASE' | 'RENEWAL' | 'WALLET_TOPUP',
  totalIrr: number,
  completedAtMs: number,
  tag: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO orders (public_id, user_id, kind, quantity, unit_price_irr,
                           discount_irr, total_irr, status, created_at, completed_at)
            VALUES (?1, ?2, ?3, 1, ?4, 0, ?4, 'COMPLETED',
                    to_timestamp(?5 / 1000.0), to_timestamp(?5 / 1000.0))`,
    )
    .bind(`${PREFIX}${tag}`, userId, kind, totalIrr, completedAtMs)
    .run();
}

async function payment(
  userId: number,
  method: string,
  amountIrr: number,
  createdAtMs: number,
  tag: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO payments (public_id, user_id, amount_irr, method, status, created_at)
            VALUES (?1, ?2, ?3, ?4, 'PAID', to_timestamp(?5 / 1000.0))`,
    )
    .bind(`${PREFIX}${tag}`, userId, amountIrr, method, createdAtMs)
    .run();
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

async function purge(): Promise<void> {
  await db.prepare(`DELETE FROM payments WHERE public_id LIKE '${PREFIX}%'`).run();
  await db.prepare(`DELETE FROM orders   WHERE public_id LIKE '${PREFIX}%'`).run();
  await db.prepare(`DELETE FROM users    WHERE username  LIKE '${PREFIX}%'`).run();
}

/**
 * The fixture, and the arithmetic the assertions below are checked against.
 *
 * ```
 *                        when            kind           IRR
 *   ann    today 06:00   NEW_PURCHASE   1,000,000
 *   ann    today 07:00   RENEWAL          200,000
 *   bob    today 05:00   NEW_PURCHASE     500,000
 *   bob    today 07:30   WALLET_TOPUP     300,000   ← never a sale, never a buyer
 *   cid    yesterday     NEW_PURCHASE   2,000,000
 *   dee    62 days ago   NEW_PURCHASE   9,000,000   ← only «آمار کل» sees this
 *   eve    61 days ago   RENEWAL          700,000   ← renewal with no sale beside it
 * ```
 *
 * `eve` exists for one reason: her day holds a renewal and no purchase, which is
 * the shape that made «۱ buyer, ۰ average» appear on the live screen. Without a
 * window like it, counting renewers as buyers passes every other assertion here
 * — which it did, until this row was added.
 *
 * **Why 61 days and not 2.** That day is named by calendar date, and the one
 * assertion below that cannot be expressed as a delta — a ratio has no
 * baseline to subtract — reads the window's absolute figure. So the day has to
 * be one nothing else can write into. `pnpm seed:sim` runs before this suite
 * and places its rows at offsets from the **real** clock, not from `NOW_MS`:
 * its 3,000,000 purchase sits at `now − 71h`, which on 2026-08-29 crossed
 * Tehran midnight at 19:30 UTC and landed inside the day this test used to
 * name. Green all afternoon, red from 19:37 onwards, on a commit that changed
 * one line of a README. The seed reaches 30 days back at most; 61 is past it,
 * and 62 is taken by `dee`.
 */
beforeAll(async () => {
  await applySchema();
  await purge();

  // `access_users.created_at` is epoch milliseconds, not a timestamp column.
  const now = Date.now();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [READER, 'READ_ONLY'],
  ] as const) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
      )
      .bind(crypto.randomUUID(), email, role, now)
      .run();
  }

  // Read AFTER the operators exist, because the baseline is fetched over HTTP
  // and an unauthenticated read is a 401 rather than a zero. Reversed, this file
  // passed alone — `access_users` still held the rows a previous run left — and
  // failed the moment the whole package ran and truncated the table first.
  // The clock has to be pinned for the baseline too, or «today» means one day
  // when the baseline is taken and another when it is compared against.
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  for (const q of [
    '?range=all',
    '?range=today',
    '?range=yesterday',
    '?range=1h',
    '?range=month',
    '?range=day&day=2026-08-28',
    RENEWAL_ONLY_DAY,
  ]) {
    before.set(q, await report(q));
  }
  vi.restoreAllMocks();


  const ann = await user('ann', NOW_MS - 3 * DAY_MS);
  const bob = await user('bob', NOW_MS - 2 * HOUR_MS);
  const cid = await user('cid', NOW_MS - DAY_MS);
  const dee = await user('dee', NOW_MS - 62 * DAY_MS, true);

  await order(ann, 'NEW_PURCHASE', 1_000_000, NOW_MS - 5 * HOUR_MS, 'o1');
  await order(ann, 'RENEWAL', 200_000, NOW_MS - 4 * HOUR_MS, 'o2');
  await order(bob, 'NEW_PURCHASE', 500_000, NOW_MS - 6 * HOUR_MS, 'o3');
  await order(bob, 'WALLET_TOPUP', 300_000, NOW_MS - 30 * 60 * 1000, 'o4');
  await order(cid, 'NEW_PURCHASE', 2_000_000, NOW_MS - DAY_MS, 'o5');
  await order(dee, 'NEW_PURCHASE', 9_000_000, NOW_MS - 62 * DAY_MS, 'o6');

  const eve = await user('eve', NOW_MS - 40 * DAY_MS);
  await order(eve, 'RENEWAL', 700_000, NOW_MS - 61 * DAY_MS, 'o7');

  await payment(ann, 'CARD_TO_CARD', 1_000_000, NOW_MS - 5 * HOUR_MS, 'p1');
  await payment(bob, 'CARD_TO_CARD', 500_000, NOW_MS - 6 * HOUR_MS, 'p2');
  await payment(ann, 'ADMIN_CREDIT', 7_777_777, NOW_MS - 5 * HOUR_MS, 'p3');
});

afterAll(purge);

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

describe('the window decides what is counted', () => {
  it('today sees today and nothing older', async () => {
    // ann 1,000,000 + bob 500,000. cid was yesterday, dee two months ago.
    expect(await delta('?range=today', 'salesCount')).toBe(2);
    expect(await delta('?range=today', 'salesIrr')).toBe(1_500_000);
    expect(await delta('?range=today', 'renewalsCount')).toBe(1);
    expect(await delta('?range=today', 'renewalsIrr')).toBe(200_000);
  });

  it('yesterday sees only yesterday', async () => {
    expect(await delta('?range=yesterday', 'salesCount')).toBe(1);
    expect(await delta('?range=yesterday', 'salesIrr')).toBe(2_000_000);
    expect(await delta('?range=yesterday', 'renewalsCount')).toBe(0);
  });

  it('the last hour sees the half-hour-old top-up and no sale at all', async () => {
    expect(await delta('?range=1h', 'salesCount')).toBe(0);
    expect(await delta('?range=1h', 'salesIrr')).toBe(0);
    expect(await delta('?range=1h', 'topupsIrr')).toBe(300_000);
  });

  it('the two-month-old sale is invisible to every window except all', async () => {
    for (const q of ['?range=1h', '?range=today', '?range=yesterday', '?range=month']) {
      expect(await delta(q, 'salesIrr'), `${q} must not reach 62 days back`).toBeLessThan(
        9_000_000,
      );
    }
    expect(await delta('?range=all', 'salesIrr')).toBe(
      1_000_000 + 500_000 + 2_000_000 + 9_000_000,
    );
  });

  it('a named day is that Tehran day', async () => {
    expect(await delta('?range=day&day=2026-08-28', 'salesIrr')).toBe(2_000_000);
    expect((await report('?range=day&day=2026-08-28')).startMs).toBe(
      statsRangeBounds('yesterday', NOW_MS).start,
    );
  });

  it('an unknown range widens to all rather than failing', async () => {
    const r = await report('?range=nonsense');
    expect(r.startMs).toBeNull();
    expect(r.endMs).toBeNull();
  });
});

describe('the ratios are computed from the same window', () => {
  it('a top-up alone does not make somebody a buyer', async () => {
    // bob topped up today and also bought today, so he counts — but via the
    // purchase. ann bought too. Two buyers, not three, and never four.
    expect(await delta('?range=today', 'buyers')).toBe(2);
  });

  it('the last hour has a top-up and therefore still zero buyers', async () => {
    expect(await delta('?range=1h', 'buyers')).toBe(0);
  });

  it('never reports buyers without the money that made them buyers', async () => {
    // Found in the browser on 2026-08-29: a day whose only completed order was
    // a renewal read «۱ buyer» and «۰ average purchase». The two figures have
    // to describe one population or the average is an average of nothing.
    //
    // `cid` bought yesterday; `ann` renewed today. Yesterday is the window that
    // holds a purchase, so the hour-shaped check is the renewal-only one.
    // 27 August is the case: one renewal, no purchase. A renewer counted as a
    // buyer makes this window report somebody who bought nothing.
    const renewalOnly = await report(RENEWAL_ONLY_DAY);
    expect(await delta(RENEWAL_ONLY_DAY, 'renewalsCount')).toBe(1);
    expect(await delta(RENEWAL_ONLY_DAY, 'salesCount')).toBe(0);
    expect(await delta(RENEWAL_ONLY_DAY, 'buyers')).toBe(0);
    expect(renewalOnly.avgPerBuyerIrr).toBe(0);

    for (const range of ['all', 'today', 'yesterday', '1h', 'month']) {
      const r = await report(`?range=${range}`);
      if (r.buyers === 0) expect(r.avgPerBuyerIrr, range).toBe(0);
      else expect(r.salesIrr, `${range} has buyers but no sales`).toBeGreaterThan(0);
    }
  });

  it('average per buyer divides sales by buyers, not by orders', async () => {
    // This file adds 1,500,000 over two buyers — three orders, one of which was
    // a renewal and contributes to neither side.
    expect(await delta('?range=today', 'salesIrr')).toBe(1_500_000);
    expect(await delta('?range=today', 'buyers')).toBe(2);

    // And the published average is those two divided, whatever else is in the
    // table alongside them.
    const r = await report('?range=today');
    expect(r.avgPerBuyerIrr).toBe(Math.round(r.salesIrr / r.buyers));
  });

  it('renewal share is renewals over sales, and never exceeds one hundred', async () => {
    for (const q of ['?range=all', '?range=today', '?range=yesterday', '?range=1h']) {
      const r = await report(q);
      expect(r.renewalSharePercent, q).toBeGreaterThanOrEqual(0);
      expect(r.renewalSharePercent, q).toBeLessThanOrEqual(100);
      if (r.salesIrr > 0 && r.renewalsIrr <= r.salesIrr) {
        expect(r.renewalSharePercent, q).toBeCloseTo((r.renewalsIrr / r.salesIrr) * 100, 1);
      }
    }
  });

  it('the projection divides by the window, and says how many days it used', async () => {
    const today = await report('?range=today');
    expect(today.projectionDays).toBe(1);
    expect(today.projectedMonthlyIrr).toBe(today.salesIrr * 30);
  });
});

describe('the stocks do not move with the window', () => {
  it('reports the same now-figures whichever range is asked for', async () => {
    const [hour, all] = await Promise.all([report('?range=1h'), report('?range=all')]);

    for (const key of ['resellers', 'panels', 'activeSubscriptions', 'walletHeldIrr'] as const) {
      expect(hour[key], `${key} must not depend on the range`).toBe(all[key]);
    }
  });

  it('counts the reseller this file created', async () => {
    expect(await delta('?range=today', 'resellers')).toBe(1);
  });
});

describe('payment methods', () => {
  it('groups paid payments and leaves the admin adjustment out', async () => {
    const card = (r: Report) => r.gateways.find((g) => g.method === 'CARD_TO_CARD');
    const now = await report('?range=today');
    const was = before.get('?range=today')!;

    expect(card(now)!.count - (card(was)?.count ?? 0)).toBe(2);
    expect(card(now)!.irr - (card(was)?.irr ?? 0)).toBe(1_500_000);
    // 7,777,777 went in as ADMIN_CREDIT and must appear nowhere.
    expect(now.gateways.some((g) => g.method === 'ADMIN_CREDIT')).toBe(false);
  });
});

describe('what it refuses to guess', () => {
  it('names the figures it does not compute, with a reason each', async () => {
    const r = await report('?range=all');
    expect(r.notMeasured).toHaveLength(2);
    for (const item of r.notMeasured) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.reason.length).toBeGreaterThan(10);
    }
    // A zero would be indistinguishable from «none»; the point is that these
    // are absent, so no field of that name may appear on the payload.
    expect(r as unknown as Record<string, unknown>).not.toHaveProperty('resellersTypeN');
    expect(r as unknown as Record<string, unknown>).not.toHaveProperty('testAccounts');
  });
});

describe('who may read it', () => {
  it('answers a read-only operator — every field is an aggregate', async () => {
    const res = await get('/api/v1/admin/stats?range=today', READER);
    expect(res.status).toBe(200);
  });
});
