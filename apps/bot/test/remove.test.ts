/**
 * The two sweeps that delete a customer's account from a panel.
 *
 * Nothing else in this project destroys something a customer paid for, and
 * nothing puts it back. So the assertions that matter are the ones about NOT
 * deleting: every guard is tested from the side where it refuses, because a
 * guard that only ever passes is a guard nobody has checked.
 *
 * The panel is a fake `fetch` rather than a real adapter double, so what is
 * asserted is the request that would have gone out — the actual DELETE, to the
 * actual username.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeFinishedServices } from '../src/remove.js';
import { db, pendingNotifications } from './helpers/env.js';
import { invalidateShopSettings } from '../src/settings.js';
import { ensureCatalog, makeCustomer } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 8, 6, 12, 0, 0);
const DAY = 86_400_000;

let seq = 0;
function nextTelegramId(): number {
  seq += 1;
  return 760_000 + seq * 13;
}

/** Every DELETE the sweep sent, in order. */
let deleted: string[] = [];

/**
 * A panel that logs in and deletes.
 *
 * `?override` lets one test make the delete fail without a second fake.
 */
function fakePanel(override?: (url: string) => Response | null): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const forced = override?.(url);
    if (forced) return forced;
    if (url.includes('/api/admin/token')) {
      return new Response(JSON.stringify({ access_token: 'tok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (init?.method === 'DELETE' && url.includes('/api/user/')) {
      deleted.push(decodeURIComponent(url.split('/api/user/')[1]!));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
}

let providerId: number;

interface Fixture {
  publicId: string;
  /** Days ago it expired. Positive = in the past. */
  expiredDaysAgo?: number | null;
  panelStatus?: string | null;
  /** Days ago the panel last saw it connect. Null = never reported. */
  onlineDaysAgo?: number | null;
  status?: string;
}

async function makeService(userId: number, fx: Fixture): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, plan_name_at_sale, price_irr, remote_username, provider_id,
          status, purchased_at, expires_at, panel_status, panel_online_at, notify)
       VALUES (?1, ?2, 'یک‌ماهه-۵۰گیگ', 1950000, ?3, ?4, ?5, now(), ?6, ?7, ?8, '{}'::jsonb)
       RETURNING id`,
    )
    .bind(
      fx.publicId,
      userId,
      `u_${fx.publicId}`,
      providerId,
      fx.status ?? 'ACTIVE',
      fx.expiredDaysAgo === undefined || fx.expiredDaysAgo === null
        ? null
        : new Date(NOW_MS - fx.expiredDaysAgo * DAY).toISOString(),
      fx.panelStatus === undefined ? 'limited' : fx.panelStatus,
      fx.onlineDaysAgo === undefined || fx.onlineDaysAgo === null
        ? null
        : new Date(NOW_MS - fx.onlineDaysAgo * DAY).toISOString(),
    )
    .first<{ id: number }>();
  if (!row) throw new Error('remove fixture failed');
  return row.id;
}

async function setSetting(key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (scope, key, value) VALUES ('bot', ?1, ?2::jsonb)
       ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value)
    .run();
  invalidateShopSettings();
}

/** Both switches on and the dry run off — the state everything below assumes. */
async function armed(): Promise<void> {
  await setSetting('cron_remove_expired', 'true');
  await setSetting('cron_remove_volume', 'true');
  await setSetting('cron_remove_dry_run', 'false');
  await setSetting('removedayc', '30');
  await setSetting('cronvolumere', '17');
}

/**
 * Whether this customer was messaged at all.
 *
 * Scoped to one chat rather than asserting the queue is empty: the queue is
 * shared with every other test in this file and «nobody was told» is the claim
 * being made, not «nothing happened anywhere».
 */
async function toldAnything(telegramId: number): Promise<boolean> {
  return (await pendingNotifications()).some((n) => n.chatId === telegramId);
}

async function statusOf(id: number): Promise<string> {
  const row = await db
    .prepare(`SELECT status FROM subscriptions WHERE id = ?1`)
    .bind(id)
    .first<{ status: string }>();
  return row!.status;
}

beforeAll(async () => {
  await ensureCatalog();
  // The credential comes from the environment rather than a sealed row, like
  // `sync.test.ts`: `credentialsFor` reads `PANEL_<CODE>` when there is no
  // `provider_secrets` row, and a sealed one would need the real
  // `PANEL_SECRET_KEY` to open.
  process.env.PANEL_ZZ_REMOVE_PANEL = 'admin:secret';
  const p = await db
    .prepare(
      `INSERT INTO provisioning_providers (code, name, kind, status, base_url, secret_ref)
       VALUES ('zz-remove-panel', 'پنل حذف', 'pasarguard', 'ACTIVE', 'https://remove.test',
               'zz-remove-panel')
       ON CONFLICT (code) DO UPDATE
         SET base_url = excluded.base_url, secret_ref = excluded.secret_ref
       RETURNING id`,
    )
    .first<{ id: number }>();
  providerId = Number(p!.id);
});

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  deleted = [];
  await db.prepare(`DELETE FROM subscriptions WHERE provider_id = ?1`).bind(providerId).run();
  await armed();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key LIKE 'cron_%'`).run();
  invalidateShopSettings();
});

describe('the switch, before anything else', () => {
  it('does nothing at all while it is off', async () => {
    await setSetting('cron_remove_expired', 'false');
    const userId = await makeCustomer(nextTelegramId());
    const id = await makeService(userId, { publicId: 'rm-off', expiredDaysAgo: 90 });

    const out = await removeFinishedServices(db, 'expired', fakePanel(), NOW_MS);

    expect(out).toMatchObject({ removed: 0, due: 0 });
    expect(deleted).toEqual([]);
    expect(await statusOf(id)).toBe('ACTIVE');
  });

  it('reports and deletes nothing while the dry run is on', async () => {
    await setSetting('cron_remove_dry_run', 'true');
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    const id = await makeService(userId, { publicId: 'rm-dry', expiredDaysAgo: 90 });

    const out = await removeFinishedServices(db, 'expired', fakePanel(), NOW_MS);

    // It FOUND it — that is the report — and touched nothing.
    expect(out).toMatchObject({ removed: 0, due: 1, dryRun: true });
    expect(deleted).toEqual([]);
    expect(await statusOf(id)).toBe('ACTIVE');
    expect(await toldAnything(telegramId)).toBe(false);
  });
});

describe('removing a service the panel calls finished', () => {
  it('deletes it, marks the row, and tells the customer why', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    const id = await makeService(userId, { publicId: 'rm-1', expiredDaysAgo: 45 });

    const out = await removeFinishedServices(db, 'expired', fakePanel(), NOW_MS);

    expect(out).toMatchObject({ removed: 1, failed: 0, dryRun: false });
    expect(deleted).toEqual(['u_rm-1']);
    expect(await statusOf(id)).toBe('REMOVED');

    const note = (await pendingNotifications()).find((n) => n.chatId === telegramId);
    expect(note?.text).toContain('یک‌ماهه-۵۰گیگ');
    // The number of days is in the message. A removal with no reason is the
    // one that produces a support ticket.
    expect(note?.text).toContain('45');
  });

  it('leaves it alone before the threshold', async () => {
    const userId = await makeCustomer(nextTelegramId());
    const id = await makeService(userId, { publicId: 'rm-early', expiredDaysAgo: 29 });

    expect((await removeFinishedServices(db, 'expired', fakePanel(), NOW_MS)).due).toBe(0);
    expect(deleted).toEqual([]);
    expect(await statusOf(id)).toBe('ACTIVE');
  });

  it('refuses when the panel still calls it active, however long ago it expired', async () => {
    // The guard the parity is really about. Our date says «expired 200 days
    // ago»; the panel says the account is live. Deleting on our date alone is
    // how a working service disappears.
    const userId = await makeCustomer(nextTelegramId());
    const id = await makeService(userId, {
      publicId: 'rm-panel-active',
      expiredDaysAgo: 200,
      panelStatus: 'active',
    });

    expect((await removeFinishedServices(db, 'expired', fakePanel(), NOW_MS)).due).toBe(0);
    expect(await statusOf(id)).toBe('ACTIVE');
  });

  it('refuses when the panel has said nothing at all', async () => {
    // NULL is «we do not know», and not knowing must never authorise a delete.
    // A panel that stops reporting status makes these sweeps stop.
    const userId = await makeCustomer(nextTelegramId());
    await makeService(userId, {
      publicId: 'rm-panel-silent',
      expiredDaysAgo: 200,
      panelStatus: null,
    });

    expect((await removeFinishedServices(db, 'expired', fakePanel(), NOW_MS)).due).toBe(0);
    expect(deleted).toEqual([]);
  });
});

describe('removing a service that ran out of gigabytes', () => {
  it('goes by the last connection, not by the expiry date', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    // Not expired at all — a month of days left — but the panel limited it and
    // nobody has connected for three weeks.
    const id = await makeService(userId, {
      publicId: 'rm-vol',
      expiredDaysAgo: -30,
      panelStatus: 'limited',
      onlineDaysAgo: 21,
    });

    const out = await removeFinishedServices(db, 'volume', fakePanel(), NOW_MS);

    expect(out).toMatchObject({ removed: 1 });
    expect(deleted).toEqual(['u_rm-vol']);
    expect(await statusOf(id)).toBe('REMOVED');
    expect((await pendingNotifications()).find((n) => n.chatId === telegramId)?.text).toContain(
      'حجمش تمام شده بود',
    );
  });

  it('never touches a service the panel has no connection time for', async () => {
    // Bought and never plugged in. Mirzabot returns on the same condition, and
    // this customer belongs to the «unused» nudge rather than to a deletion.
    const userId = await makeCustomer(nextTelegramId());
    const id = await makeService(userId, {
      publicId: 'rm-vol-never',
      panelStatus: 'limited',
      onlineDaysAgo: null,
    });

    expect((await removeFinishedServices(db, 'volume', fakePanel(), NOW_MS)).due).toBe(0);
    expect(await statusOf(id)).toBe('ACTIVE');
  });

  it('will not take an expired account, because that is the other sweep', async () => {
    // The PHP's two overlapping status lists leave `limited` as the only word
    // that survives, and the two sweeps must not both claim one service —
    // which would delete it once and message the customer twice.
    const userId = await makeCustomer(nextTelegramId());
    await makeService(userId, {
      publicId: 'rm-vol-expired',
      panelStatus: 'expired',
      onlineDaysAgo: 60,
    });

    expect((await removeFinishedServices(db, 'volume', fakePanel(), NOW_MS)).due).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('leaves it alone before the threshold', async () => {
    const userId = await makeCustomer(nextTelegramId());
    await makeService(userId, {
      publicId: 'rm-vol-early',
      panelStatus: 'limited',
      onlineDaysAgo: 16,
    });

    expect((await removeFinishedServices(db, 'volume', fakePanel(), NOW_MS)).due).toBe(0);
  });
});

describe('when the panel will not do it', () => {
  it('leaves the row ACTIVE so the next cycle tries again', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    const id = await makeService(userId, { publicId: 'rm-fail', expiredDaysAgo: 45 });

    const out = await removeFinishedServices(
      db,
      'expired',
      fakePanel((url) => (url.includes('/api/user/') ? new Response('nope', { status: 503 }) : null)),
      NOW_MS,
    );

    expect(out).toMatchObject({ removed: 0, failed: 1 });
    // The account is still on the panel, so the row must still say so. Marking
    // it REMOVED here would hide a live account nobody is tracking.
    expect(await statusOf(id)).toBe('ACTIVE');
    expect(await toldAnything(telegramId)).toBe(false);
  });

  it('counts an account that was already gone as removed and still tells the customer', async () => {
    // A 404 is the end state that was asked for. Treating it as a failure
    // would retry against an account nobody can find, for ever.
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    const id = await makeService(userId, { publicId: 'rm-404', expiredDaysAgo: 45 });

    const out = await removeFinishedServices(
      db,
      'expired',
      fakePanel((url) => (url.includes('/api/user/') ? new Response('{}', { status: 404 }) : null)),
      NOW_MS,
    );

    expect(out).toMatchObject({ removed: 1, failed: 0 });
    expect(await statusOf(id)).toBe('REMOVED');
  });
});

describe('the ceiling', () => {
  it('never removes more than one batch in a pass', async () => {
    for (let i = 0; i < 14; i += 1) {
      const userId = await makeCustomer(nextTelegramId());
      await makeService(userId, { publicId: `rm-many-${i}`, expiredDaysAgo: 60 + i });
    }

    const first = await removeFinishedServices(db, 'expired', fakePanel(), NOW_MS);
    expect(first.removed).toBe(10);

    // And the rest are still there for the next cycle rather than lost.
    const second = await removeFinishedServices(db, 'expired', fakePanel(), NOW_MS);
    expect(second.removed).toBe(4);
    expect(deleted).toHaveLength(14);
  });
});
