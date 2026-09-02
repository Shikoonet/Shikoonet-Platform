import { describe, expect, it } from 'vitest';
import { CUSTOMER, RESELLER } from './helpers/viewers.js';
import { CALLBACK_MAX_BYTES, decode } from '../src/callback.js';
import type { CatalogPlan, CatalogProduct } from '../src/catalog.js';
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
  badge: null,
  buttonStyle: null,
  priceIrr: 1_950_000,
  durationDays: 30,
  volumeGb: 50,
  userLimit: 3,
  providerId: 7,
  providerName: '🥇 سرویس VIP',
  categoryId: 1,
  rowIndex: null,
  siblings: 1,
  tiers: 1,
};

describe('the main menu', () => {
  it('is the production layout', () => {
    // setting.keyboardmain on the 2026-08-11 dump, in order. Customers have this
    // muscle memory and the replacement must not move their buttons.
    //
    // The trial is APPENDED, and that is the whole reason it is last rather
    // than beside «خرید اشتراک» where it belongs: a fifth row at the end moves
    // nothing, and any other position moves «کیف پول» or «پشتیبانی» for every
    // customer. The first four rows below are still the dump's, unchanged.
    const rows = menu.mainMenu(CUSTOMER).map((row) => row.map((b) => b.text));
    expect(rows).toEqual([
      ['♻️ تمدید سرویس', '🔐 خرید اشتراک'],
      ['🏦 کیف پول + شارژ', '🛍 سرویس های من'],
      ['☎️ پشتیبانی', '📚 آموزش', '👥 زیر مجموعه گیری'],
      ['👨‍💻 درخواست نمایندگی'],
      ['🎁 سرویس تست رایگان'],
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
    menu.productMenu([
      { productId: 1, name: 'یک', providerName: 'پ', badge: null, buttonStyle: null, rowIndex: null },
      { productId: 999_999_999, name: 'دو', providerName: 'پ', badge: '🆕', buttonStyle: 'primary', rowIndex: null },
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
      expect(targets.some((t) => t === 'menu' || t === 'buy' || t.startsWith('prd:'))).toBe(true);
    }
  });
});

const SERVICE: CatalogProduct = {
  productId: 7,
  name: 'پلاتینیوم',
  rowIndex: null,
  providerName: '🥇 سرویس VIP',
  // Null on both, because this service holds three configs — see the rule in
  // `CatalogProduct.badge`. The badged case is asserted against Postgres in
  // catalog.test.ts, where the «one config» decision is actually made.
  badge: null,
  buttonStyle: null,
};

describe('the service list', () => {
  it('is names, and nothing else', () => {
    // A level does not have a price. A service holding three sizes has three
    // of them, and quoting the cheapest with «از» — which this drew at first —
    // puts a number on the button the customer cannot find on the next screen.
    // A one-plan service does have a single price, but quoting it on some rows
    // and not others makes two rows that mean different things look the same.
    const [row] = menu.productMenu([SERVICE]);
    expect(row?.[0]?.text).toBe('پلاتینیوم');
    expect(row?.[0]?.callback_data).toBe('prd:7');
  });

  it('puts no price on any row, whatever the sizes behind it cost', () => {
    const rows = menu.productMenu([
      SERVICE,
      { ...SERVICE, productId: 8, name: 'طلایی' },
      { ...SERVICE, productId: 9, name: 'معمولی' },
    ]);
    for (const label of rows.flat().map((b) => b.text)) {
      expect(label).not.toMatch(/\d/);
      expect(label).not.toContain('تومان');
      expect(label).not.toContain('از ');
    }
  });

  it('leaves a migrated name alone, price and all', () => {
    // The importer typed the price into the name because the legacy schema had
    // nowhere else for it. That is the shop's own text, not ours to edit.
    const migrated = { ...SERVICE, name: '1️⃣ 1ماهه-50گیگ-چند کاربر-195.000ت🚀' };
    const [row] = menu.productMenu([migrated]);
    expect(row?.[0]?.text).toBe('1️⃣ 1ماهه-50گیگ-چند کاربر-195.000ت🚀');
  });

  it('names the panel only on a service whose name is not unique', () => {
    // One panel is the shop today, and «(پنل تست)» on every row is noise on
    // every row. A SECOND panel selling its own «پلاتینیوم» is the case that
    // needs it — otherwise the screen built to stop one word appearing twice
    // draws one word twice.
    const rows = menu.productMenu([
      { ...SERVICE, productId: 1, name: 'پلاتینیوم', providerName: 'آلمان' },
      { ...SERVICE, productId: 2, name: 'پلاتینیوم', providerName: 'فرانسه' },
      { ...SERVICE, productId: 3, name: 'طلایی', providerName: 'آلمان' },
    ]);
    const labels = rows.flat().map((b) => b.text);
    expect(labels[0]).toContain('پلاتینیوم (آلمان)');
    expect(labels[1]).toContain('پلاتینیوم (فرانسه)');
    expect(labels[2]).not.toContain('آلمان');
  });

  it('is just a way back when there is nothing to list', () => {
    expect(callbacks(menu.productMenu([])).every((b) => /^(buy|menu)$/.test(b.callback_data))).toBe(
      true,
    );
  });
});

describe('the plan list', () => {
  it('names the PLAN, because every row on it is the same product', () => {
    // The bug this replaced: labelling by product drew «پلاتینیوم» on all three
    // rows of a three-size service, and where a migrated name already quotes a
    // price the two cheapest came out as literally the same button.
    const rows = menu.planMenu([
      { ...PLAN, planId: 1, planName: '۳۰ گیگ - یک‌ماهه', priceIrr: 1_500_000, siblings: 3 },
      { ...PLAN, planId: 2, planName: '۵۰ گیگ - یک‌ماهه', priceIrr: 2_200_000, siblings: 3 },
    ]);
    expect(rows[0]?.[0]?.text).toBe('۳۰ گیگ - یک‌ماهه — 150,000 تومان');
    expect(rows[1]?.[0]?.text).toBe('۵۰ گیگ - یک‌ماهه — 220,000 تومان');
    expect(rows[0]?.[0]?.callback_data).toBe('plan:1');
  });

  it('draws the admin badge in FRONT of the label, price still last', () => {
    // The whole of «نیو»/«آف» on a shop screen, through the real builder. In
    // front, because a plan's label ends in the price and a badge on the tail
    // would land after the number.
    const rows = menu.planMenu([{ ...PLAN, badge: '🔴 آف', planName: '۵۰ گیگ' }]);
    expect(rows[0]?.[0]?.text).toBe('🔴 آف ۵۰ گیگ — 195,000 تومان');
    // A category badge is the same field on the same side.
    const cats = menu.categoryMenu([
      { categoryId: 1, name: 'اروپا', badge: '🆕', buttonStyle: null, rowIndex: null },
      { categoryId: 2, name: 'آسیا', badge: null, buttonStyle: null, rowIndex: null },
    ]);
    expect(cats[0]?.[0]?.text).toBe('🆕 اروپا');
    expect(cats[1]?.[0]?.text).toBe('آسیا');
  });

  it('paints the whole button, and leaves `style` off when there is no colour', () => {
    // Bot API 9.4's `style`. The KEY has to be absent and not null on a button
    // with no colour: `null` is a value Telegram refuses, and «omitted» is what
    // «the client's own default» is spelled as.
    const cats = menu.categoryMenu([
      { categoryId: 1, name: 'اروپا', badge: '🆕', buttonStyle: 'primary', rowIndex: null },
      { categoryId: 2, name: 'آسیا', badge: null, buttonStyle: null, rowIndex: null },
    ]);
    expect(cats[0]?.[0]?.style).toBe('primary');
    expect(cats[1]?.[0]).not.toHaveProperty('style');
    // A plan's button is the same field, and the colour does not touch the label.
    const plans = menu.planMenu([{ ...PLAN, buttonStyle: 'danger', planName: '۵۰ گیگ' }]);
    expect(plans[0]?.[0]?.style).toBe('danger');
    expect(plans[0]?.[0]?.text).toBe('۵۰ گیگ — 195,000 تومان');
  });

  it('draws the shop own label when one is configured, from the plan fields', () => {
    // The two layouts asked for: «1 ماهه | 50 گیگ | 195,000 تومان» and the
    // two-part version. Built from `durationDays`/`volumeGb`, not from the
    // typed name, which is the point — the fields cannot drift from what the
    // customer is actually buying.
    const three = menu.planMenu([PLAN], 0, '{duration} | {volume} | {price}');
    expect(three[0]?.[0]?.text).toBe('1 ماهه | 50 گیگ | 195,000 تومان');

    const two = menu.planMenu([PLAN], 0, '{duration} | {volume} {price}');
    expect(two[0]?.[0]?.text).toBe('1 ماهه | 50 گیگ 195,000 تومان');
  });

  it('leaves every screen alone when no label is configured', () => {
    // The default is null and not a template, because every migrated product
    // has its price typed into its name. This is the assertion that says so.
    const configured = menu.planMenu([PLAN], 0, null);
    const omitted = menu.planMenu([PLAN], 0);
    expect(configured[0]?.[0]?.text).toBe(omitted[0]?.[0]?.text);
    expect(omitted[0]?.[0]?.text).toBe('۱ماهه - ۵۰ گیگ — 195,000 تومان');
  });

  it('prices the shop own label for the customer looking at it', () => {
    // The discount is the one thing on this button that belongs to the viewer
    // rather than to the plan, and it has to survive the template path.
    const rows = menu.planMenu([PLAN], 20, '{duration} | {price}');
    expect(rows[0]?.[0]?.text).toBe('1 ماهه | 156,000 تومان');
  });

  it('says «نامحدود» for an unmetered plan instead of leaving a gap', () => {
    const rows = menu.planMenu(
      [{ ...PLAN, volumeGb: null }],
      0,
      '{duration} | {volume} | {price}',
    );
    expect(rows[0]?.[0]?.text).toBe('1 ماهه | نامحدود | 195,000 تومان');
  });

  it('collapses the separator of a slot the plan has nothing for', () => {
    // One user is the ordinary case and draws nothing, so «{users} |» must not
    // leave a pipe hanging at the front of every single-user plan.
    const rows = menu.planMenu([{ ...PLAN, userLimit: 1 }], 0, '{users} | {duration} | {price}');
    expect(rows[0]?.[0]?.text).toBe('1 ماهه | 195,000 تومان');
  });

  it('still colours the button when the label is a template', () => {
    const rows = menu.planMenu(
      [{ ...PLAN, buttonStyle: 'success' }],
      0,
      '{duration} | {price}',
    );
    expect(rows[0]?.[0]?.style).toBe('success');
  });

  it('goes back to the service list, which is the shop first screen', () => {
    const targets = callbacks(menu.planMenu([PLAN])).map((b) => b.callback_data);
    expect(targets).toContain('buy');
  });

  it('is just a way back when there is nothing to list', () => {
    expect(
      callbacks(menu.planMenu([])).every((b) => /^(buy|menu)$/.test(b.callback_data)),
    ).toBe(true);
  });

  it('leaves «بازگشت به منو» pointing at the menu', () => {
    // `buildMenu` asks the target callback about EVERY button it draws, so a
    // callback that answers for actions it does not care about rewrites them
    // too. Mine did: it sent `menu` to the panel list, and the emptiness test
    // above could not see it because both answers matched the same pattern.
    const targets = callbacks(menu.planMenu([PLAN])).map((b) => b.callback_data);
    expect(targets).toContain('menu');
  });
});

describe('«بازگشت» on a plan page', () => {
  it('returns to this service’s price list when it drew one', () => {
    // The screen behind a plan page is the SERVICE's prices — «۳۰ گیگ», «۵۰
    // گیگ» — since the service level was connected on 2026-08-27. Sending them
    // to the category would skip the screen they were actually on.
    const targets = callbacks(menu.planDetailMenu({ ...PLAN, siblings: 3, tiers: 2 })).map(
      (b) => b.callback_data,
    );
    expect(targets).toContain('prd:7');
    expect(targets).not.toContain('cat:1');
    expect(targets).not.toContain('panel:7');
  });

  it('returns to the tier list when the service held a single price', () => {
    // A service holding one plan opens that plan directly, so its price list
    // was never drawn — but the category's tier list was, and that is where
    // they came from.
    const targets = callbacks(menu.planDetailMenu({ ...PLAN, siblings: 1, tiers: 3 })).map(
      (b) => b.callback_data,
    );
    expect(targets).toContain('cat:1');
    expect(targets).not.toContain('prd:7');
  });

  it('returns to the shop’s first screen when neither list was drawn', () => {
    // One service, one price: `buy` opened the plan itself. Sending them to a
    // list of one is a screen whose only button leads back where they just were
    // — which is the whole reason this is three cases and not one.
    const targets = callbacks(menu.planDetailMenu({ ...PLAN, siblings: 1, tiers: 1 })).map(
      (b) => b.callback_data,
    );
    expect(targets).toContain('buy');
    expect(targets).not.toContain('cat:1');
    expect(targets).not.toContain('prd:7');
  });
});

describe('what a purchase is called', () => {
  it('names the service and the size when they differ', () => {
    expect(menu.soldAs('پلاتینیوم', '۵۰ گیگ - یک‌ماهه')).toBe('پلاتینیوم — ۵۰ گیگ - یک‌ماهه');
  });

  it('says a legacy name once, not twice', () => {
    // The importer wrote the same string into the product and its single plan,
    // so every migrated row would otherwise read «X — X» on its own invoice.
    const legacy = '1️⃣ 1ماهه-50گیگ-چند کاربر-195.000ت🚀';
    expect(menu.soldAs(legacy, legacy)).toBe(legacy);
  });

  it('reaches the invoice and the plan page, not just the helper', () => {
    // Where it actually matters. Three services on one panel each holding a
    // «۳۰ گیگ - یک‌ماهه» is the shape an operator gets the moment they build
    // پلاتینیوم/طلایی/معمولی — and an invoice naming only one half of that
    // cannot say which level was bought.
    const tiered = { ...PLAN, productName: 'پلاتینیوم', planName: '۳۰ گیگ - یک‌ماهه' };
    const price = priceForUser(tiered.priceIrr, 0);
    expect(menu.planDetail(tiered, price)).toContain('پلاتینیوم — ۳۰ گیگ - یک‌ماهه');
    expect(menu.checkout('ord1', tiered, tiered.priceIrr, '6037997512345678', null)).toContain(
      'پلاتینیوم — ۳۰ گیگ - یک‌ماهه',
    );
  });
});

describe('the renewal plan list', () => {
  it('names the tier, because it offers the whole panel flat', async () => {
    // A renewal is not choosing a level — it extends an account that exists,
    // and the plan it was sold under is gone for roughly half the migrated
    // services — so it is offered everything the panel sells, in one list. That
    // makes it the one screen where three plans of «پلاتینیوم» sit next to each
    // other, and labelling by product alone drew the same word three times.
    const rows = menu.renewPlanMenu(9, [
      { ...PLAN, planId: 1, productName: 'پلاتینیوم', planName: '۳۰ گیگ', priceIrr: 1_500_000 },
      { ...PLAN, planId: 2, productName: 'پلاتینیوم', planName: '۵۰ گیگ', priceIrr: 2_200_000 },
    ]);
    const labels = rows.flat().map((b) => b.text);
    expect(labels[0]).toBe('پلاتینیوم — ۳۰ گیگ — 150,000 تومان');
    expect(labels[1]).toBe('پلاتینیوم — ۵۰ گیگ — 220,000 تومان');
  });

  it('still says a migrated name once', () => {
    const legacy = '1️⃣ 1ماهه-50گیگ-چند کاربر-195.000ت🚀';
    const [row] = menu.renewPlanMenu(9, [{ ...PLAN, productName: legacy, planName: legacy }]);
    expect(row?.[0]?.text).toBe(legacy);
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

  it('offers the order button and a way back to where it came from', () => {
    const targets = buttons(menu.planDetailMenu(PLAN)).map((b) => b.callback_data);
    expect(targets).toContain('order:42');
    expect(targets).toContain('buy');
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
      // Note 4 used to promise «حداکثر تا ۱۰ دقیقه تایید می‌شود», and that
      // promise was not the shop's to make: ten minutes is the auto-match
      // window, and a claim that does not match an isolated bank SMS waits for
      // an operator for as long as the operator takes. It now says the one
      // thing about note 4 that is always true — where the receipt goes.
      expect(text, which).toContain('در پیام خصوصی به ادمین');
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
