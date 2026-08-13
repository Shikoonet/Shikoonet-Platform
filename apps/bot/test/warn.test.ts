/**
 * "Your service is about to run out."
 *
 * The thresholds are checked against the live `setting` row rather than against
 * the constants in the source — one gigabyte and two days — because a test that
 * reads the same constant as the code proves only that the file compiles.
 *
 * Sending twice is the failure that matters. A customer messaged every 25
 * seconds about the same gigabyte blocks the bot, and then never hears anything
 * again — including the message saying their payment went through.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAYS_WARN, VOLUME_WARN_BYTES, warnExpiringServices } from '../src/warn.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 7, 13, 12, 0, 0);
const DAY = 86_400_000;
const GIB = 1024 ** 3;

let seq = 0;
function nextTelegramId(): number {
  seq += 1;
  return 730_000 + seq * 11;
}

interface Fixture {
  publicId: string;
  expiresInDays?: number | null;
  volumeGb?: number | null;
  usedBytes?: number | null;
  status?: string;
  notify?: Record<string, boolean>;
}

async function makeService(userId: number, fixture: Fixture): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, plan_name_at_sale, price_irr, remote_username,
          volume_gb, used_bytes, status, purchased_at, expires_at, notify)
       VALUES (?1, ?2, 'یک‌ماهه-۵۰گیگ', 1950000, 'u_warn', ?3, ?4, ?5, now(), ?6, ?7::jsonb)
       RETURNING id`,
    )
    .bind(
      fixture.publicId,
      userId,
      fixture.volumeGb === undefined ? null : fixture.volumeGb,
      fixture.usedBytes === undefined ? null : fixture.usedBytes,
      fixture.status ?? 'ACTIVE',
      fixture.expiresInDays === undefined || fixture.expiresInDays === null
        ? null
        : new Date(NOW_MS + fixture.expiresInDays * DAY).toISOString(),
      JSON.stringify(fixture.notify ?? {}),
    )
    .first<{ id: number }>();
  if (!row) throw new Error('warn fixture failed');
  return row.id;
}

async function notifyOf(id: number): Promise<Record<string, unknown>> {
  const row = await db
    .prepare(`SELECT notify FROM subscriptions WHERE id = ?1`)
    .bind(id)
    .first<{ notify: Record<string, unknown> }>();
  return row?.notify ?? {};
}

/** No other file's rows may be in range, or the counts below mean nothing. */
async function clearServices(): Promise<void> {
  await db.prepare(`DELETE FROM subscriptions`).run();
}

beforeAll(async () => {
  await ensureCatalog();
});

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  await clearServices();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the thresholds the admin actually set', () => {
  it('matches the live setting row: 1 GB and 2 days', () => {
    // `SELECT volumewarn, daywarn FROM setting` on the 2026-08-13 dump.
    expect(VOLUME_WARN_BYTES).toBe(1024 ** 3);
    expect(DAYS_WARN).toBe(2);
  });
});

describe('running out of days', () => {
  it('warns inside the window and names the service', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    await makeService(userId, { publicId: 'w-time-1', expiresInDays: 1 });

    const notes = await warnExpiringServices(db, NOW_MS);

    const note = notes.find((n) => n.chatId === telegramId);
    expect(note?.text).toContain('یک‌ماهه-۵۰گیگ');
    expect(note?.text).toContain('1 روز');
  });

  it('says nothing to a service with three days left', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    await makeService(userId, { publicId: 'w-time-2', expiresInDays: 3 });

    expect(await warnExpiringServices(db, NOW_MS)).toHaveLength(0);
  });

  it('says nothing about a service that has already expired', async () => {
    // Past warning. "Your service is about to run out" a week after it did is
    // the message that makes a customer distrust every other one.
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    await makeService(userId, { publicId: 'w-time-3', expiresInDays: -1 });

    expect(await warnExpiringServices(db, NOW_MS)).toHaveLength(0);
  });

  it('says nothing about a service with no expiry at all', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    await makeService(userId, { publicId: 'w-time-4', expiresInDays: null });

    expect(await warnExpiringServices(db, NOW_MS)).toHaveLength(0);
  });
});

describe('running out of gigabytes', () => {
  it('warns at half a gigabyte left', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    await makeService(userId, {
      publicId: 'w-vol-1',
      volumeGb: 50,
      usedBytes: 50 * GIB - GIB / 2,
      expiresInDays: 20,
    });

    const notes = await warnExpiringServices(db, NOW_MS);

    expect(notes.find((n) => n.chatId === telegramId)?.text).toContain('0.5 گیگابایت');
  });

  it('says nothing at two gigabytes left', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    await makeService(userId, {
      publicId: 'w-vol-2',
      volumeGb: 50,
      usedBytes: 48 * GIB,
      expiresInDays: 20,
    });

    expect(await warnExpiringServices(db, NOW_MS)).toHaveLength(0);
  });

  it('says nothing once the volume is actually gone', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    await makeService(userId, {
      publicId: 'w-vol-3',
      volumeGb: 50,
      usedBytes: 50 * GIB,
      expiresInDays: 20,
    });

    expect(await warnExpiringServices(db, NOW_MS)).toHaveLength(0);
  });

  it('says nothing about an unmetered service, however much it uses', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    await makeService(userId, {
      publicId: 'w-vol-4',
      volumeGb: null,
      usedBytes: 900 * GIB,
      expiresInDays: 20,
    });

    expect(await warnExpiringServices(db, NOW_MS)).toHaveLength(0);
  });

  it('says nothing while the usage has never been synced', async () => {
    // NULL is "we do not know", not "zero used". Treating it as zero would put
    // every migrated service one query away from a wrong warning.
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    await makeService(userId, {
      publicId: 'w-vol-5',
      volumeGb: 50,
      usedBytes: null,
      expiresInDays: 20,
    });

    expect(await warnExpiringServices(db, NOW_MS)).toHaveLength(0);
  });
});

describe('saying it once', () => {
  it('does not repeat itself on the next sweep', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    const id = await makeService(userId, { publicId: 'w-once-1', expiresInDays: 1 });

    expect(await warnExpiringServices(db, NOW_MS)).toHaveLength(1);
    expect(await warnExpiringServices(db, NOW_MS)).toHaveLength(0);
    expect(await notifyOf(id)).toMatchObject({ time: true });
  });

  it('still warns about volume after it has warned about time', async () => {
    // Two reasons, two messages. Marking one must not silence the other.
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    const id = await makeService(userId, {
      publicId: 'w-once-2',
      expiresInDays: 1,
      volumeGb: 50,
      usedBytes: 50 * GIB - GIB / 4,
    });

    const notes = await warnExpiringServices(db, NOW_MS);

    expect(notes).toHaveLength(2);
    expect(await notifyOf(id)).toMatchObject({ time: true, volume: true });
  });

  it('warns again after the service is renewed', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    const id = await makeService(userId, {
      publicId: 'w-once-3',
      expiresInDays: 1,
      notify: { time: true },
    });

    expect(await warnExpiringServices(db, NOW_MS)).toHaveLength(0);
    // What a renewal does to the row.
    await db.prepare(`UPDATE subscriptions SET notify = '{}'::jsonb WHERE id = ?1`).bind(id).run();

    expect(await warnExpiringServices(db, NOW_MS)).toHaveLength(1);
  });
});

describe('who is not told', () => {
  it('respects a customer who turned notifications off', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    await db.prepare(`UPDATE users SET notify_enabled = false WHERE id = ?1`).bind(userId).run();
    await makeService(userId, { publicId: 'w-off-1', expiresInDays: 1 });

    expect(await warnExpiringServices(db, NOW_MS)).toHaveLength(0);
  });

  it('does not message a blocked customer', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    await db.prepare(`UPDATE users SET status = 'BLOCKED' WHERE id = ?1`).bind(userId).run();
    await makeService(userId, { publicId: 'w-off-2', expiresInDays: 1 });

    expect(await warnExpiringServices(db, NOW_MS)).toHaveLength(0);
  });

  it('does not warn about a service that is not active', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    await makeService(userId, { publicId: 'w-off-3', expiresInDays: 1, status: 'DISABLED' });

    expect(await warnExpiringServices(db, NOW_MS)).toHaveLength(0);
  });
});
