/**
 * «تمدید سرویس» — from the button to the account on the panel.
 *
 * The money properties are the ones worth writing down:
 *
 *   - A customer cannot extend a service that is not theirs, and cannot extend
 *     their own service with a plan from a different panel — which would be
 *     paying one panel's price for another panel's service.
 *   - A renewal is applied exactly once. The sweep returns an order to PAID on
 *     a timeout, and a timeout is precisely when the panel may have applied the
 *     change and lost the answer. Adding thirty days twice is the failure this
 *     guards against, and it is the one the customer never reports.
 *   - The two live renewal modes do different arithmetic, and both are checked
 *     against the numbers the PHP produces: RESET starts the clock now, ADD
 *     measures from whatever time is left.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import * as menu from '../src/menu.js';
import { provisionPaidOrders } from '../src/provision.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db, pendingNotifications } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId, providerId } from './helpers/shop.js';
import { invalidateShopSettings } from '../src/settings.js';
import { creditRenewalCashback } from '../src/wallet.js';
import { formatToman } from '../src/money.js';

const NOW_MS = Date.UTC(2026, 7, 13, 12, 0, 0);
const DAY = 86_400_000;
const GIB = 1024 ** 3;
const PROVIDER_CODE = 'sim-renew-panel';

let seq = 0;
function ids(): { updateId: number; telegramId: number } {
  seq += 1;
  const n = seq * 10;
  return { updateId: 710_000 + n, telegramId: 640_000 + n };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `ren${telegramId}` },
      message: { message_id: 77, chat: { id: telegramId } },
      data,
    },
  };
}

interface PanelAccount {
  expire?: string | number | null;
  data_limit?: number;
  note?: string;
}

/** A panel holding one account, which remembers every change asked of it. */
function fakePanel(accounts: Record<string, PanelAccount>) {
  const puts: { username: string; body: Record<string, unknown> }[] = [];
  const resets: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/admin/token')) {
      return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
    }
    if (method === 'POST' && url.endsWith('/reset')) {
      const name = decodeURIComponent(url.split('/api/user/')[1]!.replace('/reset', ''));
      resets.push(name);
      return new Response('{}', { status: 200 });
    }
    const name = decodeURIComponent((url.split('/api/user/')[1] ?? '').split('?')[0] ?? '');
    const account = accounts[name];
    if (method === 'GET' && url.includes('/api/user/')) {
      return account
        ? new Response(
            JSON.stringify({ username: name, subscription_url: `/sub/${name}`, ...account }),
            { status: 200 },
          )
        : new Response('{}', { status: 404 });
    }
    if (method === 'PUT' && url.includes('/api/user/')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      puts.push({ username: name, body });
      // The panel remembers, so a second call sees the note the first wrote.
      accounts[name] = {
        expire: body['expire'] as string,
        data_limit: body['data_limit'] as number,
        note: body['note'] as string,
      };
      return new Response(JSON.stringify({ username: name, subscription_url: `/sub/${name}` }), {
        status: 200,
      });
    }
    return new Response('{}', { status: 500 });
  }) as unknown as typeof globalThis.fetch;
  return { puts, resets, fetchImpl, accounts };
}

const deadPanel = (async () =>
  Promise.reject(new Error('ETIMEDOUT'))) as unknown as typeof globalThis.fetch;

/** Sets how this panel renews, exactly as the migration carries it. */
/**
 * Adds the renewal keys to a panel, keeping whatever else it carries.
 *
 * `||` and not `=`. This writes to a CATALOGUE row that the whole bot package
 * shares, and the panel's `config` is also where the add-on prices live — so
 * replacing it wholesale silently took «افزودن حجم» and «افزودن زمان» off every
 * service, and `shop-settings.test.ts` then failed in a full run while passing
 * on its own. Two files, one row, and only one of them knew.
 */
async function setPanelConfig(provider: number, config: Record<string, unknown>): Promise<void> {
  await db
    .prepare(
      `UPDATE provisioning_providers
          SET base_url = 'https://renew.test', secret_ref = ?2, kind = 'pasarguard',
              config = coalesce(config, '{}'::jsonb) || ?3::jsonb
        WHERE id = ?1`,
    )
    .bind(provider, PROVIDER_CODE, JSON.stringify(config))
    .run();
}

async function makeService(
  userId: number,
  provider: number,
  fields: {
    publicId: string;
    username: string;
    expiresInDays?: number | null;
    volumeGb?: number | null;
    usedBytes?: number | null;
  },
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, provider_id, plan_name_at_sale, price_irr,
          remote_username, subscription_url, volume_gb, used_bytes,
          status, purchased_at, expires_at, notify)
       VALUES (?1, ?2, ?3, 'سرویس قدیمی', 1950000, ?4, ?5, ?6, ?7,
               'ACTIVE', now(), ?8, '{"time":true}'::jsonb)
       RETURNING id`,
    )
    .bind(
      fields.publicId,
      userId,
      provider,
      fields.username,
      `https://renew.test/sub/${fields.username}`,
      fields.volumeGb === undefined ? 50 : fields.volumeGb,
      fields.usedBytes === undefined ? 20 * GIB : fields.usedBytes,
      fields.expiresInDays === undefined || fields.expiresInDays === null
        ? null
        : new Date(NOW_MS + fields.expiresInDays * DAY).toISOString(),
    )
    .first<{ id: number }>();
  if (!row) throw new Error('renew fixture failed');
  return row.id;
}

async function subscriptionRow(id: number) {
  return db
    .prepare(
      `SELECT plan_id, plan_name_at_sale, volume_gb, used_bytes, duration_days,
              expires_at, notify, last_synced_at, status
         FROM subscriptions WHERE id = ?1`,
    )
    .bind(id)
    .first<{
      plan_id: number | null;
      plan_name_at_sale: string;
      volume_gb: number | null;
      used_bytes: number | null;
      duration_days: number | null;
      expires_at: string | null;
      notify: Record<string, unknown>;
      last_synced_at: string | null;
      status: string;
    }>();
}

/** Marks the customer's renewal order paid, the way settlement leaves it. */
async function markPaid(userId: number): Promise<{ id: number; publicId: string }> {
  const row = await db
    .prepare(
      `UPDATE orders SET status = 'PAID', updated_at = now()
        WHERE user_id = ?1 AND kind = 'RENEWAL' AND status = 'AWAITING_PAYMENT'
        RETURNING id, public_id`,
    )
    .bind(userId)
    .first<{ id: number; public_id: string }>();
  if (!row) throw new Error('no renewal order to pay');
  return { id: row.id, publicId: row.public_id };
}

async function orderRow(id: number) {
  return db
    .prepare(
      `SELECT status, kind, target_subscription_id, failure_reason FROM orders WHERE id = ?1`,
    )
    .bind(id)
    .first<{
      status: string;
      kind: string;
      target_subscription_id: number | null;
      failure_reason: string | null;
    }>();
}

let panelId: number;
let otherPanelId: number;

beforeAll(async () => {
  await ensureCatalog();
  process.env[`PANEL_${PROVIDER_CODE.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = 'admin:secret';
  panelId = await providerId('sim-vip');
  otherPanelId = await providerId('sim-gold');
});

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  // The sweep takes every PAID order, not just this test's, so the panel
  // counters below would otherwise be counting somebody else's renewal — which
  // is exactly how a green assertion ends up proving nothing.
  //
  // Scoped to THIS FILE'S customers, and that scope is the whole point. It used
  // to cancel every PAID order in the database, and the files in this package
  // run side by side: `stock.test.ts` would create a paid order, this
  // `beforeEach` would fire in the gap before its sweep, and the order it
  // asserted was still PAID had been cancelled by a test file it has never
  // heard of. Rare enough to look like weather until six more renewal tests
  // arrived and widened the window.
  await db
    .prepare(
      `UPDATE orders SET status = 'CANCELLED'
        WHERE status IN ('PAID', 'PROVISIONING')
          AND user_id IN (SELECT id FROM users WHERE telegram_id BETWEEN 640000 AND 649999)`,
    )
    .run();
  await setPanelConfig(panelId, { Methodextend: 'ریست حجم و زمان', status_extend: 'on_extend' });
  await setPanelConfig(otherPanelId, { status_extend: 'on_extend' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('choosing what to renew', () => {
  it('says so when there is nothing', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);

    const out = await handleUpdate(db, press(updateId, telegramId, 'renew'));

    expect(out.replies[0]?.text).toBe(menu.NOTHING_TO_RENEW);
  });

  it('lists a service whose date has already passed — the ones that need it most', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const subId = await makeService(userId, panelId, {
      publicId: `ren-${telegramId}-old`,
      username: `u_${telegramId}`,
      expiresInDays: -3,
    });

    const out = await handleUpdate(db, press(updateId, telegramId, 'renew'));

    const buttons = out.replies[0]?.keyboard?.flat() ?? [];
    expect(buttons.map((b) => b.callback_data)).toContain(`rnw:${subId}`);
  });

  it('offers plans that carry both the service and the plan', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const subId = await makeService(userId, panelId, {
      publicId: `ren-${telegramId}-a`,
      username: `u_${telegramId}`,
      expiresInDays: 5,
    });

    const out = await handleUpdate(db, press(updateId, telegramId, `rnw:${subId}`));

    const buttons = out.replies[0]?.keyboard?.flat() ?? [];
    const offers = buttons.filter((b) => b.callback_data?.startsWith('rord:'));
    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      expect(offer.callback_data).toMatch(new RegExp(`^rord:${subId}:\\d+$`));
    }
  });

  it('does not promise to keep remaining time a service no longer has', async () => {
    // Seen on the real screen: an expired service on an ADD panel telling the
    // customer their plan would be added to "the current remainder". There was
    // none. The adapter already anchors at today in that case — this is the
    // sentence agreeing with it.
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await setPanelConfig(panelId, {
      Methodextend: 'اضافه شدن زمان و حجم به ماه بعد',
      status_extend: 'on_extend',
    });
    const subId = await makeService(userId, panelId, {
      publicId: `ren-${telegramId}-gone`,
      username: `u_${telegramId}`,
      expiresInDays: -4,
    });

    const out = await handleUpdate(db, press(updateId, telegramId, `rnw:${subId}`));
    const text = out.replies[0]?.text ?? '';

    expect(text).not.toContain('باقی‌ماندهٔ فعلی');
    expect(text).toContain('از امروز');
  });

  it('does promise to keep it while there is some', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await setPanelConfig(panelId, {
      Methodextend: 'اضافه شدن زمان و حجم به ماه بعد',
      status_extend: 'on_extend',
    });
    const subId = await makeService(userId, panelId, {
      publicId: `ren-${telegramId}-left`,
      username: `u_${telegramId}`,
      expiresInDays: 6,
    });

    const out = await handleUpdate(db, press(updateId, telegramId, `rnw:${subId}`));

    expect(out.replies[0]?.text).toContain('باقی‌ماندهٔ فعلی');
  });

  it('honours a panel the admin switched renewal off for', async () => {
    // `status_extend = off_extend` on one live panel. Ignoring it would be the
    // new bot quietly overriding the admin's own setting.
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await setPanelConfig(panelId, { status_extend: 'off_extend' });
    const subId = await makeService(userId, panelId, {
      publicId: `ren-${telegramId}-off`,
      username: `u_${telegramId}`,
      expiresInDays: 5,
    });

    const out = await handleUpdate(db, press(updateId, telegramId, `rnw:${subId}`));

    expect(out.replies[0]?.text).toBe(menu.RENEWAL_CLOSED);
  });

  it('refuses another customer’s service', async () => {
    const victim = ids();
    const attacker = ids();
    const victimId = await makeCustomer(victim.telegramId);
    await makeCustomer(attacker.telegramId);
    const subId = await makeService(victimId, panelId, {
      publicId: `ren-${victim.telegramId}-v`,
      username: `u_${victim.telegramId}`,
      expiresInDays: 5,
    });

    const out = await handleUpdate(
      db,
      press(attacker.updateId, attacker.telegramId, `rnw:${subId}`),
    );

    expect(out.replies[0]?.text).toBe(menu.RENEWAL_GONE);
  });
});

describe('placing the order', () => {
  it('books a RENEWAL pointed at the service and shows the card', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const subId = await makeService(userId, panelId, {
      publicId: `ren-${telegramId}-b`,
      username: `u_${telegramId}`,
      expiresInDays: 5,
    });
    const plan = await planId('sim-vip-1m-50');

    const out = await handleUpdate(db, press(updateId, telegramId, `rord:${subId}:${plan}`));

    expect(out.replies[0]?.text).toContain('تمدید');
    const order = await markPaid(userId);
    expect(await orderRow(order.id)).toMatchObject({
      kind: 'RENEWAL',
      target_subscription_id: subId,
    });
  });

  it('refuses a plan from a different panel', async () => {
    // Otherwise the cheapest plan anywhere renews the most expensive service.
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const subId = await makeService(userId, panelId, {
      publicId: `ren-${telegramId}-c`,
      username: `u_${telegramId}`,
      expiresInDays: 5,
    });
    const foreign = await planId('sim-gold-10');

    const out = await handleUpdate(db, press(updateId, telegramId, `rord:${subId}:${foreign}`));

    expect(out.replies[0]?.text).toBe(menu.PLAN_GONE);
    const none = await db
      .prepare(`SELECT COUNT(*)::int AS n FROM orders WHERE user_id = ?1 AND kind = 'RENEWAL'`)
      .bind(userId)
      .first<{ n: number }>();
    expect(none?.n).toBe(0);
  });

  it('does not book a second order for a second tap', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const subId = await makeService(userId, panelId, {
      publicId: `ren-${telegramId}-d`,
      username: `u_${telegramId}`,
      expiresInDays: 5,
    });
    const plan = await planId('sim-vip-1m-50');

    await handleUpdate(db, press(updateId, telegramId, `rord:${subId}:${plan}`));
    await handleUpdate(db, press(updateId + 1, telegramId, `rord:${subId}:${plan}`));

    const count = await db
      .prepare(`SELECT COUNT(*)::int AS n FROM orders WHERE user_id = ?1 AND kind = 'RENEWAL'`)
      .bind(userId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

describe('applying it', () => {
  async function paidRenewal(
    options: { expiresInDays?: number | null; volumeGb?: number | null } = {},
  ) {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const subId = await makeService(userId, panelId, {
      publicId: `ren-${telegramId}-e`,
      username: `u_${telegramId}`,
      expiresInDays: options.expiresInDays === undefined ? 5 : options.expiresInDays,
      volumeGb: options.volumeGb === undefined ? 50 : options.volumeGb,
    });
    const plan = await planId('sim-vip-1m-50');
    await handleUpdate(db, press(updateId, telegramId, `rord:${subId}:${plan}`));
    const order = await markPaid(userId);
    return { userId, subId, plan, order, telegramId, username: `u_${telegramId}` };
  }

  it('RESET starts the clock now and zeroes the usage', async () => {
    const target = await paidRenewal();
    const panel = fakePanel({
      [target.username]: { expire: new Date(NOW_MS + 5 * DAY).toISOString(), data_limit: 50 * GIB },
    });

    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);

    const notes = await pendingNotifications();
    expect(panel.resets).toContain(target.username);
    // 30 days from now, not from the five days that were left.
    expect(panel.puts[0]?.body['expire']).toBe((NOW_MS + 30 * DAY) / 1000);
    expect(panel.puts[0]?.body['data_limit']).toBe(50 * GIB);

    const sub = await subscriptionRow(target.subId);
    expect(sub?.used_bytes).toBe(0);
    expect(sub?.volume_gb).toBe(50);
    expect(Date.parse(sub!.expires_at!)).toBe(NOW_MS + 30 * DAY);
    // The "your service is running out" flag has to be cleared, or the warning
    // never fires again for this service.
    expect(sub?.notify).toEqual({});
    expect(sub?.last_synced_at).toBeNull();
    expect(await orderRow(target.order.id)).toMatchObject({ status: 'COMPLETED' });
    expect(notes.some((n) => n.chatId === target.telegramId)).toBe(true);
  });

  it('ADD keeps the days already paid for and grows the quota', async () => {
    await setPanelConfig(panelId, {
      Methodextend: 'اضافه شدن زمان و حجم به ماه بعد',
      status_extend: 'on_extend',
    });
    const target = await paidRenewal({ expiresInDays: 5 });
    const panel = fakePanel({
      [target.username]: { expire: new Date(NOW_MS + 5 * DAY).toISOString(), data_limit: 50 * GIB },
    });

    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);

    // The five remaining days are kept: 5 + 30, not 30.
    expect(panel.puts[0]?.body['expire']).toBe((NOW_MS + 35 * DAY) / 1000);
    expect(panel.puts[0]?.body['data_limit']).toBe(100 * GIB);
    // And the counter is NOT reset, because the quota grew instead.
    expect(panel.resets).toHaveLength(0);
    const sub = await subscriptionRow(target.subId);
    expect(sub?.used_bytes).toBe(20 * GIB);
    expect(sub?.volume_gb).toBe(100);
  });

  it('ADD does not resurrect time that has already run out', async () => {
    await setPanelConfig(panelId, {
      Methodextend: 'اضافه شدن زمان و حجم به ماه بعد',
      status_extend: 'on_extend',
    });
    const target = await paidRenewal({ expiresInDays: -10 });
    const panel = fakePanel({
      [target.username]: {
        expire: new Date(NOW_MS - 10 * DAY).toISOString(),
        data_limit: 50 * GIB,
      },
    });

    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);

    // 30 days from today, not 20 days from an expiry ten days in the past.
    expect(panel.puts[0]?.body['expire']).toBe((NOW_MS + 30 * DAY) / 1000);
  });

  it('does not apply the same renewal twice after a timeout', async () => {
    // The money case. The first attempt reaches the panel and the answer is
    // lost; the sweep puts the order back and tries again. Adding the month a
    // second time is the bug nobody reports, because the customer gets more
    // than they paid for and says nothing.
    await setPanelConfig(panelId, {
      Methodextend: 'اضافه شدن زمان و حجم به ماه بعد',
      status_extend: 'on_extend',
    });
    const target = await paidRenewal({ expiresInDays: 5 });
    const panel = fakePanel({
      [target.username]: { expire: new Date(NOW_MS + 5 * DAY).toISOString(), data_limit: 50 * GIB },
    });

    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);
    // Put it back exactly as a retryable failure would have.
    await db.prepare(`UPDATE orders SET status = 'PAID' WHERE id = ?1`).bind(target.order.id).run();
    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);

    expect(panel.puts).toHaveLength(1);
    const sub = await subscriptionRow(target.subId);
    expect(Date.parse(sub!.expires_at!)).toBe(NOW_MS + 35 * DAY);
  });

  it('leaves the order payable and says nothing when the panel is down', async () => {
    const target = await paidRenewal();

    await provisionPaidOrders(db, deadPanel, NOW_MS);

    const notes = await pendingNotifications();
    expect(await orderRow(target.order.id)).toMatchObject({ status: 'PAID' });
    expect(notes.some((n) => n.chatId === target.telegramId)).toBe(false);
  });

  it('stops for a human when the account is not on the panel any more', async () => {
    const target = await paidRenewal();
    const panel = fakePanel({}); // the account is gone

    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);

    const notes = await pendingNotifications();
    const order = await orderRow(target.order.id);
    expect(order?.status).toBe('FAILED');
    expect(order?.failure_reason).toContain(target.username);
    // The customer is told their money is safe rather than left in silence.
    expect(notes.find((n) => n.chatId === target.telegramId)?.text).toContain(
      target.order.publicId,
    );
  });
});

/**
 * `shopSetting.chashbackextend` — five percent of every renewal, paid back into
 * the customer's wallet, live in production for years and read by nothing here
 * until now.
 *
 * The rate is not asserted against our own constant. What the shop actually
 * charges is checked in `packages/migrate/test/shop-switches.mysql.test.ts`
 * against the dump; this file sets a rate and proves the bot obeys it, which is
 * the only half a Postgres-only test can honestly cover.
 */
describe('the renewal cashback', () => {
  async function setCashback(percent: number): Promise<void> {
    await db
      .prepare(
        `INSERT INTO settings (scope, key, value) VALUES ('shop', 'chashbackextend', ?1::jsonb)
         ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
      )
      .bind(JSON.stringify(String(percent)))
      .run();
    invalidateShopSettings();
  }

  async function cashbackRows(userId: number) {
    const { results } = await db
      .prepare(
        `SELECT amount_irr, note, order_id FROM wallet_entries
          WHERE user_id = ?1 AND kind = 'RENEWAL_CASHBACK' ORDER BY id`,
      )
      .bind(userId)
      .all<{ amount_irr: number; note: string | null; order_id: number | null }>();
    return results ?? [];
  }

  async function paidRenewal() {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const subId = await makeService(userId, panelId, {
      publicId: `cb-${telegramId}`,
      username: `c_${telegramId}`,
      expiresInDays: 5,
    });
    const plan = await planId('sim-vip-1m-50');
    await handleUpdate(db, press(updateId, telegramId, `rord:${subId}:${plan}`));
    const order = await markPaid(userId);
    const total = await db
      .prepare(`SELECT total_irr FROM orders WHERE id = ?1`)
      .bind(order.id)
      .first<{ total_irr: number }>();
    return { userId, subId, order, telegramId, username: `c_${telegramId}`, totalIrr: total!.total_irr };
  }

  afterEach(async () => {
    await setCashback(0);
  });

  it('pays the shop’s percentage into the wallet and says so in the same message', async () => {
    await setCashback(5);
    const target = await paidRenewal();
    const panel = fakePanel({
      [target.username]: { expire: new Date(NOW_MS + 5 * DAY).toISOString(), data_limit: 50 * GIB },
    });

    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);

    const notes = await pendingNotifications();
    const rows = await cashbackRows(target.userId);
    expect(rows).toHaveLength(1);
    // Against the order's own total read back from the database, not against a
    // price this test wrote down: the plan's price is the catalogue's business.
    expect(rows[0]?.amount_irr).toBe(Math.floor((target.totalIrr * 5) / 100));
    expect(rows[0]?.order_id).toBe(target.order.id);
    // And the customer is actually told, in the renewal message itself.
    const said = notes.find((n) => n.chatId === target.telegramId)?.text ?? '';
    expect(said).toContain(formatToman(Math.floor((target.totalIrr * 5) / 100)));
  });

  it('pays nothing, and says nothing, when the shop has no cashback', async () => {
    await setCashback(0);
    const target = await paidRenewal();
    const panel = fakePanel({
      [target.username]: { expire: new Date(NOW_MS + 5 * DAY).toISOString(), data_limit: 50 * GIB },
    });

    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);

    const notes = await pendingNotifications();
    expect(await cashbackRows(target.userId)).toHaveLength(0);
    expect(await orderRow(target.order.id)).toMatchObject({ status: 'COMPLETED' });
    // The gift line is absent rather than rendered with a zero.
    expect(notes.find((n) => n.chatId === target.telegramId)?.text).not.toContain('هدیهٔ تمدید');
  });

  it('pays once when a lost answer makes the sweep run the renewal again', async () => {
    // The same retry that must not add thirty days twice must not pay twice
    // either. Both guarantees are the database's — one is the panel call being
    // skipped, this one is `wallet_entries.idempotency_key`.
    await setCashback(5);
    const target = await paidRenewal();
    const panel = fakePanel({
      [target.username]: { expire: new Date(NOW_MS + 5 * DAY).toISOString(), data_limit: 50 * GIB },
    });

    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);
    await db.prepare(`UPDATE orders SET status = 'PAID' WHERE id = ?1`).bind(target.order.id).run();
    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);

    expect(await cashbackRows(target.userId)).toHaveLength(1);
  });

  it('pays nothing when the renewal failed and the money went back', async () => {
    // The reason the credit is written inside the COMPLETED transaction rather
    // than when the order was paid: a renewal that never reached the account is
    // refunded, and cashback on top of a refund is the shop paying a customer
    // for a bad night.
    await setCashback(5);
    const target = await paidRenewal();
    const panel = fakePanel({}); // the account is not on the panel any more

    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);

    expect(await orderRow(target.order.id)).toMatchObject({ status: 'FAILED' });
    expect(await cashbackRows(target.userId)).toHaveLength(0);
  });

  it('is a renewal’s gift and not a purchase’s', async () => {
    await setCashback(5);
    const { telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const plan = await planId('sim-vip-1m-50');
    const order = await db
      .prepare(
        `INSERT INTO orders (public_id, user_id, kind, plan_id, quantity,
                             unit_price_irr, discount_irr, total_irr, status)
         VALUES (?1, ?2, 'NEW_PURCHASE', ?3, 1, 1000000, 0, 1000000, 'PAID')
         RETURNING id`,
      )
      .bind(`cbp-${telegramId}`, userId, plan)
      .first<{ id: number }>();

    const paid = await db.withSession((tx) => creditRenewalCashback(tx, order!.id, 5));

    expect(paid).toBeNull();
    expect(await cashbackRows(userId)).toHaveLength(0);
  });

  it('treats a corrected rate as a second decision, not a silent no-op', async () => {
    // The percentage is inside the idempotency key on purpose. An admin who
    // notices the rate was wrong and re-runs is making a real decision; keying
    // on the order alone would swallow it and look like it worked.
    await setCashback(5);
    const target = await paidRenewal();
    const panel = fakePanel({
      [target.username]: { expire: new Date(NOW_MS + 5 * DAY).toISOString(), data_limit: 50 * GIB },
    });
    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);

    const again = await db.withSession((tx) => creditRenewalCashback(tx, target.order.id, 7));

    expect(again).toBe(Math.floor((target.totalIrr * 7) / 100));
    expect(await cashbackRows(target.userId)).toHaveLength(2);
  });

  it('will not touch the panel at all on a rate it could not read', async () => {
    // The failure the read's placement exists for. `loadShopSettings` answers an
    // unreachable database with the shipped defaults, where the cashback is 0 —
    // so a read taken AFTER the panel call finished the renewal paying nothing,
    // and nothing ever looks at a COMPLETED order again. The customer got their
    // days and silently lost the five percent.
    //
    // The table is really taken away rather than stubbed: what is under test is
    // the loader's own catch, and a stub returning the defaults would only prove
    // this test can build them.
    await setCashback(5);
    const target = await paidRenewal();
    const panel = fakePanel({
      [target.username]: { expire: new Date(NOW_MS + 5 * DAY).toISOString(), data_limit: 50 * GIB },
    });

    await db.prepare(`ALTER TABLE settings RENAME TO settings_hidden`).run();
    invalidateShopSettings();
    try {
      await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);

      // Nothing irreversible happened — the account was never extended.
      expect(panel.puts.filter((p) => p.username === target.username)).toEqual([]);
      // And the order is back where the next sweep finds it.
      expect(await orderRow(target.order.id)).toMatchObject({ status: 'PAID' });
      expect(await cashbackRows(target.userId)).toHaveLength(0);
    } finally {
      await db.prepare(`ALTER TABLE settings_hidden RENAME TO settings`).run();
      invalidateShopSettings();
    }

    // Once the database answers again the customer gets the renewal AND the five
    // percent, which is what makes this a delay rather than a loss.
    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);

    expect(await orderRow(target.order.id)).toMatchObject({ status: 'COMPLETED' });
    const rows = await cashbackRows(target.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount_irr).toBe(Math.floor((target.totalIrr * 5) / 100));
  });
});
