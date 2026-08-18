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
import { assertSchema, db , pendingNotifications } from './helpers/env.js';
import { ensureCatalog, ensurePaymentCard, makeCustomer, providerId } from './helpers/shop.js';
import { handleUpdate } from '../src/handle.js';
import {
  DEFAULT_SHOP_SETTINGS,
  invalidateShopSettings,
  loadShopSettings,
  SHOP_SETTING_KEYS,
} from '../src/settings.js';
import { topupNeededIrr, topupPresetsIrr } from '../src/wallet.js';
import { warnExpiringServices } from '../src/warn.js';
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

/**
 * Puts the shop back to "nothing configured".
 *
 * Driven off `SHOP_SETTING_KEYS`, the same list the loader reads from, so it
 * cannot fall behind. The hand-written version cleared two scopes and one `bot`
 * key; three more `bot` keys arrived later and their leftovers closed the shop
 * for every describe block after the one that switched it off.
 */
async function clearSettings(): Promise<void> {
  for (const [scope, key] of SHOP_SETTING_KEYS) {
    await db.prepare(`DELETE FROM settings WHERE scope = ?1 AND key = ?2`).bind(scope, key).run();
  }
  invalidateShopSettings();
}

const datas = (rows: { callback_data?: string }[][] | undefined) =>
  (rows ?? []).flat().flatMap((b) => (b.callback_data === undefined ? [] : [b.callback_data]));

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
  // Priced here rather than assumed. This file used to read the add-on rates
  // off whatever `addon.test.ts` had left on the shared `sim-vip` row, so
  // «افزودن حجم» appeared only when that file happened to run first — and the
  // assertion that the button EXISTS before the switch is turned off then fails
  // for a reason that has nothing to do with the switch. A test that depends on
  // another file's fixture is a test that passes by luck.
  await db
    .prepare(
      `UPDATE provisioning_providers
          SET base_url = coalesce(base_url, 'https://panel.test'),
              kind = 'pasarguard',
              config = coalesce(config, '{}'::jsonb) || ?2::jsonb
        WHERE id = ?1`,
    )
    .bind(
      provider,
      JSON.stringify({
        priceextravolume: '{"f":"50000","n":"5000","n2":"5000"}',
        priceextratime: '{"f":"15000","n":"4000","n2":"4000"}',
      }),
    )
    .run();
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
  it('names every row it reads exactly once, whatever the scope', async () => {
    // The loader looks a value up by KEY alone, so two scopes carrying the same
    // key would silently make one of them unreadable. This is the assumption
    // that makes the list usable as a list; it is checked rather than trusted.
    const keys = SHOP_SETTING_KEYS.map(([, key]) => key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('behaves as the last release did when nothing is set', async () => {
    // A shop with no rows must keep selling what it sold yesterday. Defaulting
    // a missing switch to OFF would close a working shop on a failed read.
    //
    // Every value matches the shipped defaults and one field does not, and that
    // is the point of the field: an empty table and an unreachable table give
    // the same twelve answers, and only `fromDatabase` tells a money path which
    // of the two it is holding.
    expect(await loadShopSettings(db)).toEqual({ ...DEFAULT_SHOP_SETTINGS, fromDatabase: true });
    expect(DEFAULT_SHOP_SETTINGS.fromDatabase).toBe(false);
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

/**
 * `setting.Bot_Status` — the admin's closed sign.
 *
 * Switchable from the legacy admin panel for years, and this bot sold straight
 * through it. It matters most in the week it was written for: the cutover is an
 * announced pause, and the tool that makes a pause possible is one that stops
 * customers without stopping the people running it.
 */
describe('the shop’s closed sign', () => {
  async function makeAdmin(telegramId: number): Promise<void> {
    await db
      .prepare(
        `INSERT INTO admins (telegram_id, username, role, permissions, active)
         VALUES (?1, ?2, 'OWNER', '[]'::jsonb, true)
         ON CONFLICT (telegram_id) DO UPDATE SET active = true, role = 'OWNER'`,
      )
      .bind(telegramId, `adm${telegramId}`)
      .run();
  }

  it('leaves the shop open on any value it does not recognise', async () => {
    await put('bot', 'Bot_Status', 'botstatuson');
    expect((await loadShopSettings(db)).open).toBe(true);
    // A typo, or a word from a newer admin panel. Closing a working shop
    // because a string was unreadable is the worse failure — the same rule the
    // three feature switches follow.
    await put('bot', 'Bot_Status', 'botstatusofff');
    expect((await loadShopSettings(db)).open).toBe(true);
    await put('bot', 'Bot_Status', 'botstatusoff');
    expect((await loadShopSettings(db)).open).toBe(false);
  });

  it('answers a customer with the sign and nothing else, on both doors', async () => {
    const { updateId, telegramId } = ids();
    await handleUpdate(db, startUpdate(updateId, telegramId));
    await put('bot', 'Bot_Status', 'botstatusoff');

    const started = await handleUpdate(db, startUpdate(updateId + 1, telegramId));
    // The callback door too, and that is the half worth having: a customer
    // still holding yesterday's invoice can press «پرداخت کردم» without ever
    // sending a message.
    const pressed = await handleUpdate(db, press(updateId + 2, telegramId, 'buy'));

    for (const out of [started, pressed]) {
      expect(out.status).toBe('processed');
      expect(out.replies).toHaveLength(1);
      expect(out.replies[0]?.text).toContain('فروشگاه موقتاً بسته است');
      // No menu underneath: a closed shop that still draws its buttons is a
      // shop that looks open.
      expect(out.replies[0]?.keyboard).toBeUndefined();
    }
  });

  it('lets an admin keep working while it is closed', async () => {
    const { updateId, telegramId } = ids();
    await handleUpdate(db, startUpdate(updateId, telegramId));
    await makeAdmin(telegramId);
    await put('bot', 'Bot_Status', 'botstatusoff');

    const started = await handleUpdate(db, startUpdate(updateId + 1, telegramId));

    expect(started.replies[0]?.text).not.toContain('فروشگاه موقتاً بسته است');
    expect(started.replies[0]?.keyboard).toBeDefined();
  });

  it('still consumes the update, so the poller does not hand it back for ever', async () => {
    const { updateId, telegramId } = ids();
    await handleUpdate(db, startUpdate(updateId, telegramId));
    await put('bot', 'Bot_Status', 'botstatusoff');

    const first = await handleUpdate(db, startUpdate(updateId + 1, telegramId));
    const again = await handleUpdate(db, startUpdate(updateId + 1, telegramId));

    expect(first.status).toBe('processed');
    expect(again.status).toBe('duplicate');
  });
});

/**
 * `setting.daywarn` and `setting.volumewarn` — when the two «running out»
 * messages fire.
 *
 * They were constants holding production's own values, with a comment saying
 * where they came from. Right on the day, and silently wrong the first time the
 * admin moves either number.
 */
describe('when the shop warns a customer', () => {
  it('takes both thresholds from the settings the admin edits', async () => {
    await put('bot', 'daywarn', '7');
    await put('bot', 'volumewarn', '5');
    const shop = await loadShopSettings(db);
    expect(shop.warnDays).toBe(7);
    expect(shop.warnVolumeGb).toBe(5);
  });

  it('keeps warning on the shipped numbers when a row is unusable', async () => {
    // Zero would mean the warning never fires and a negative row is broken.
    // Neither is an instruction to stop telling customers their service ends.
    for (const bad of ['0', '-3', 'خیلی', '1000']) {
      await put('bot', 'daywarn', bad);
      expect((await loadShopSettings(db)).warnDays, bad).toBe(DEFAULT_SHOP_SETTINGS.warnDays);
    }
  });

  it('warns at the day the admin chose, through a real sweep', async () => {
    // Six days out: silent on production's 2, warned on the admin's 7. Measured
    // against what the sweep actually sends, not against the setting.
    const telegramId = 855_930_001;
    const userId = await makeCustomer(telegramId);
    await db
      .prepare(
        `INSERT INTO subscriptions
           (public_id, user_id, provider_id, plan_name_at_sale, price_irr,
            remote_username, subscription_url, volume_gb, used_bytes,
            status, purchased_at, expires_at, notify)
         VALUES (?1, ?2, ?3, 'یک‌ماهه', 1950000, ?4, 'https://panel.test/s', 50, 0,
                 'ACTIVE', now(), now() + interval '6 days', '{}'::jsonb)
         ON CONFLICT (public_id) DO NOTHING`,
      )
      .bind(`warn${telegramId}`, userId, await providerId('sim-vip'), `w_${telegramId}`)
      .run();

    await put('bot', 'daywarn', '2');
    await warnExpiringServices(db);
    expect((await pendingNotifications()).some((n) => n.chatId === telegramId)).toBe(false);

    await put('bot', 'daywarn', '7');
    await warnExpiringServices(db);
    expect((await pendingNotifications()).some((n) => n.chatId === telegramId)).toBe(true);
  });
});

/**
 * «مبلغ دلخواه» — the deposit a customer names themselves.
 *
 * Six presets span a 125× range, which still leaves anybody who wants an
 * in-between amount choosing between overpaying and giving up. Mirzabot has
 * always let them type it, against this same floor and ceiling
 * (`index.php:4712`).
 *
 * What is asserted below is that the typed number is judged by the SHOP's
 * limits and not believed on sight — a deposit is the one place in this bot
 * where a number from the customer is legitimate, so it is also the one place
 * where the bounds have to be re-read rather than assumed.
 */
describe('a deposit the customer types', () => {
  function typed(updateId: number, telegramId: number, text: string) {
    return {
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: telegramId, username: `sw${telegramId}` },
        chat: { id: telegramId },
        text,
      },
    };
  }

  /** Reaches the prompt, with the shop's limits already in place. */
  async function asking(): Promise<{ updateId: number; telegramId: number }> {
    await ensurePaymentCard();
    await put('pay', 'minbalancecart', '80000');
    await put('pay', 'maxbalancecart', '10000000');
    const { updateId, telegramId } = ids();
    await handleUpdate(db, startUpdate(updateId, telegramId));
    const asked = await handleUpdate(db, press(updateId + 1, telegramId, 'tpx'));
    expect(asked.replies[0]?.text ?? '').toContain('80,000 تومان');
    return { updateId: updateId + 2, telegramId };
  }

  async function openOrder(telegramId: number) {
    return db
      .prepare(
        `SELECT o.total_irr, o.kind FROM orders o
           JOIN users u ON u.id = o.user_id
          WHERE u.telegram_id = ?1 ORDER BY o.id DESC LIMIT 1`,
      )
      .bind(telegramId)
      .first<{ total_irr: number; kind: string }>();
  }

  it('books exactly what was typed, converted once from Toman', async () => {
    const { updateId, telegramId } = await asking();

    const invoice = await handleUpdate(db, typed(updateId, telegramId, '750000'));

    // 750,000 Toman — an amount no preset offers, which is the whole point.
    expect(await openOrder(telegramId)).toMatchObject({
      total_irr: 7_500_000,
      kind: 'WALLET_TOPUP',
    });
    expect(invoice.replies[0]?.text ?? '').toContain('750,000 تومان');
  });

  it('reads the digits and separators a Persian keyboard actually produces', async () => {
    const { updateId, telegramId } = await asking();

    await handleUpdate(db, typed(updateId, telegramId, '۱٬۲۵۰٬۰۰۰'));

    expect(await openOrder(telegramId)).toMatchObject({ total_irr: 12_500_000 });
  });

  it('refuses an amount outside the shop’s own range and lets them type again', async () => {
    const { updateId, telegramId } = await asking();

    const tooSmall = await handleUpdate(db, typed(updateId, telegramId, '5000'));
    const tooBig = await handleUpdate(db, typed(updateId + 1, telegramId, '99000000'));

    expect(tooSmall.replies[0]?.text ?? '').toContain('خارج از بازهٔ مجاز');
    expect(tooBig.replies[0]?.text ?? '').toContain('خارج از بازهٔ مجاز');
    // No order, and the question is still open — the second attempt above only
    // works because the first did not close the step.
    expect(await openOrder(telegramId)).toBeNull();

    const ok = await handleUpdate(db, typed(updateId + 2, telegramId, '100000'));
    expect(ok.replies[0]?.text ?? '').toContain('100,000 تومان');
    expect(await openOrder(telegramId)).toMatchObject({ total_irr: 1_000_000 });
  });

  it('follows the ceiling the admin lowered, not the one it was asked with', async () => {
    // The limits are re-read when the answer arrives, not captured when the
    // question was asked. An admin who lowers the ceiling in between is obeyed.
    const { updateId, telegramId } = await asking();
    await put('pay', 'maxbalancecart', '200000');
    invalidateShopSettings();

    const refused = await handleUpdate(db, typed(updateId, telegramId, '750000'));

    expect(refused.replies[0]?.text ?? '').toContain('خارج از بازهٔ مجاز');
    expect(await openOrder(telegramId)).toBeNull();
  });

  it('says nothing usable to a message that is not a number', async () => {
    const { updateId, telegramId } = await asking();

    const nonsense = await handleUpdate(db, typed(updateId, telegramId, 'سلام'));

    expect(nonsense.replies[0]?.text ?? '').toContain('مبلغ دلخواه');
    expect(await openOrder(telegramId)).toBeNull();
  });
});
