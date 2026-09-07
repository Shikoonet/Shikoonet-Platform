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
import { db, pendingNotifications } from './helpers/env.js';
import { DEFAULT_SHOP_SETTINGS, invalidateShopSettings } from '../src/settings.js';
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
  /** How long ago it was bought. Default 0 — bought at `NOW_MS`. */
  purchasedDaysAgo?: number;
  /** Whether the panel has ever answered about it. `used_bytes` means nothing without this. */
  synced?: boolean;
}

async function makeService(userId: number, fixture: Fixture): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, plan_name_at_sale, price_irr, remote_username,
          volume_gb, used_bytes, status, purchased_at, expires_at, notify,
          last_synced_at)
       VALUES (?1, ?2, 'یک‌ماهه-۵۰گیگ', 1950000, 'u_warn', ?3, ?4, ?5, ?8, ?6, ?7::jsonb, ?9)
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
      new Date(NOW_MS - (fixture.purchasedDaysAgo ?? 0) * DAY).toISOString(),
      fixture.synced === true ? new Date(NOW_MS).toISOString() : null,
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
  it('matches the live setting row: 1 GB, 2 days, and 1 day unused', () => {
    // `SELECT volumewarn, daywarn, on_hold_day FROM setting`. These three
    // literals are pinned to the shop's own database by
    // `packages/migrate/test/shop-switches.mysql.test.ts` — this file only
    // proves the bot falls back to them.
    expect(VOLUME_WARN_BYTES).toBe(1024 ** 3);
    expect(DAYS_WARN).toBe(2);
    // Not 4. `table.php` creates the column with 4; the shop runs 1, and a
    // fallback taken from the schema would nudge four times slower than the
    // release it is standing in for.
    expect(DEFAULT_SHOP_SETTINGS.onHoldDays).toBe(1);
  });
});

describe('running out of days', () => {
  it('warns inside the window and names the service', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    await makeService(userId, { publicId: 'w-time-1', expiresInDays: 1 });

    await warnExpiringServices(db, NOW_MS);

    const notes = await pendingNotifications();
    const note = notes.find((n) => n.chatId === telegramId);
    expect(note?.text).toContain('یک‌ماهه-۵۰گیگ');
    expect(note?.text).toContain('1 روز');
  });

  it('says nothing to a service with three days left', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    await makeService(userId, { publicId: 'w-time-2', expiresInDays: 3 });

    expect(await warnExpiringServices(db, NOW_MS)).toBe(0);
  });

  it('says nothing about a service that has already expired', async () => {
    // Past warning. "Your service is about to run out" a week after it did is
    // the message that makes a customer distrust every other one.
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    await makeService(userId, { publicId: 'w-time-3', expiresInDays: -1 });

    expect(await warnExpiringServices(db, NOW_MS)).toBe(0);
  });

  it('says nothing about a service with no expiry at all', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    await makeService(userId, { publicId: 'w-time-4', expiresInDays: null });

    expect(await warnExpiringServices(db, NOW_MS)).toBe(0);
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

    await warnExpiringServices(db, NOW_MS);

    const notes = await pendingNotifications();
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

    expect(await warnExpiringServices(db, NOW_MS)).toBe(0);
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

    expect(await warnExpiringServices(db, NOW_MS)).toBe(0);
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

    expect(await warnExpiringServices(db, NOW_MS)).toBe(0);
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

    expect(await warnExpiringServices(db, NOW_MS)).toBe(0);
  });
});

describe('saying it once', () => {
  it('does not repeat itself on the next sweep', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    const id = await makeService(userId, { publicId: 'w-once-1', expiresInDays: 1 });

    expect(await warnExpiringServices(db, NOW_MS)).toBe(1);
    expect(await warnExpiringServices(db, NOW_MS)).toBe(0);
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

    await warnExpiringServices(db, NOW_MS);

    // Scoped to this customer: the outbox keeps every message the file has
    // enqueued, which is the point of it.
    const notes = (await pendingNotifications()).filter((n) => n.chatId === telegramId);
    expect(notes).toHaveLength(2);
    expect(await notifyOf(id)).toMatchObject({ time: true, volume: true });
  });

  it('warns again after the service is renewed, with a message and not just a flag', async () => {
    // This test started the service at `notify: { time: true }` until
    // 2026-08-21 — already warned — so the first sweep enqueued nothing and the
    // second one was the only message there had ever been. It proved the flag
    // is re-claimed. It could not see that the MESSAGE was being swallowed by a
    // dedupe key with no cycle in it, which is what was actually happening: the
    // subscription was marked warned, the counter said 1, and the customer was
    // told nothing.
    //
    // So the first warning is real now, and both are counted at the end.
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    const id = await makeService(userId, { publicId: 'w-once-3', expiresInDays: 1 });

    expect(await warnExpiringServices(db, NOW_MS)).toBe(1);
    const first = (await pendingNotifications()).filter((n) => n.chatId === telegramId);
    expect(first).toHaveLength(1);

    // What a renewal really does to the row: it moves the date as well as
    // clearing the flag. `provision.ts` writes both.
    await db
      .prepare(`UPDATE subscriptions SET notify = '{}'::jsonb, expires_at = ?2 WHERE id = ?1`)
      .bind(id, new Date(NOW_MS + 31 * DAY).toISOString())
      .run();
    // Back inside the window, one cycle later.
    const later = NOW_MS + 30 * DAY;

    expect(await warnExpiringServices(db, later)).toBe(1);

    const both = (await pendingNotifications()).filter((n) => n.chatId === telegramId);
    expect(both).toHaveLength(2);
    // Two different keys, or the second insert was a silent no-op and the
    // count above was a lie.
    expect(new Set(both.map((n) => n.dedupeKey)).size).toBe(2);
  });
});

describe('who is not told', () => {
  it('respects a customer who turned notifications off', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    await db.prepare(`UPDATE users SET notify_enabled = false WHERE id = ?1`).bind(userId).run();
    await makeService(userId, { publicId: 'w-off-1', expiresInDays: 1 });

    expect(await warnExpiringServices(db, NOW_MS)).toBe(0);
  });

  it('still warns a blocked customer, because the service was paid for', async () => {
    // This test asserted the opposite until 2026-08-21, and the opposite was
    // our own invention. `legacy/mirzabot-php/cronbot/NoticationsService.php:72`
    // selects from `invoice` alone and never joins `user`; the only per-person
    // gate in the whole cron is `$status_cron_user` at `:239-241`, which is
    // `notify_enabled` here.
    //
    // What our extra filter bought was silence for somebody the flood guard may
    // have blocked by mistake — their service runs out with no word, and they
    // paid for it. The block still stops them buying; it does not un-buy what
    // they already own.
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    await db.prepare(`UPDATE users SET status = 'BLOCKED' WHERE id = ?1`).bind(userId).run();
    await makeService(userId, { publicId: 'w-off-2', expiresInDays: 1 });

    expect(await warnExpiringServices(db, NOW_MS)).toBe(1);
    const notes = await pendingNotifications();
    expect(notes.find((n) => n.chatId === telegramId)).toBeDefined();
  });

  it('does not warn about a service that is not active', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    await makeService(userId, { publicId: 'w-off-3', expiresInDays: 1, status: 'DISABLED' });

    expect(await warnExpiringServices(db, NOW_MS)).toBe(0);
  });
});

/**
 * "You bought this and never plugged it in."
 *
 * The window is the admin's, not ours. Every test below writes
 * `setting.on_hold_day` and then measures against THAT number — a fixture
 * placed one day inside it and one day outside — so a sweep that quietly went
 * back to the constant in `settings.ts` fails here instead of passing because
 * the constant and the fixture happen to agree. What the shop's own row
 * actually holds is asserted where the shop's database is:
 * `packages/migrate/test/shop-switches.mysql.test.ts`.
 */
describe('bought and never connected', () => {
  /** Deliberately not 4, so nothing can pass on the default. */
  const WINDOW_DAYS = 7;
  const SUPPORT = 'shikoo_support';

  async function setSetting(scope: string, key: string, value: unknown): Promise<void> {
    await db
      .prepare(
        `INSERT INTO settings (scope, key, value) VALUES (?1, ?2, ?3::jsonb)
         ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
      )
      .bind(scope, key, JSON.stringify(value))
      .run();
    invalidateShopSettings();
  }

  beforeEach(async () => {
    await setSetting('bot', 'on_hold_day', String(WINDOW_DAYS));
    await setSetting('bot', 'id_support', SUPPORT);
  });

  afterEach(async () => {
    await db
      .prepare(`DELETE FROM settings WHERE scope = 'bot' AND key IN ('on_hold_day', 'id_support')`)
      .run();
    invalidateShopSettings();
  });

  it('nudges past the window and stays silent inside it, on the number the admin set', async () => {
    // Both in one sweep, so the pass cannot be explained by anything other
    // than the boundary: same shape, same usage, one day either side of it.
    const quiet = nextTelegramId();
    const nudged = nextTelegramId();
    await makeService(await makeCustomer(quiet), {
      publicId: 'w-hold-inside',
      usedBytes: 0,
      synced: true,
      purchasedDaysAgo: WINDOW_DAYS - 1,
      expiresInDays: 20,
    });
    await makeService(await makeCustomer(nudged), {
      publicId: 'w-hold-outside',
      usedBytes: 0,
      synced: true,
      purchasedDaysAgo: WINDOW_DAYS + 1,
      expiresInDays: 20,
    });

    expect(await warnExpiringServices(db, NOW_MS)).toBe(1);

    const notes = await pendingNotifications();
    expect(notes.find((n) => n.chatId === quiet)).toBeUndefined();
    const note = notes.find((n) => n.chatId === nudged);
    expect(note?.text).toContain('یک‌ماهه-۵۰گیگ');
    // Whole days since the purchase, rounded down — the same 8 the row was
    // selected on, never a larger number than has actually elapsed.
    expect(note?.text).toContain(`${WINDOW_DAYS + 1} روز`);
    expect(note?.text).toContain(`@${SUPPORT}`);
  });

  it('says nothing while the panel has never answered about it', async () => {
    // `used_bytes` is 0 from the moment the row is written. Without
    // `last_synced_at` that zero is "we never asked", and nudging on it tells
    // a customer who connected an hour ago that they never did.
    const telegramId = nextTelegramId();
    await makeService(await makeCustomer(telegramId), {
      publicId: 'w-hold-unsynced',
      usedBytes: 0,
      synced: false,
      purchasedDaysAgo: WINDOW_DAYS + 5,
      expiresInDays: 20,
    });

    expect(await warnExpiringServices(db, NOW_MS)).toBe(0);
  });

  it('says nothing about a service that has been used', async () => {
    const telegramId = nextTelegramId();
    await makeService(await makeCustomer(telegramId), {
      publicId: 'w-hold-used',
      volumeGb: 50,
      usedBytes: 1,
      synced: true,
      purchasedDaysAgo: WINDOW_DAYS + 5,
      expiresInDays: 20,
    });

    expect(await warnExpiringServices(db, NOW_MS)).toBe(0);
  });

  it('says nothing about a service that has already run out', async () => {
    // Telling somebody to go and connect a thing that stopped working is
    // worse than silence.
    const telegramId = nextTelegramId();
    await makeService(await makeCustomer(telegramId), {
      publicId: 'w-hold-expired',
      usedBytes: 0,
      synced: true,
      purchasedDaysAgo: WINDOW_DAYS + 5,
      expiresInDays: -1,
    });

    expect(await warnExpiringServices(db, NOW_MS)).toBe(0);
  });

  it('says it once, and records it beside the other two', async () => {
    const telegramId = nextTelegramId();
    const id = await makeService(await makeCustomer(telegramId), {
      publicId: 'w-hold-once',
      usedBytes: 0,
      synced: true,
      purchasedDaysAgo: WINDOW_DAYS + 1,
      expiresInDays: 20,
    });

    expect(await warnExpiringServices(db, NOW_MS)).toBe(1);
    expect(await warnExpiringServices(db, NOW_MS)).toBe(0);
    expect(await notifyOf(id)).toMatchObject({ unused: true });
    expect((await pendingNotifications()).filter((n) => n.chatId === telegramId)).toHaveLength(1);
  });

  it('still sends the nudge when the shop has no support handle', async () => {
    // The news is "you have not connected". The legacy renders a bare `@` here;
    // dropping the line is the same message without the dangling symbol.
    await db.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = 'id_support'`).run();
    invalidateShopSettings();

    const telegramId = nextTelegramId();
    await makeService(await makeCustomer(telegramId), {
      publicId: 'w-hold-nosupport',
      usedBytes: 0,
      synced: true,
      purchasedDaysAgo: WINDOW_DAYS + 1,
      expiresInDays: 20,
    });

    expect(await warnExpiringServices(db, NOW_MS)).toBe(1);
    const note = (await pendingNotifications()).find((n) => n.chatId === telegramId);
    expect(note?.text).toContain('یک‌ماهه-۵۰گیگ');
    expect(note?.text).not.toContain('@');
  });
});

describe('the switch an admin can turn off', () => {
  /**
   * The proof each switch asks for is not «the count went down» — it is that
   * the OTHER two branches still ran. A single switch that turned off the whole
   * sweep would pass a test written the lazy way, and would be a shop that
   * stopped telling anybody anything the first time somebody disabled a
   * warning they did not want.
   *
   * So each case builds all three kinds of due service, turns one switch off,
   * and asserts on which reasons came back.
   */
  async function threeDueServices(): Promise<void> {
    const time = await makeCustomer(nextTelegramId());
    await makeService(time, { publicId: 'sw-time', expiresInDays: 1 });

    const volume = await makeCustomer(nextTelegramId());
    await makeService(volume, {
      publicId: 'sw-volume',
      expiresInDays: 30,
      volumeGb: 50,
      // Half a gigabyte left, inside the one-gigabyte threshold.
      usedBytes: 50 * GIB - GIB / 2,
    });

    const unused = await makeCustomer(nextTelegramId());
    await makeService(unused, {
      publicId: 'sw-unused',
      expiresInDays: 30,
      usedBytes: 0,
      purchasedDaysAgo: 5,
      synced: true,
    });
  }

  /** Which subscriptions came out warned, by the key the sweep wrote. */
  async function warnedReasons(): Promise<string[]> {
    const { results } = await db
      .prepare(
        `SELECT public_id, notify FROM subscriptions
          WHERE notify <> '{}'::jsonb ORDER BY public_id`,
      )
      .all<{ public_id: string; notify: Record<string, unknown> }>();
    return (results ?? []).flatMap((r) => Object.keys(r.notify).map((k) => `${r.public_id}:${k}`));
  }

  async function setSwitch(key: string, on: boolean): Promise<void> {
    await db
      .prepare(
        `INSERT INTO settings (scope, key, value) VALUES ('bot', ?1, ?2::jsonb)
         ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
      )
      .bind(key, on ? 'true' : 'false')
      .run();
    invalidateShopSettings();
  }

  afterEach(async () => {
    await db
      .prepare(`DELETE FROM settings WHERE scope = 'bot' AND key LIKE 'cron_%'`)
      .run();
    invalidateShopSettings();
  });

  it('warns about all three when nothing is switched off', async () => {
    await threeDueServices();
    expect(await warnExpiringServices(db, NOW_MS)).toBe(3);
    expect(await warnedReasons()).toEqual(['sw-time:time', 'sw-unused:unused', 'sw-volume:volume']);
  });

  it('stops the volume warning and leaves the other two running', async () => {
    await threeDueServices();
    await setSwitch('cron_warn_volume', false);

    expect(await warnExpiringServices(db, NOW_MS)).toBe(2);
    // And the volume service is NOT marked warned — a disabled branch that
    // still selected rows would claim it and never message anybody, so the
    // customer would be silently skipped for ever once it was turned back on.
    expect(await warnedReasons()).toEqual(['sw-time:time', 'sw-unused:unused']);
  });

  it('stops the expiry warning and leaves the other two running', async () => {
    await threeDueServices();
    await setSwitch('cron_warn_time', false);

    expect(await warnExpiringServices(db, NOW_MS)).toBe(2);
    expect(await warnedReasons()).toEqual(['sw-unused:unused', 'sw-volume:volume']);
  });

  it('stops the unused nudge and leaves the other two running', async () => {
    await threeDueServices();
    await setSwitch('cron_warn_unused', false);

    expect(await warnExpiringServices(db, NOW_MS)).toBe(2);
    expect(await warnedReasons()).toEqual(['sw-time:time', 'sw-volume:volume']);
  });

  it('asks the database nothing when all three are off', async () => {
    await threeDueServices();
    await setSwitch('cron_warn_time', false);
    await setSwitch('cron_warn_volume', false);
    await setSwitch('cron_warn_unused', false);

    expect(await warnExpiringServices(db, NOW_MS)).toBe(0);
    expect(await warnedReasons()).toEqual([]);
  });

  it('keeps warning when the switch row holds something unreadable', async () => {
    // The rule every other setting follows: a value we failed to understand
    // must not be what takes a warning away from a customer. `Boolean('x')` is
    // true and `Boolean('false')` is also true, which is exactly why the
    // reader matches the two words rather than coercing.
    await threeDueServices();
    await db
      .prepare(
        `INSERT INTO settings (scope, key, value) VALUES ('bot', 'cron_warn_time', '"maybe"'::jsonb)
         ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
      )
      .run();
    invalidateShopSettings();

    expect(await warnExpiringServices(db, NOW_MS)).toBe(3);
  });
});
