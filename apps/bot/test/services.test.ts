/**
 * «سرویس های من» — the screen a customer opens more often than any other.
 *
 * Three things are being proved here, and only the first is a feature:
 *
 *   1. A customer can find the service they bought and read its link again.
 *   2. A customer CANNOT read anybody else's. This is the live Mirzabot bug
 *      (`subscriptionurl_<id>` loads by id alone, index.php:1252) reproduced as
 *      an attack rather than described in a comment.
 *   3. A dead service does not hand out a link that resolves to nothing. An
 *      expired or exhausted account still has a working URL on the panel, and
 *      giving it to a customer with no warning is how support gets "I imported
 *      it and it does not work".
 *
 * The clock is pinned, because `serviceState` compares against `Date.now()` and
 * a test whose expectations are tied to a real date is a test that goes red at
 * midnight for no reason.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import * as menu from '../src/menu.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer } from './helpers/shop.js';

/** 2026-08-13T12:00:00Z, a Thursday. Nothing depends on which day it is. */
const NOW_MS = Date.UTC(2026, 7, 13, 12, 0, 0);
const DAY = 86_400_000;
const GIB = 1024 ** 3;

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 660_000 + n, telegramId: 610_000 + n };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `svc${telegramId}` },
      message: { message_id: 55, chat: { id: telegramId } },
      data,
    },
  };
}

interface ServiceFixture {
  publicId: string;
  planName?: string;
  status?: string;
  url?: string | null;
  username?: string | null;
  volumeGb?: number | null;
  usedBytes?: number | null;
  /** Days from NOW_MS. Negative is in the past. Undefined means no expiry. */
  expiresInDays?: number;
  purchasedAtMs?: number;
}

async function makeService(userId: number, fixture: ServiceFixture): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, plan_name_at_sale, provider_name_at_sale, price_irr,
          remote_username, subscription_url, volume_gb, used_bytes,
          status, purchased_at, expires_at)
       VALUES (?1, ?2, ?3, 'لوکیشن تست', 1950000, ?4, ?5, ?6, ?7, ?8,
               to_timestamp(?9 / 1000.0), ?10)
       RETURNING id`,
    )
    .bind(
      fixture.publicId,
      userId,
      fixture.planName ?? 'یک‌ماهه-50گیگ',
      fixture.username === undefined ? 'u_test' : fixture.username,
      fixture.url === undefined ? 'https://panel.test/sub/u_test' : fixture.url,
      fixture.volumeGb === undefined ? 50 : fixture.volumeGb,
      fixture.usedBytes === undefined ? null : fixture.usedBytes,
      fixture.status ?? 'ACTIVE',
      fixture.purchasedAtMs ?? NOW_MS - 5 * DAY,
      fixture.expiresInDays === undefined
        ? null
        : new Date(NOW_MS + fixture.expiresInDays * DAY).toISOString(),
    )
    .first<{ id: number }>();
  if (!row) throw new Error('service fixture failed');
  return row.id;
}

/** A customer who has pressed /start, so the callback handler will answer them. */
async function customer(telegramId: number): Promise<number> {
  return makeCustomer(telegramId);
}

beforeAll(async () => {
  await ensureCatalog();
});

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the list', () => {
  it('says so plainly when the customer has nothing', async () => {
    const { updateId, telegramId } = ids();
    await customer(telegramId);

    const out = await handleUpdate(db, press(updateId, telegramId, 'mine'));

    expect(out.status).toBe('processed');
    expect(out.replies[0]?.text).toBe(menu.MY_SERVICES_EMPTY);
  });

  it('lists what they own, with a button that carries the row id', async () => {
    const { updateId, telegramId } = ids();
    const userId = await customer(telegramId);
    const subId = await makeService(userId, { publicId: `svc-${telegramId}-a` });

    const out = await handleUpdate(db, press(updateId, telegramId, 'mine'));

    expect(out.replies[0]?.text).toContain('1 مورد');
    const buttons = out.replies[0]?.keyboard?.flat() ?? [];
    expect(buttons.map((b) => b.callback_data)).toContain(`sub:${subId}`);
  });

  it('puts a service whose date has passed below a live one', async () => {
    // Found by opening the real screen, not by this suite: three services, all
    // `status = 'ACTIVE'`, and the one four days expired sat at the top. The
    // test below passed the whole time because it used a DISABLED row — the
    // one case where `status` actually moves.
    const { updateId, telegramId } = ids();
    const userId = await customer(telegramId);
    await makeService(userId, {
      publicId: `svc-${telegramId}-past`,
      planName: 'سرویس-گذشته',
      expiresInDays: -4,
      purchasedAtMs: NOW_MS - DAY,
    });
    await makeService(userId, {
      publicId: `svc-${telegramId}-now`,
      planName: 'سرویس-جاری',
      expiresInDays: 10,
      purchasedAtMs: NOW_MS - 30 * DAY,
    });

    const out = await handleUpdate(db, press(updateId, telegramId, 'mine'));

    expect(out.replies[0]?.keyboard?.[0]?.[0]?.text).toContain('سرویس-جاری');
  });

  it('puts a service with no volume left below a live one', async () => {
    const { updateId, telegramId } = ids();
    const userId = await customer(telegramId);
    await makeService(userId, {
      publicId: `svc-${telegramId}-drained`,
      planName: 'سرویس-خالی',
      volumeGb: 10,
      usedBytes: 10 * GIB,
      expiresInDays: 20,
      purchasedAtMs: NOW_MS - DAY,
    });
    await makeService(userId, {
      publicId: `svc-${telegramId}-full`,
      planName: 'سرویس-پر',
      volumeGb: 10,
      usedBytes: GIB,
      expiresInDays: 20,
      purchasedAtMs: NOW_MS - 30 * DAY,
    });

    const out = await handleUpdate(db, press(updateId, telegramId, 'mine'));

    expect(out.replies[0]?.keyboard?.[0]?.[0]?.text).toContain('سرویس-پر');
  });

  it('puts live services above dead ones', async () => {
    const { updateId, telegramId } = ids();
    const userId = await customer(telegramId);
    // The disabled one is newer, so purchase order alone would put it first.
    await makeService(userId, {
      publicId: `svc-${telegramId}-dead`,
      status: 'DISABLED',
      planName: 'سرویس-خاموش',
      purchasedAtMs: NOW_MS - DAY,
    });
    await makeService(userId, {
      publicId: `svc-${telegramId}-live`,
      planName: 'سرویس-زنده',
      purchasedAtMs: NOW_MS - 30 * DAY,
    });

    const out = await handleUpdate(db, press(updateId, telegramId, 'mine'));

    const first = out.replies[0]?.keyboard?.[0]?.[0]?.text ?? '';
    expect(first).toContain('سرویس-زنده');
  });

  it('does not list a purchase that was never paid for', async () => {
    const { updateId, telegramId } = ids();
    const userId = await customer(telegramId);
    await makeService(userId, {
      publicId: `svc-${telegramId}-unpaid`,
      status: 'PENDING_PAYMENT',
    });

    const out = await handleUpdate(db, press(updateId, telegramId, 'mine'));

    expect(out.replies[0]?.text).toBe(menu.MY_SERVICES_EMPTY);
  });
});

describe('paging, for the resellers who need it', () => {
  // Production: one customer has 45 services and four have more than ten.
  const TOTAL = menu.SERVICES_PER_PAGE + 2;

  it('splits a long list and both pages are reachable', async () => {
    const { updateId, telegramId } = ids();
    const userId = await customer(telegramId);
    for (let i = 0; i < TOTAL; i++) {
      await makeService(userId, {
        publicId: `svc-${telegramId}-${i}`,
        planName: `سرویس-${i}`,
        purchasedAtMs: NOW_MS - i * DAY,
      });
    }

    const first = await handleUpdate(db, press(updateId, telegramId, 'mine'));
    expect(first.replies[0]?.text).toContain(`${TOTAL} مورد`);
    expect(first.replies[0]?.text).toContain('صفحهٔ 1 از 2');
    const firstButtons = first.replies[0]?.keyboard ?? [];
    // 8 services + one paging row + one back row.
    expect(firstButtons.filter((row) => row[0]?.callback_data?.startsWith('sub:'))).toHaveLength(
      menu.SERVICES_PER_PAGE,
    );
    expect(firstButtons.flat().map((b) => b.callback_data)).toContain('mine:2');

    const second = await handleUpdate(db, press(updateId + 1, telegramId, 'mine:2'));
    expect(second.replies[0]?.text).toContain('صفحهٔ 2 از 2');
    const secondButtons = second.replies[0]?.keyboard ?? [];
    expect(secondButtons.filter((row) => row[0]?.callback_data?.startsWith('sub:'))).toHaveLength(
      TOTAL - menu.SERVICES_PER_PAGE,
    );
  });

  it('shows the last page rather than an empty one for a page past the end', async () => {
    const { updateId, telegramId } = ids();
    const userId = await customer(telegramId);
    await makeService(userId, { publicId: `svc-${telegramId}-only` });

    const out = await handleUpdate(db, press(updateId, telegramId, 'mine:999'));

    const rows = out.replies[0]?.keyboard ?? [];
    expect(rows.filter((row) => row[0]?.callback_data?.startsWith('sub:'))).toHaveLength(1);
  });
});

describe('one service', () => {
  it('gives the owner the link, the username and what is left', async () => {
    const { updateId, telegramId } = ids();
    const userId = await customer(telegramId);
    const subId = await makeService(userId, {
      publicId: `svc-${telegramId}-full`,
      username: 'u_reader',
      url: 'https://panel.test/sub/u_reader',
      volumeGb: 50,
      usedBytes: 10 * GIB,
      expiresInDays: 12,
    });

    const out = await handleUpdate(db, press(updateId, telegramId, `sub:${subId}`));
    const text = out.replies[0]?.text ?? '';

    expect(text).toContain('https://panel.test/sub/u_reader');
    expect(text).toContain('u_reader');
    expect(text).toContain('📊 مصرف شده: 10 گیگابایت');
    expect(text).toContain('🎯 باقی‌مانده: 40 گیگابایت');
    expect(text).toContain('12 روز باقی مانده');
  });

  it('refuses another customer’s service — the live PHP bug, as an attack', async () => {
    const victim = ids();
    const attacker = ids();
    const victimId = await customer(victim.telegramId);
    await customer(attacker.telegramId);
    const secret = await makeService(victimId, {
      publicId: `svc-${victim.telegramId}-secret`,
      url: 'https://panel.test/sub/VICTIM_SECRET',
    });

    const out = await handleUpdate(
      db,
      press(attacker.updateId, attacker.telegramId, `sub:${secret}`),
    );

    expect(out.replies[0]?.text).toBe(menu.SERVICE_GONE);
    expect(out.replies[0]?.text).not.toContain('VICTIM_SECRET');
  });

  it('answers a service that does not exist exactly the same way', async () => {
    const { updateId, telegramId } = ids();
    await customer(telegramId);

    const out = await handleUpdate(db, press(updateId, telegramId, 'sub:2000000000'));

    expect(out.replies[0]?.text).toBe(menu.SERVICE_GONE);
  });

  it('withholds the link once the date has passed', async () => {
    const { updateId, telegramId } = ids();
    const userId = await customer(telegramId);
    const subId = await makeService(userId, {
      publicId: `svc-${telegramId}-old`,
      url: 'https://panel.test/sub/EXPIRED_ONE',
      expiresInDays: -1,
    });

    const out = await handleUpdate(db, press(updateId, telegramId, `sub:${subId}`));
    const text = out.replies[0]?.text ?? '';

    expect(text).toContain('تاریخ انقضا گذشته');
    expect(text).not.toContain('EXPIRED_ONE');
    // And does not leave them on a dead end. Seen on the real screen: status,
    // no link, and nothing at all about what to do next.
    expect(text).toContain('تمدید سرویس');
  });

  it('withholds the link once the volume is gone', async () => {
    const { updateId, telegramId } = ids();
    const userId = await customer(telegramId);
    const subId = await makeService(userId, {
      publicId: `svc-${telegramId}-used`,
      url: 'https://panel.test/sub/DRAINED_ONE',
      volumeGb: 10,
      usedBytes: 10 * GIB,
      expiresInDays: 20,
    });

    const out = await handleUpdate(db, press(updateId, telegramId, `sub:${subId}`));
    const text = out.replies[0]?.text ?? '';

    expect(text).toContain('حجم تمام شده');
    expect(text).not.toContain('DRAINED_ONE');
  });

  it('says the link is missing rather than showing a blank space', async () => {
    // A manual product, or a row migrated from the old bot that no sync has
    // reached yet. 3,139 live services arrive in exactly this state.
    const { updateId, telegramId } = ids();
    const userId = await customer(telegramId);
    const subId = await makeService(userId, {
      publicId: `svc-${telegramId}-nolink`,
      url: null,
      expiresInDays: 5,
    });

    const out = await handleUpdate(db, press(updateId, telegramId, `sub:${subId}`));
    const text = out.replies[0]?.text ?? '';

    expect(text).toContain('هنوز در دسترس نیست');
    expect(text).toContain('فعال');
  });
});

describe('the state of a service, as a pure function', () => {
  const base: menu.ServiceView = {
    id: 1,
    public_id: 'x',
    status: 'ACTIVE',
    plan_name_at_sale: 'p',
    provider_name_at_sale: null,
    remote_username: null,
    subscription_url: null,
    volume_gb: 10,
    used_bytes: null,
    expires_at: null,
  };

  it('is active while there is both time and volume', () => {
    expect(
      menu.serviceState(
        { ...base, expires_at: new Date(NOW_MS + DAY).toISOString(), used_bytes: 5 * GIB },
        NOW_MS,
      ),
    ).toBe('ACTIVE');
  });

  it('expires at the instant, not the day', () => {
    const at = new Date(NOW_MS).toISOString();
    expect(menu.serviceState({ ...base, expires_at: at }, NOW_MS)).toBe('EXPIRED');
    expect(menu.serviceState({ ...base, expires_at: at }, NOW_MS - 1)).toBe('ACTIVE');
  });

  it('is exhausted at exactly the quota, not one byte over', () => {
    expect(menu.serviceState({ ...base, volume_gb: 10, used_bytes: 10 * GIB }, NOW_MS)).toBe(
      'EXHAUSTED',
    );
    expect(menu.serviceState({ ...base, volume_gb: 10, used_bytes: 10 * GIB - 1 }, NOW_MS)).toBe(
      'ACTIVE',
    );
  });

  it('never exhausts an unmetered plan', () => {
    expect(menu.serviceState({ ...base, volume_gb: null, used_bytes: 900 * GIB }, NOW_MS)).toBe(
      'ACTIVE',
    );
  });

  it('lets the row’s own status win over the derived one', () => {
    expect(menu.serviceState({ ...base, status: 'DISABLED' }, NOW_MS)).toBe('DISABLED');
    expect(menu.serviceState({ ...base, status: 'REMOVED' }, NOW_MS)).toBe('REMOVED');
    expect(menu.serviceState({ ...base, status: 'ON_HOLD' }, NOW_MS)).toBe('ON_HOLD');
  });
});

describe('volume, in the units the panel counts in', () => {
  it('treats a gigabyte as 1024³ bytes, which is what Marzban reports', () => {
    // Outside truth: `data_limit` is written as `volumeGb * 1024 ** 3` by the
    // adapter, so reading it back any other way would drift.
    expect(menu.formatGigabytes(1_073_741_824)).toBe('1 گیگابایت');
    expect(menu.formatGigabytes(0)).toBe('0 گیگابایت');
  });

  it('does not round a new customer’s usage down to nothing', () => {
    expect(menu.formatGigabytes(10 * 1024 * 1024)).toBe('0.01 گیگابایت');
  });
});
