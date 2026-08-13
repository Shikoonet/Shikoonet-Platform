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
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId, providerId } from './helpers/shop.js';

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
async function setPanelConfig(provider: number, config: Record<string, unknown>): Promise<void> {
  await db
    .prepare(
      `UPDATE provisioning_providers
          SET base_url = 'https://renew.test', secret_ref = ?2, kind = 'marzban', config = ?3::jsonb
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
  // The sweep takes every PAID order, not just this test's. Without this the
  // panel counters below are counting somebody else's renewal too — which is
  // exactly how a green assertion ends up proving nothing.
  await db
    .prepare(`UPDATE orders SET status = 'CANCELLED' WHERE status IN ('PAID', 'PROVISIONING')`)
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

    const notes = await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);

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

    const notes = await provisionPaidOrders(db, deadPanel, NOW_MS);

    expect(await orderRow(target.order.id)).toMatchObject({ status: 'PAID' });
    expect(notes.some((n) => n.chatId === target.telegramId)).toBe(false);
  });

  it('stops for a human when the account is not on the panel any more', async () => {
    const target = await paidRenewal();
    const panel = fakePanel({}); // the account is gone

    const notes = await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);

    const order = await orderRow(target.order.id);
    expect(order?.status).toBe('FAILED');
    expect(order?.failure_reason).toContain(target.username);
    // The customer is told their money is safe rather than left in silence.
    expect(notes.find((n) => n.chatId === target.telegramId)?.text).toContain(
      target.order.publicId,
    );
  });
});
