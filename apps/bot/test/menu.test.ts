import { describe, expect, it } from 'vitest';
import { CUSTOMER, RESELLER } from './helpers/viewers.js';
import { CALLBACK_MAX_BYTES, decode } from '../src/callback.js';
import type { CatalogPlan } from '../src/catalog.js';
import * as menu from '../src/menu.js';
import { priceForUser } from '../src/money.js';
import type { InlineKeyboard } from '../src/telegram.js';

function buttons(keyboard: InlineKeyboard) {
  return keyboard.flat();
}

/**
 * The buttons that call back, which is every button except a copy one.
 *
 * A copy button carries no `callback_data` by design — it never reaches the
 * bot at all — so the assertions about callback data are about these.
 */
function callbacks(keyboard: InlineKeyboard): { text: string; callback_data: string }[] {
  return keyboard
    .flat()
    .flatMap((b) =>
      b.callback_data === undefined ? [] : [{ text: b.text, callback_data: b.callback_data }],
    );
}

const PLAN: CatalogPlan = {
  planId: 42,
  productId: 7,
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
    const rows = menu.mainMenu(CUSTOMER).map((row) => row.map((b) => b.text));
    expect(rows).toEqual([
      ['♻️ تمدید سرویس', '🔐 خرید اشتراک'],
      ['🏦 کیف پول + شارژ', '🛍 سرویس های من'],
      ['☎️ پشتیبانی', '📚 آموزش', '👥 زیر مجموعه گیری'],
      ['👨‍💻 درخواست نمایندگی'],
    ]);
  });

  it('does not offer a reseller the chance to apply for what they already are', () => {
    const texts = buttons(menu.mainMenu(RESELLER)).map((b) => b.text);
    expect(texts).not.toContain('👨‍💻 درخواست نمایندگی');
    expect(texts).toContain('🔐 خرید اشتراک');
  });

  it('has exactly one way into the shop', () => {
    const buy = buttons(menu.mainMenu(CUSTOMER)).filter((b) => b.callback_data === 'buy');
    expect(buy).toHaveLength(1);
  });
});

describe('every button we draw', () => {
  const keyboards: InlineKeyboard[] = [
    menu.mainMenu(CUSTOMER),
    menu.mainMenu(RESELLER),
    menu.panelMenu([
      { id: 1, name: 'یک', plans: 2 },
      { id: 999_999_999, name: 'دو', plans: 1 },
    ]),
    menu.planMenu([PLAN]),
    menu.planMenu([]),
    menu.planDetailMenu(PLAN),
    menu.checkoutMenu(4242, 1_950_000, '6037997512345678'),
    menu.afterPaidMenu(),
  ];

  it('carries callback data our own parser accepts', () => {
    for (const keyboard of keyboards) {
      for (const button of callbacks(keyboard)) {
        expect(decode(button.callback_data), button.callback_data).not.toBeNull();
      }
    }
  });

  it('does exactly one thing per button', () => {
    // Telegram's own rule: a label plus exactly one action field. A button with
    // both is refused, and a button with neither does nothing when pressed —
    // and either one takes the whole screen down with it, not just the button.
    for (const keyboard of keyboards) {
      for (const button of buttons(keyboard)) {
        const actions = [button.callback_data, button.copy_text].filter((a) => a !== undefined);
        expect(actions, button.text).toHaveLength(1);
      }
    }
  });

  it('fits inside Telegram’s 64-byte limit', () => {
    for (const keyboard of keyboards) {
      for (const button of callbacks(keyboard)) {
        const bytes = new TextEncoder().encode(button.callback_data).length;
        expect(bytes, button.callback_data).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
      }
    }
  });

  it('always leaves a way back', () => {
    for (const keyboard of keyboards.slice(2)) {
      const targets = callbacks(keyboard).map((b) => b.callback_data);
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
    expect(callbacks(menu.planMenu([])).every((b) => /^(buy|menu)$/.test(b.callback_data))).toBe(
      true,
    );
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

describe('the copy buttons on an invoice', () => {
  const CARD = '6037997512345678';
  const TOTAL = 1_950_000;

  /** What the two buttons put on the clipboard, in the order they are drawn. */
  const copied = (keyboard: InlineKeyboard): string[] =>
    keyboard.flat().flatMap((b) => (b.copy_text === undefined ? [] : [b.copy_text.text]));

  it('copies exactly the card and the amount the invoice names', () => {
    // Measured against the message the customer reads, not against the helper
    // that built the button. These are two independent renderings of the same
    // two numbers, and the whole point of the buttons is that they agree — a
    // customer who copies one number and is quoted another is worse off than
    // one who types.
    const text = menu.checkout('ORD-1', PLAN, TOTAL, CARD, 'سام');
    const [card, amount] = copied(menu.checkoutMenu(4242, TOTAL, CARD));

    // The invoice groups the card for reading; the clipboard carries the digits
    // a banking app accepts.
    expect(text).toContain('6037-9975-1234-5678');
    expect(card).toBe('6037997512345678');

    const quoted = /💳 مبلغ دقیق: ([\d,]+) تومان/.exec(text)?.[1];
    expect(quoted).toBe('195,000');
    expect(amount).toBe(quoted!.replace(/,/g, ''));
  });

  it('sits above the buttons an admin can rearrange', () => {
    const rows = menu.checkoutMenu(4242, TOTAL, CARD);
    expect(rows[0]?.every((b) => b.copy_text !== undefined)).toBe(true);
    expect(callbacks(rows).map((b) => b.callback_data)).toEqual(['paid:4242', 'menu']);
  });

  it('drops its own button rather than the invoice when a card is not a card', () => {
    // 256 characters is Telegram's cap and a message that breaks it is refused
    // whole — the customer would get no invoice at all. The number is still
    // written in the message above, which is where it was read from before
    // these buttons existed.
    const rows = menu.checkoutMenu(4242, TOTAL, '9'.repeat(257));
    expect(copied(rows)).toEqual(['195000']);
    expect(callbacks(rows).map((b) => b.callback_data)).toContain('paid:4242');
  });
});

describe('the card-to-card notes', () => {
  const CARD = '6037997512345678';

  /** The four invoices a customer can be shown, all built the real way. */
  const invoices = (): [string, string][] => [
    ['purchase', menu.checkout('ORD-1', PLAN, 1_950_000, CARD, 'سام')],
    ['add-on', menu.addonCheckout('ORD-2', 'ADD_VOLUME', 10, 'سرویس من', 300_000, CARD, 'سام')],
    ['renewal', menu.renewCheckout('ORD-3', 'سرویس من', PLAN, 1_950_000, CARD, 'سام')],
    ['top-up', menu.topupCheckout('ORD-4', 1_000_000, CARD, 'سام')],
  ];

  it('reaches every invoice, because all four are built from one tail', () => {
    // `PaySetting.helpcart` is live in production and shown before EVERY card
    // invoice there. A shop that prints the rules on one screen out of four has
    // customers reading them once and paying three more times without them.
    for (const [which, text] of invoices()) {
      expect(text, which).toContain('نکات مهم قبل از کارت به کارت');
      expect(text, which).toContain('فیلترشکن');
      expect(text, which).toContain('ساتنا');
      expect(text, which).toContain('۱۰ دقیقه');
    }
  });

  it('leaves room on the longest invoice for Telegram to accept it', () => {
    // The notes are ~350 characters added to a message that already carried an
    // order, a plan, a price, a card and a warning. Telegram refuses a message
    // over 4096 whole — the customer would get no invoice at all — and the
    // notes are the largest single thing ever appended to these four.
    for (const [which, text] of invoices()) {
      expect(text.length, which).toBeLessThan(4096);
    }
  });
});

describe('the usage bar', () => {
  const GIB = 1024 ** 3;
  /** The drawing alone, without the isolates that wrap it. */
  const cells = (bar: string) => bar.replace(/[\u2066\u2069]/g, '').split(' ')[0] ?? '';

  it('fills one cell per tenth of the quota', () => {
    expect(cells(menu.usageBar(5 * GIB, 10))).toBe('█████░░░░░');
    expect(menu.usageBar(5 * GIB, 10)).toContain('50%');
  });

  it('says what the database says', () => {
    // 62% of 20 GiB, to the byte, off the sim row this screen was walked with.
    // The division lands a hair under and a floor turned it into 61% — which
    // is what the browser showed on 2026-08-14 and no test here had caught.
    expect(menu.usageBar(13_314_398_617, 20)).toContain('62%');
  });

  it('shows an untouched quota as empty and a finished one as full', () => {
    expect(cells(menu.usageBar(0, 10))).toBe('░░░░░░░░░░');
    expect(cells(menu.usageBar(10 * GIB, 10))).toBe('██████████');
    expect(menu.usageBar(10 * GIB, 10)).toContain('100%');
  });

  it('never claims a quota is finished before it is', () => {
    // 99.7% — the case a rounded bar gets wrong, and the customer who is told
    // their service is dead while it still works comes to support.
    const bar = menu.usageBar(9.97 * GIB, 10);
    expect(bar).toContain('99%');
    expect(cells(bar)).not.toContain('██████████');
    expect(cells(bar)).toContain('░');
  });

  it('stops at full for a service that went over its quota', () => {
    // Panels report usage past the limit; the bar has nowhere to go.
    const bar = menu.usageBar(14 * GIB, 10);
    expect(bar).toContain('100%');
    expect(cells(bar)).toBe('██████████');
  });

  it('is isolated from the Persian around it', () => {
    // Block characters have no direction of their own. Without the isolates
    // they take the message's, and the bar fills from the opposite end.
    const bar = menu.usageBar(3 * GIB, 10);
    expect(bar.startsWith('\u2066')).toBe(true);
    expect(bar.endsWith('\u2069')).toBe(true);
  });

  it('is drawn on the service screen, and only where there is a quota', () => {
    const service: menu.ServiceView = {
      id: 1,
      status: 'ACTIVE',
      plan_name_at_sale: '۱ماهه - ۱۰ گیگ',
      volume_gb: 10,
      used_bytes: 5 * GIB,
      expires_at: null,
      public_id: 'shk-1',
      provider_name_at_sale: '🥇 سرویس VIP',
      remote_username: 'u_1',
      subscription_url: 'https://panel.test/sub/u_1',
    };
    expect(menu.serviceDetail(service, Date.now())).toContain('█████░░░░░ 50%');
    // Unmetered, and metered but never synced: nothing to draw, and no bar
    // drawn from a null.
    expect(menu.serviceDetail({ ...service, volume_gb: null }, Date.now())).not.toContain('░');
    expect(menu.serviceDetail({ ...service, used_bytes: null }, Date.now())).not.toContain('░');
    // A migrated row with a zero quota would divide by zero.
    expect(menu.serviceDetail({ ...service, volume_gb: 0 }, Date.now())).not.toContain('NaN');
  });
});
