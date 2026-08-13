import { describe, expect, it } from 'vitest';
import { CALLBACK_MAX_BYTES, decode } from '../src/callback.js';
import type { CatalogPlan } from '../src/catalog.js';
import * as menu from '../src/menu.js';
import { priceForUser } from '../src/money.js';
import type { InlineKeyboard } from '../src/telegram.js';

function buttons(keyboard: InlineKeyboard) {
  return keyboard.flat();
}

const PLAN: CatalogPlan = {
  planId: 42,
  productName: '۱ماهه - ۵۰ گیگ',
  planName: '۱ماهه - ۵۰ گیگ',
  priceIrr: 1_950_000,
  durationDays: 30,
  volumeGb: 50,
  userLimit: 3,
  providerId: 7,
  providerName: '🥇 سرویس VIP',
};

describe('the main menu', () => {
  it('is the production layout', () => {
    // setting.keyboardmain on the 2026-08-11 dump, in order. Customers have this
    // muscle memory and the replacement must not move their buttons.
    const rows = menu.mainMenu(false).map((row) => row.map((b) => b.text));
    expect(rows).toEqual([
      ['♻️ تمدید سرویس', '🔐 خرید اشتراک'],
      ['🏦 کیف پول + شارژ', '🛍 سرویس های من'],
      ['☎️ پشتیبانی', '📚 آموزش', '👥 زیر مجموعه گیری'],
      ['👨‍💻 درخواست نمایندگی'],
    ]);
  });

  it('does not offer a reseller the chance to apply for what they already are', () => {
    const texts = buttons(menu.mainMenu(true)).map((b) => b.text);
    expect(texts).not.toContain('👨‍💻 درخواست نمایندگی');
    expect(texts).toContain('🔐 خرید اشتراک');
  });

  it('has exactly one way into the shop', () => {
    const buy = buttons(menu.mainMenu(false)).filter((b) => b.callback_data === 'buy');
    expect(buy).toHaveLength(1);
  });
});

describe('every button we draw', () => {
  const keyboards: InlineKeyboard[] = [
    menu.mainMenu(false),
    menu.mainMenu(true),
    menu.panelMenu([
      { id: 1, name: 'یک', plans: 2 },
      { id: 999_999_999, name: 'دو', plans: 1 },
    ]),
    menu.planMenu([PLAN]),
    menu.planMenu([]),
    menu.planDetailMenu(PLAN),
    menu.checkoutMenu(4242),
    menu.afterPaidMenu(),
  ];

  it('carries callback data our own parser accepts', () => {
    for (const keyboard of keyboards) {
      for (const button of buttons(keyboard)) {
        expect(decode(button.callback_data), button.callback_data).not.toBeNull();
      }
    }
  });

  it('fits inside Telegram’s 64-byte limit', () => {
    for (const keyboard of keyboards) {
      for (const button of buttons(keyboard)) {
        const bytes = new TextEncoder().encode(button.callback_data).length;
        expect(bytes, button.callback_data).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
      }
    }
  });

  it('always leaves a way back', () => {
    for (const keyboard of keyboards.slice(2)) {
      const targets = buttons(keyboard).map((b) => b.callback_data);
      expect(targets.some((t) => t === 'menu' || t === 'buy' || t.startsWith('panel:'))).toBe(true);
    }
  });
});

describe('the plan list', () => {
  it('adds the price when the name does not carry one', () => {
    const [row] = menu.planMenu([PLAN]);
    expect(row?.[0]?.text).toBe('۱ماهه - ۵۰ گیگ — 195,000 تومان');
    expect(row?.[0]?.callback_data).toBe('plan:42');
  });

  it('does not repeat a price the migrated name already spells out', () => {
    // What the live bot showed on 2026-08-12: '...-195.000ت 🚀 — 195,000 تومان'.
    const migrated = { ...PLAN, productName: '1️⃣ 1ماهه-50گیگ-چند کاربر-195.000ت🚀' };
    const [row] = menu.planMenu([migrated]);
    expect(row?.[0]?.text).toBe('1️⃣ 1ماهه-50گیگ-چند کاربر-195.000ت🚀');
  });

  it('always quotes a discounted customer their own price', () => {
    // The name says 195.000, which is not what this customer pays. Production
    // shows the name alone here and quotes a price the customer will not be
    // charged.
    const migrated = { ...PLAN, productName: '1️⃣ 1ماهه-50گیگ-چند کاربر-195.000ت🚀' };
    const [row] = menu.planMenu([migrated], 15);
    expect(row?.[0]?.text).toContain('165,750 تومان');
  });

  it('is just a way back when there is nothing to list', () => {
    expect(
      menu
        .planMenu([])
        .flat()
        .every((b) => /^(buy|menu)$/.test(b.callback_data)),
    ).toBe(true);
  });
});

describe('the plan detail', () => {
  it('shows what was bought and what it costs', () => {
    const text = menu.planDetail(PLAN, priceForUser(PLAN.priceIrr, 0));
    expect(text).toContain('۱ماهه - ۵۰ گیگ');
    expect(text).toContain('🥇 سرویس VIP');
    expect(text).toContain('50 گیگابایت');
    expect(text).toContain('30 روز');
    expect(text).toContain('195,000 تومان');
    // No discount, so no line about one.
    expect(text).not.toContain('تخفیف');
  });

  it('names the unmetered and untimed cases instead of printing null', () => {
    const text = menu.planDetail(
      { ...PLAN, volumeGb: null, durationDays: null, userLimit: null },
      priceForUser(PLAN.priceIrr, 0),
    );
    expect(text).toContain('نامحدود');
    expect(text).toContain('بدون محدودیت زمان');
    expect(text).not.toContain('null');
    expect(text).not.toContain('کاربر همزمان');
  });

  it('shows a discounted customer both prices', () => {
    const text = menu.planDetail(PLAN, priceForUser(PLAN.priceIrr, 15));
    expect(text).toContain('195,000 تومان'); // list
    expect(text).toContain('29,250 تومان'); // discount
    expect(text).toContain('165,750 تومان'); // payable
  });

  it('offers the order button and a way back to the panel it came from', () => {
    const targets = buttons(menu.planDetailMenu(PLAN)).map((b) => b.callback_data);
    expect(targets).toContain('order:42');
    expect(targets).toContain('panel:7');
  });
});
