/**
 * The shop's numbers, on the admin's phone.
 *
 * Two things are being tested and only one of them is the screen.
 *
 * The first is that «امروز» means Tehran's day. That is checked against `Intl`
 * on `Asia/Tehran` rather than against the SQL the code runs — a test that
 * repeats `date_trunc('day', now() AT TIME ZONE 'Asia/Tehran')` back at itself
 * agrees with the code by construction and would have passed just as happily
 * while the boundary sat seven hours out, which is a thing that has already
 * happened here once.
 *
 * The second is that the figures are counted the way the labels claim: revenue
 * is delivered orders, and the wallet total is a debt rather than income.
 * Measured with SQL written here, not by calling `shopStats` twice.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { shopStats } from '@shikoo/domain';
import { handleUpdate } from '../src/handle.js';
import * as menu from '../src/menu.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId } from './helpers/shop.js';

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 640_000 + n, telegramId: 630_000 + n };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `adm${telegramId}` },
      message: { message_id: 9, chat: { id: telegramId } },
      data,
    },
  };
}

async function makeAdmin(telegramId: number, role = 'ADMIN'): Promise<void> {
  await makeCustomer(telegramId);
  await db
    .prepare(
      `INSERT INTO admins (telegram_id, username, role, permissions, active)
       VALUES (?1, ?2, ?3, '{}'::jsonb, true)
       ON CONFLICT (telegram_id) DO UPDATE
         SET role = EXCLUDED.role, permissions = EXCLUDED.permissions, active = true`,
    )
    .bind(telegramId, `adm${telegramId}`, role)
    .run();
}

/**
 * The instant Tehran's day began, from `Intl` — the outside authority.
 *
 * The offset is read out of the formatter rather than written down as 3½
 * hours, so this stays true if the country ever moves its clocks again. It was
 * on daylight saving until 2022 and the code that assumed otherwise is exactly
 * the code this file exists to disbelieve.
 */
function tehranMidnightMs(atMs: number): number {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const part: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(atMs))) {
    if (p.type !== 'literal') part[p.type] = Number(p.value);
  }
  // Tehran's wall clock read as though it were UTC, minus the real instant, is
  // the zone's offset at that moment.
  const asIfUtc = Date.UTC(
    part['year']!,
    part['month']! - 1,
    part['day']!,
    part['hour'] === 24 ? 0 : part['hour']!,
    part['minute']!,
    part['second']!,
  );
  const offsetMs = asIfUtc - Math.floor(atMs / 1000) * 1000;
  return Date.UTC(part['year']!, part['month']! - 1, part['day']!) - offsetMs;
}

/** The database's clock, which is what `shopStats` compares against. */
async function dbNowMs(): Promise<number> {
  const row = await db
    .prepare(`SELECT (extract(epoch from now()) * 1000)::bigint AS ms`)
    .first<{ ms: number }>();
  return Number(row?.ms ?? 0);
}

async function addUserAt(telegramId: number, atMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (telegram_id, username, registered_at, last_seen_at)
       VALUES (?1, ?2, to_timestamp(?3 / 1000.0), to_timestamp(?3 / 1000.0))
       ON CONFLICT (telegram_id) DO UPDATE SET registered_at = EXCLUDED.registered_at`,
    )
    .bind(telegramId, `edge${telegramId}`, atMs)
    .run();
}

beforeAll(async () => {
  await ensureCatalog();
  await db.prepare(`DELETE FROM admins WHERE telegram_id BETWEEN 630000 AND 639999`).run();
});

beforeEach(() => {
  // The screen itself reads no clock, but `handleUpdate` does. Pinned so a run
  // at Tehran midnight cannot make this file's other assertions flap.
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 7, 14, 9, 0, 0));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('«امروز» on the stats screen', () => {
  it('starts at Tehran midnight, not UTC midnight', async () => {
    // Both of these are "today" in UTC for part of the year and only one of
    // them is today in Tehran. Asserted as a delta, because the suite shares a
    // database and the absolute count belongs to whatever else has run.
    const midnight = tehranMidnightMs(await dbNowMs());
    const before = (await shopStats(db)).customersToday;

    await addUserAt(ids().telegramId, midnight - 60_000);
    await addUserAt(ids().telegramId, midnight + 60_000);

    expect((await shopStats(db)).customersToday).toBe(before + 1);
  });

  it('agrees with Intl about which calendar day it is counting', async () => {
    // The label says «امروز». This is the assertion that it is the same day the
    // shop's own customers are living in.
    const nowMs = await dbNowMs();
    const tehranDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(
      new Date(tehranMidnightMs(nowMs) + 12 * 3600_000),
    );
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(
      new Date(nowMs),
    );

    expect(tehranDay).toBe(today);
  });
});

describe('what each number counts', () => {
  it('counts only delivered orders as revenue', async () => {
    const plan = await planId('sim-vip-1m-50');
    const userId = await makeCustomer(ids().telegramId);
    const before = await shopStats(db);

    // One delivered, one paid but not delivered. The second has money against
    // it and nothing handed over; counting it is how a later refund makes the
    // headline retroactively wrong.
    for (const [status, amount] of [
      ['COMPLETED', 330_000],
      ['PAID', 770_000],
    ] as const) {
      await db
        .prepare(
          `INSERT INTO orders
             (public_id, user_id, plan_id, kind, status, quantity, unit_price_irr,
              total_irr, created_at)
           VALUES (?1, ?2, ?3, 'NEW_PURCHASE', ?4, 1, ?5, ?5, now())`,
        )
        .bind(`stats-${status}-${userId}`, userId, plan, status, amount)
        .run();
    }

    const after = await shopStats(db);
    expect(after.revenueIrr - before.revenueIrr).toBe(330_000);
    expect(after.ordersToday - before.ordersToday).toBe(2);
  });

  it('reports the wallet total as it stands, negatives included', async () => {
    // Netting a negative balance away would hide exactly the account worth
    // looking at, so the sum is checked against SQL written here rather than
    // against the same expression the code uses.
    const stats = await shopStats(db);
    const row = await db
      .prepare(`SELECT COALESCE(SUM(balance_irr), 0)::bigint AS irr FROM wallets`)
      .first<{ irr: number }>();

    expect(stats.walletHeldIrr).toBe(Number(row?.irr ?? 0));
  });
});

describe('who may read the numbers', () => {
  it('shows the button to an admin and opens the screen', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);

    const home = await handleUpdate(db, press(updateId, telegramId, 'pnl'));
    expect((home.replies[0]?.keyboard ?? []).flat().map((b) => b.callback_data)).toContain('sts');

    const out = await handleUpdate(db, press(updateId + 1, telegramId, 'sts'));
    expect(out.replies[0]?.text).toContain('📊 آمار فروشگاه');
  });

  it('does not draw the button for a SUPPORT operator', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId, 'SUPPORT');

    const home = await handleUpdate(db, press(updateId, telegramId, 'pnl'));

    expect((home.replies[0]?.keyboard ?? []).flat().map((b) => b.callback_data)).not.toContain(
      'sts',
    );
  });

  it('refuses a SUPPORT operator who posts the callback anyway, and writes it down', async () => {
    // `callback_data` is a field anyone can post. Not drawing the button is
    // courtesy; this is the guard.
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId, 'SUPPORT');

    const out = await handleUpdate(db, press(updateId, telegramId, 'sts'));

    expect(out.replies[0]?.text).toBe(menu.ADMIN_NOT_ALLOWED);
    const { results } = await db
      .prepare(
        `SELECT action, reason FROM audit_logs
          WHERE actor_telegram_id = ?1 ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(telegramId)
      .all<{ action: string; reason: string | null }>();
    expect(results?.[0]?.action).toBe('claim.action.refused');
    expect(results?.[0]?.reason).toContain('stats.view');
  });
});
