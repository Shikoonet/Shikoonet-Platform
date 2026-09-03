/**
 * Extra gigabytes and extra days.
 *
 * A customer taps a button, types a number, and pays. Three things can go wrong
 * with money here and each has a test: the total can disagree with the rate and
 * the quantity, a typed number can be something other than a number, and the
 * purchase can reach the panel as the wrong shape — the dangerous one being an
 * extra-volume order that also moves the expiry.
 *
 * The rate is not invented by this test: it is the production VIP row, the same
 * fixture `packages/domain/test/extraPricing.test.ts` is measured against.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import { provisionPaidOrders } from '../src/provision.js';
import * as menu from '../src/menu.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer, providerId, setTierDiscount } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 7, 14, 9, 0, 0);
const DAY = 86_400_000;
const GIB = 1024 ** 3;
const PANEL_CODE = 'sim-addon-panel';

/** The live VIP panel's own settings, in toman, keyed by tier. */
const PRICING = {
  status_extend: 'on_extend',
  priceextravolume: '{"f":"50000","n":"5000","n2":"5000"}',
  priceextratime: '{"f":"15000","n":"4000","n2":"4000"}',
};

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 700_000 + n, telegramId: 720_000 + n };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `add${telegramId}` },
      message: { message_id: 42, chat: { id: telegramId } },
      data,
    },
  };
}

function types(updateId: number, telegramId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: telegramId },
      from: { id: telegramId, username: `add${telegramId}` },
      text,
    },
  };
}

/** A panel holding one account, recording every PUT. */
function panel(account: Record<string, unknown>) {
  const puts: Record<string, unknown>[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/admin/token')) {
      return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
    }
    if (method === 'PUT') {
      puts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ username: 'u_add', subscription_url: '/sub/u_add' }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify(account), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { puts, fetchImpl };
}

async function makeService(
  userId: number,
  options: { volumeGb?: number | null; expiresInDays?: number | null } = {},
): Promise<number> {
  const provider = await providerId('sim-vip');
  const row = await db
    .prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, provider_id, plan_name_at_sale, provider_name_at_sale,
          price_irr, remote_username, subscription_url, volume_gb, duration_days,
          status, purchased_at, expires_at)
       VALUES (?1, ?2, ?3, 'یک‌ماهه-۲۰گیگ', 'لوکیشن تست', 1000000, 'u_add',
               'https://panel.test/sub/u_add', ?4, 30, 'ACTIVE', now(), ?5)
       RETURNING id`,
    )
    .bind(
      `add${nextId}-${userId}`,
      userId,
      provider,
      options.volumeGb === undefined ? 20 : options.volumeGb,
      options.expiresInDays === undefined || options.expiresInDays === null
        ? null
        : new Date(NOW_MS + options.expiresInDays * DAY).toISOString(),
    )
    .first<{ id: number }>();
  if (!row) throw new Error('service fixture failed');
  return row.id;
}

async function lastOrder(userId: number) {
  return db
    .prepare(
      `SELECT id, kind, quantity, unit_price_irr, discount_irr, total_irr, status,
              target_subscription_id, plan_id
         FROM orders WHERE user_id = ?1 ORDER BY id DESC LIMIT 1`,
    )
    .bind(userId)
    .first<{
      id: number;
      kind: string;
      quantity: number;
      unit_price_irr: number;
      discount_irr: number;
      total_irr: number;
      status: string;
      target_subscription_id: number | null;
      plan_id: number | null;
    }>();
}

/** Merges a pricing table into the panel's config. Shared state: put it back. */
async function setPanelPricing(
  pricing: Record<string, string | number | null>,
): Promise<void> {
  await db
    .prepare(
      `UPDATE provisioning_providers SET config = config || ?1::jsonb WHERE code = 'sim-vip'`,
    )
    .bind(JSON.stringify(pricing))
    .run();
}

beforeAll(async () => {
  await ensureCatalog();
  process.env[`PANEL_${PANEL_CODE.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = 'admin:secret';
  await db
    .prepare(
      `UPDATE provisioning_providers
          SET base_url = 'https://panel.test', secret_ref = ?1, config = config || ?2::jsonb
        WHERE code = 'sim-vip'`,
    )
    .bind(PANEL_CODE, JSON.stringify(PRICING))
    .run();
});

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  // Orders left PAID by an earlier test would be picked up by the sweep this
  // one runs, and its assertions would be about somebody else's purchase.
  await db
    .prepare(`UPDATE orders SET status = 'CANCELLED' WHERE status IN ('PAID', 'PROVISIONING')`)
    .run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buying extra volume', () => {
  it('charges the panel’s rate for the number the customer typed', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId);

    const ask = await handleUpdate(db, press(updateId, telegramId, `xv:${service}`));
    // The rate is stated before anything is bought: 50,000 toman a gigabyte.
    expect(ask.replies[0]?.text).toContain('50,000 تومان');

    const invoice = await handleUpdate(db, types(updateId + 1, telegramId, '5'));

    const order = await lastOrder(userId);
    expect(order).toMatchObject({
      kind: 'ADD_VOLUME',
      quantity: 5,
      unit_price_irr: 500_000,
      total_irr: 2_500_000,
      target_subscription_id: service,
      // No plan: an add-on is not a product, and a plan here would send the
      // sweep off to provision a whole new account.
      plan_id: null,
    });
    expect(invoice.replies[0]?.text).toContain('250,000 تومان');
  });

  it('applies the reseller rate to a reseller', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId, { reseller: true });
    const service = await makeService(userId);

    await handleUpdate(db, press(updateId, telegramId, `xv:${service}`));
    await handleUpdate(db, types(updateId + 1, telegramId, '5'));

    // 5,000 toman a gigabyte on this panel, not 50,000.
    expect(await lastOrder(userId)).toMatchObject({ unit_price_irr: 50_000, total_irr: 250_000 });
  });

  /**
   * «نماینده سطح ۲» was a price box nobody could ever be charged from.
   *
   * `tierFor` could only answer `f` or `n` until 0047, so the `n2` entry in
   * `priceextravolume` — present on every live panel and editable on every
   * panel screen — decided nothing. This is the first test that reaches it.
   *
   * The production figures have `n` and `n2` both at 5,000, so asserting
   * against them would pass with the tier ignored. The panel is given a
   * distinct `n2` for the length of this test and put back afterwards.
   */
  it('charges the second reseller level its own rate', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId, { reseller: true, tier: 'n2' });
    const service = await makeService(userId);
    await setPanelPricing({ ...PRICING, priceextravolume: '{"f":"50000","n":"5000","n2":"2000"}' });

    try {
      await handleUpdate(db, press(updateId, telegramId, `xv:${service}`));
      await handleUpdate(db, types(updateId + 1, telegramId, '5'));

      // 2,000 toman a gigabyte — neither the ordinary 50,000 nor level one's 5,000.
      expect(await lastOrder(userId)).toMatchObject({
        unit_price_irr: 20_000,
        total_irr: 100_000,
      });
    } finally {
      await setPanelPricing(PRICING);
    }
  });

  /**
   * The `handleTypedAnswer` load of `Caller`, which nothing else reaches.
   *
   * Two of the three loads are `RETURNING` clauses in `handleCallback`; this
   * one is a plain SELECT, and an add-on quantity is the only typed answer that
   * spends the discount it carries. Drop the shared expression from that
   * statement and this is the test that goes red.
   *
   * It also puts a decision on the record: a level's discount applies to an
   * add-on as well as to the panel rate, so a reseller gets both. That is what
   * `placeAddonOrder` has always done with a standing discount — «unlike a
   * deposit, this IS merchandise» — and a level is a standing discount.
   */
  it('applies the level’s discount to an add-on', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId, { reseller: true, tier: 'n' });
    const service = await makeService(userId);
    await setTierDiscount('n', 50);

    try {
      await handleUpdate(db, press(updateId, telegramId, `xv:${service}`));
      await handleUpdate(db, types(updateId + 1, telegramId, '4'));

      // Level one's panel rate is 5,000 toman a gigabyte — 50,000 IRR — so four
      // gigabytes list at 200,000 IRR, and the level's 50% halves that.
      expect(await lastOrder(userId)).toMatchObject({
        quantity: 4,
        unit_price_irr: 50_000,
        discount_irr: 100_000,
        total_irr: 100_000,
      });
    } finally {
      await setTierDiscount('n', 0);
    }
  });

  /**
   * «حداقل خرید» — Sam, 2026-09-03. There was no floor at all: the only bound
   * was «greater than zero», so a customer could buy one gigabyte.
   *
   * The three cases are the whole rule, and the middle one is the reason the
   * other two are not enough: a check written as `<=` instead of `<` refuses
   * the minimum itself, which is the number the screen told the customer to
   * send.
   *
   * The bounds are read from the PANEL, so they are set on it here — and the
   * check has to run AFTER the panel is loaded, which is what moved it below
   * the «this panel does not sell that» exit in `handleAddonAmount`.
   */
  it('refuses less than the panel’s minimum, and takes the minimum itself', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId);
    await setPanelPricing({ ...PRICING, mainvolume: '10' });

    try {
      await handleUpdate(db, press(updateId, telegramId, `xv:${service}`));
      const tooLittle = await handleUpdate(db, types(updateId + 1, telegramId, '9'));
      expect(tooLittle.replies[0]?.text).toBe(menu.addonTooLittle(10));
      expect(await lastOrder(userId)).toBeNull();

      // At the minimum: allowed, and it is the same number the refusal named.
      await handleUpdate(db, press(updateId + 2, telegramId, `xv:${service}`));
      await handleUpdate(db, types(updateId + 3, telegramId, '10'));
      expect(await lastOrder(userId)).toMatchObject({ quantity: 10 });
    } finally {
      await setPanelPricing({ ...PRICING, mainvolume: null });
    }
  });

  it('still refuses more than the ceiling when the panel names none', async () => {
    // `ADDON_MAX` stopped being the ceiling and became the FALLBACK ceiling. A
    // panel with no `maxvolume` must behave exactly as it did before.
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId);

    await handleUpdate(db, press(updateId, telegramId, `xv:${service}`));
    const out = await handleUpdate(db, types(updateId + 1, telegramId, '1001'));

    expect(out.replies[0]?.text).toBe(menu.addonTooMuch(1000));
    expect(await lastOrder(userId)).toBeNull();
  });

  it('lets the panel lower the ceiling below the built-in one', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId);
    await setPanelPricing({ ...PRICING, maxvolume: '20' });

    try {
      await handleUpdate(db, press(updateId, telegramId, `xv:${service}`));
      const out = await handleUpdate(db, types(updateId + 1, telegramId, '21'));
      expect(out.replies[0]?.text).toBe(menu.addonTooMuch(20));
      expect(await lastOrder(userId)).toBeNull();
    } finally {
      await setPanelPricing({ ...PRICING, maxvolume: null });
    }
  });

  it('says «not sold here» rather than «the minimum is ten» when the price goes away', async () => {
    // The order of the two checks, in the one case that can actually reach it:
    // the prompt opened while the panel had a price, and an admin cleared the
    // price before the customer typed. The answer must be «this is not sold
    // here» — the check the minimum was deliberately placed BELOW.
    //
    // Pressing «حجم اضافه» on a panel with no price never gets this far; it is
    // refused at the button, which is why this test opens the session first.
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId);
    await setPanelPricing({ ...PRICING, mainvolume: '10' });

    try {
      await handleUpdate(db, press(updateId, telegramId, `xv:${service}`));
      await setPanelPricing({ priceextravolume: '{"f":null,"n":null,"n2":null}' });

      const out = await handleUpdate(db, types(updateId + 1, telegramId, '3'));

      expect(out.replies[0]?.text).toBe(menu.ACTION_UNSUPPORTED);
      expect(await lastOrder(userId)).toBeNull();
    } finally {
      await setPanelPricing({ ...PRICING, mainvolume: null });
    }
  });

  it('adds the gigabytes without moving an expiry that does not exist', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId, { expiresInDays: null });
    await handleUpdate(db, press(updateId, telegramId, `xv:${service}`));
    await handleUpdate(db, types(updateId + 1, telegramId, '5'));
    const order = await lastOrder(userId);
    await db.prepare(`UPDATE orders SET status = 'PAID' WHERE id = ?1`).bind(order!.id).run();

    // The panel holds an account with a quota and no expiry.
    const p = panel({ username: 'u_add', data_limit: 20 * GIB, expire: 0 });
    await provisionPaidOrders(db, p.fetchImpl, NOW_MS);

    expect(p.puts[0]?.['data_limit']).toBe(25 * GIB);
    // The dangerous one: `expire` must not become "now".
    expect(p.puts[0]?.['expire']).toBe(0);
    const row = await db
      .prepare(
        `SELECT o.status, s.expires_at, s.plan_name_at_sale FROM orders o
                  JOIN subscriptions s ON s.id = o.target_subscription_id
                 WHERE o.id = ?1`,
      )
      .bind(order!.id)
      .first<{ status: string; expires_at: string | null; plan_name_at_sale: string }>();
    expect(row).toMatchObject({
      status: 'COMPLETED',
      expires_at: null,
      // And the service keeps its name — an add-on has no plan to rename it to.
      plan_name_at_sale: 'یک‌ماهه-۲۰گیگ',
    });
  });
});

describe('buying extra time', () => {
  it('adds days to what is left, and leaves the quota alone', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId, { expiresInDays: 5 });
    await handleUpdate(db, press(updateId, telegramId, `xt:${service}`));
    await handleUpdate(db, types(updateId + 1, telegramId, '7'));

    const order = await lastOrder(userId);
    expect(order).toMatchObject({ kind: 'ADD_TIME', quantity: 7, unit_price_irr: 150_000 });
    await db.prepare(`UPDATE orders SET status = 'PAID' WHERE id = ?1`).bind(order!.id).run();

    const p = panel({
      username: 'u_add',
      data_limit: 20 * GIB,
      expire: Math.floor((NOW_MS + 5 * DAY) / 1000),
    });
    await provisionPaidOrders(db, p.fetchImpl, NOW_MS);

    // Five days left plus seven bought — not seven from today.
    expect(p.puts[0]?.['expire']).toBe((NOW_MS + 12 * DAY) / 1000);
    expect(p.puts[0]?.['data_limit']).toBe(20 * GIB);
  });
});

describe('what the customer may type', () => {
  it('asks again for anything that is not a count', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId);
    await handleUpdate(db, press(updateId, telegramId, `xv:${service}`));

    for (const [i, text] of ['', 'پنج', '-3', '2.5', '0'].entries()) {
      const out = await handleUpdate(db, types(updateId + 1 + i, telegramId, text));
      // An empty message is not a message; the rest are answered.
      if (text !== '') expect(out.replies[0]?.text).toBe(menu.ADDON_NOT_A_NUMBER);
      expect(await lastOrder(userId)).toBeNull();
    }
  });

  it('reads Persian digits, because a Persian keyboard types them', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId);
    await handleUpdate(db, press(updateId, telegramId, `xv:${service}`));

    await handleUpdate(db, types(updateId + 1, telegramId, '۵'));

    expect(await lastOrder(userId)).toMatchObject({ quantity: 5 });
  });

  it('refuses an amount nobody buys', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId);
    await handleUpdate(db, press(updateId, telegramId, `xv:${service}`));

    const out = await handleUpdate(db, types(updateId + 1, telegramId, '99999'));

    expect(out.replies[0]?.text).toContain('1,000');
    expect(await lastOrder(userId)).toBeNull();
  });

  it('ignores a number typed by somebody who was never asked', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await makeService(userId);

    const out = await handleUpdate(db, types(updateId, telegramId, '5'));

    expect(out.status).toBe('ignored');
    expect(await lastOrder(userId)).toBeNull();
  });
});

describe('whose service it is', () => {
  it('will not sell an add-on for a service belonging to somebody else', async () => {
    const owner = await makeCustomer(ids().telegramId);
    const service = await makeService(owner);
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);

    const out = await handleUpdate(db, press(updateId, telegramId, `xv:${service}`));

    expect(out.replies[0]?.text).toBe(menu.SERVICE_GONE);
    expect(await lastOrder(userId)).toBeNull();
  });
});
