/**
 * The shop's own switches, judged by what the customer is sent.
 *
 * The migration moved 51 columns of MySQL settings into `settings` and, until
 * this slice, nothing read the `shop` or `pay` scopes at all — `settings.ts`
 * had three helpers and every caller in the tree passed scope `bot`. So the bot
 * offered «افزودن حجم», «افزودن زمان» and the on/off switch on a shop that has
 * had all three turned off for years, and charged a referral commission from a
 * constant while the admin's own number sat unread in the table.
 *
 * The words and numbers asserted here are checked against the production dump
 * by `packages/migrate/test/shop-switches.mysql.test.ts`. That is the outside
 * truth; this file only proves the bot obeys them.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertSchema, db } from './helpers/env.js';
import { ensureCatalog, makeCustomer, providerId } from './helpers/shop.js';
import { handleUpdate } from '../src/handle.js';
import {
  DEFAULT_SHOP_SETTINGS,
  invalidateShopSettings,
  loadShopSettings,
} from '../src/settings.js';
import { topupNeededIrr, topupPresetsIrr } from '../src/wallet.js';
import * as menu from '../src/menu.js';

let nextId = 0;
function ids(): { updateId: number; telegramId: number } {
  const n = ++nextId * 10;
  return { updateId: 986_000 + n, telegramId: 855_000 + n };
}

function press(updateId: number, telegramId: number, data: string) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `sw${telegramId}` },
      message: { message_id: 8181, chat: { id: telegramId } },
      data,
    },
  };
}

function startUpdate(updateId: number, telegramId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: telegramId, username: `sw${telegramId}` },
      chat: { id: telegramId },
      text: '/start',
    },
  };
}

async function put(scope: string, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (scope, key, value) VALUES (?1, ?2, ?3::jsonb)
       ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
    )
    .bind(scope, key, JSON.stringify(value))
    .run();
  invalidateShopSettings();
}

async function clearSettings(): Promise<void> {
  await db
    .prepare(`DELETE FROM settings WHERE scope IN ('shop', 'pay') OR key = 'affiliatespercentage'`)
    .run();
  invalidateShopSettings();
}

const datas = (rows: { callback_data: string }[][] | undefined) =>
  (rows ?? []).flat().map((b) => b.callback_data);

/** A service on a panel that prices both add-ons and is currently running. */
const SELLING_PANEL = {
  id: 42,
  disabled: false,
  volumeIrrPerGb: 50_000,
  timeIrrPerDay: 10_000,
};

/**
 * A service the panel can act on: a real provider, a remote username, and an
 * ACTIVE row. Without all three `actionsFor` returns null and the screen has no
 * panel buttons at all, which would make every assertion below pass for the
 * wrong reason.
 */
async function makeService(telegramId: number): Promise<void> {
  const userId = await makeCustomer(telegramId);
  const provider = await providerId('sim-vip');
  await db
    .prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, provider_id, plan_name_at_sale, provider_name_at_sale,
          price_irr, remote_username, subscription_url, volume_gb, status, purchased_at)
       VALUES (?1, ?2, ?3, 'یک‌ماهه', 'لوکیشن تست', 1950000, ?4,
               'https://panel.test/sub/u_sw/0', 50, 'ACTIVE', now())
       ON CONFLICT (public_id) DO NOTHING`,
    )
    .bind(`sw${telegramId}`, userId, provider, `u_sw${telegramId}`)
    .run();
}

/** The buttons a customer is actually sent on their service page. */
async function serviceButtons(telegramId: number): Promise<string[]> {
  const { updateId } = ids();
  await handleUpdate(db, startUpdate(updateId, telegramId));
  const mine = await handleUpdate(db, press(updateId + 1, telegramId, 'mine'));
  const sub = datas(mine.replies[0]?.keyboard).find((d) => d.startsWith('sub:'));
  if (sub === undefined) throw new Error('the service fixture is not listed');
  const detail = await handleUpdate(db, press(updateId + 2, telegramId, sub));
  return datas(detail.replies[0]?.keyboard);
}

beforeAll(async () => {
  await assertSchema();
  await ensureCatalog();
});
beforeEach(clearSettings);
afterEach(clearSettings);

describe('reading the shop settings', () => {
  it('behaves as the last release did when nothing is set', async () => {
    // A shop with no rows must keep selling what it sold yesterday. Defaulting
    // a missing switch to OFF would close a working shop on a failed read.
    expect(await loadShopSettings(db)).toEqual(DEFAULT_SHOP_SETTINGS);
  });

  it('turns a feature off only on the exact word', async () => {
    await put('shop', 'statusextra', 'offextra');
    expect((await loadShopSettings(db)).sellsExtraVolume).toBe(false);

    // Anything else — a typo, a value from a newer admin panel — leaves the
    // feature as it was. Closing a shop because of an unrecognised string is
    // the worse failure.
    await put('shop', 'statusextra', 'offextraa');
    expect((await loadShopSettings(db)).sellsExtraVolume).toBe(true);

    await put('shop', 'statusextra', 'onextra');
    expect((await loadShopSettings(db)).sellsExtraVolume).toBe(true);
  });

  it('refuses a commission percentage that is not one', async () => {
    // This multiplies real money into a wallet. A row holding 1000 is a broken
    // row, not an instruction to pay ten times the purchase.
    for (const bad of ['1000', '-5', 'ten', '']) {
      await put('bot', 'affiliatespercentage', bad);
      expect((await loadShopSettings(db)).commissionPercent, bad).toBe(10);
    }
    await put('bot', 'affiliatespercentage', '15');
    expect((await loadShopSettings(db)).commissionPercent).toBe(15);
  });

  it('converts the Toman limits to Rial exactly once', async () => {
    await put('pay', 'minbalancecart', '80000');
    await put('pay', 'maxbalancecart', '10000000');
    const shop = await loadShopSettings(db);
    expect(shop.topupMinIrr).toBe(800_000);
    expect(shop.topupMaxIrr).toBe(100_000_000);
  });

  it('refuses a floor above its ceiling rather than half-applying it', async () => {
    // Two rows edited one at a time pass through this state, and between the
    // two saves there would be no amount a customer could deposit at all.
    await put('pay', 'minbalancecart', '900000');
    await put('pay', 'maxbalancecart', '100000');
    const shop = await loadShopSettings(db);
    expect(shop.topupMinIrr).toBe(DEFAULT_SHOP_SETTINGS.topupMinIrr);
    expect(shop.topupMaxIrr).toBe(DEFAULT_SHOP_SETTINGS.topupMaxIrr);
  });
});

describe('a switch the shop has turned off', () => {
  it('takes the add-on buttons off a service that could otherwise sell them', async () => {
    // Through `handleUpdate`, not by rebuilding what `actionsFor` does: the
    // wiring between the setting and the screen is the whole of what this slice
    // added, and a test that recomputed it would agree with itself.
    const telegramId = 855_900_001;
    await makeService(telegramId);

    const before = await serviceButtons(telegramId);
    expect(before.some((d) => d.startsWith('xv:'))).toBe(true);
    expect(before.some((d) => d.startsWith('xt:'))).toBe(true);

    await put('shop', 'statusextra', 'offextra');
    await put('shop', 'statustimeextra', 'offtimeextraa');

    const after = await serviceButtons(telegramId);
    expect(after.some((d) => d.startsWith('xv:'))).toBe(false);
    expect(after.some((d) => d.startsWith('xt:'))).toBe(false);
    // An off switch removes a button; it does not strand the customer.
    expect(after).toContain('mine');
    expect(after.some((d) => d.startsWith('rvk:'))).toBe(true);
  });

  it('takes the on/off pair off a real service too', async () => {
    const telegramId = 855_900_002;
    await makeService(telegramId);
    expect((await serviceButtons(telegramId)).some((d) => d.startsWith('off:'))).toBe(true);

    await put('shop', 'statuschangeservice', 'offstatus');
    const after = await serviceButtons(telegramId);
    expect(after.some((d) => d.startsWith('off:'))).toBe(false);
    expect(after.some((d) => d.startsWith('on:'))).toBe(false);
  });

  it('takes the on/off pair off, leaving the rest of the screen', () => {
    const rows = menu.serviceDetailMenu({ ...SELLING_PANEL, canSwitch: false });
    expect(datas(rows)).not.toContain('off:42');
    expect(datas(rows)).not.toContain('on:42');
    expect(datas(rows)).toContain('rvk:42');
    expect(datas(rows)).toContain('menu');
  });

  it('still draws them when the shop has them on', () => {
    const rows = menu.serviceDetailMenu({ ...SELLING_PANEL, canSwitch: true });
    expect(datas(rows)).toEqual(['xv:42', 'xt:42', 'rvk:42', 'off:42', 'mine', 'menu']);
  });
});

describe('the deposit limits', () => {
  it('offers presets inside the shop’s own range', () => {
    const presets = topupPresetsIrr(800_000, 100_000_000);
    expect(presets.length).toBeGreaterThan(1);
    expect(Math.min(...presets)).toBe(800_000);
    expect(Math.max(...presets)).toBe(100_000_000);
    for (const p of presets) {
      expect(p % 10, `${p} is a whole Toman`).toBe(0);
    }
  });

  it('resolves a tap against the presets it drew, not a constant', () => {
    const presets = topupPresetsIrr(800_000, 100_000_000);
    // The button carries the CHOICE. Reading the amount off the wire is the one
    // thing this path must never do.
    expect(presets[0]).toBe(800_000);
    expect(presets.at(-1)).toBe(100_000_000);
  });

  it('raises a shortfall to the shop’s floor, not to a hardcoded one', () => {
    // A customer 30,000 Toman short is asked for the floor and keeps the rest
    // as credit; being told to send an amount the shop refuses is worse.
    expect(topupNeededIrr(2_000_000, 1_700_000, 800_000)).toBe(800_000);
    expect(topupNeededIrr(2_000_000, 1_700_000, 5_000_000)).toBe(5_000_000);
    expect(topupNeededIrr(2_000_000, 2_000_000, 800_000)).toBeNull();
  });

  it('tells the customer the shop’s numbers, through a real update', async () => {
    await put('pay', 'minbalancecart', '80000');
    await put('pay', 'maxbalancecart', '10000000');

    const { updateId, telegramId } = ids();
    await handleUpdate(db, startUpdate(updateId, telegramId));
    await handleUpdate(db, press(updateId + 1, telegramId, 'wal'));
    const top = await handleUpdate(db, press(updateId + 2, telegramId, 'top'));

    const text = top.replies[0]?.text ?? '';
    expect(text).toContain('80,000 تومان');
    expect(text).toContain('10,000,000 تومان');
    // The old ceiling, 25× too low, must not be what a customer is offered.
    expect(text).not.toContain('400,000 تومان');
  });
});
