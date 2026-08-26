/**
 * A keyboard for every screen, judged by what the customer is sent.
 *
 * The assertions that matter run a real update through `handleUpdate` and read
 * the reply, because everything between — the loader, the per-menu grouping,
 * `buildMenu` — is exactly the machinery that could keep serving the shipped
 * layout while the panel says it saved. A test that read `bot_keyboard_buttons`
 * back would pass with the whole wiring removed.
 *
 * The other half is what makes editing everything safe. A shop can now take
 * «✅ پرداخت کردم» off the invoice, and the customer would be left holding a
 * card number with no way to say they used it — nothing on the screen would
 * look broken. That is what `required` refuses, and it is checked here against
 * the rule rather than against itself.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertSchema, db } from './helpers/env.js';
import { ensureCatalog, planId, providerId } from './helpers/shop.js';
import { handleUpdate } from '../src/handle.js';
import { invalidateBotContent, loadBotContent } from '../src/botContent.js';
import {
  buildMenu,
  checkLayout,
  DEFAULT_LAYOUTS,
  MENU_IDS,
  MENUS,
  type ButtonPlacement,
  type MenuAction,
  type MenuId,
} from '../src/keyboard.js';
import * as menu from '../src/menu.js';

let nextId = 0;
function ids(): { updateId: number; telegramId: number } {
  const n = ++nextId * 10;
  return { updateId: 974_000 + n, telegramId: 844_000 + n };
}

function press(updateId: number, telegramId: number, data: string) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `kb${telegramId}` },
      message: { message_id: 6161, chat: { id: telegramId } },
      data,
    },
  };
}

function startUpdate(updateId: number, telegramId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: telegramId, username: `kb${telegramId}` },
      chat: { id: telegramId },
      text: '/start',
    },
  };
}

async function save(menuId: MenuId, buttons: readonly ButtonPlacement[]): Promise<void> {
  for (const b of buttons) {
    await db
      .prepare(
        `INSERT INTO bot_keyboard_buttons (menu, action, label, row_index, col_index, visible)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(menuId, b.action, b.label, b.rowIndex, b.colIndex, b.visible)
      .run();
  }
  invalidateBotContent();
}

async function clear(): Promise<void> {
  await db.prepare(`DELETE FROM bot_keyboard_buttons`).run();
  await db.prepare(`DELETE FROM bot_texts`).run();
  invalidateBotContent();
  menu.resetContent();
}

/** Loads what is saved into the module bindings, as an update would. */
async function applySaved(): Promise<void> {
  invalidateBotContent();
  menu.applyContent(await loadBotContent(db));
}

const labels = (rows: { text: string }[][] | undefined) =>
  (rows ?? []).map((r) => r.map((b) => b.text));
// A copy button carries no `callback_data` and never reaches the bot, so it is
// not one of the targets these assertions are about.
const datas = (rows: { callback_data?: string }[][] | undefined) =>
  (rows ?? []).flat().flatMap((b) => (b.callback_data === undefined ? [] : [b.callback_data]));
/** Any card; these tests are about the chrome under the copy row, not the card. */
const CARD = '6037997512345678';

beforeAll(async () => {
  await assertSchema();
  await ensureCatalog();
});

beforeEach(clear);
afterEach(clear);

describe('a screen other than the main menu', () => {
  it('is drawn from the saved layout, not from the code', async () => {
    // The shop's first screen and its back button, renamed and hidden nowhere
    // else. Before this slice the only editable keyboard in the whole bot was
    // the main menu.
    //
    // `categories`, not `products`: `buy` opens the category list since
    // 2026-08-26. Saving against `products` here left the third test in this
    // block green for the wrong reason — it asserted only that SOME button
    // fires `menu`, which the untouched default layout also does.
    await save('categories', [
      { action: 'menu', label: '🏠 برگرد خانه', rowIndex: 0, colIndex: 0, visible: true },
    ]);

    const { updateId, telegramId } = ids();
    await handleUpdate(db, startUpdate(updateId, telegramId));
    const shop = await handleUpdate(db, press(updateId + 1, telegramId, 'buy'));

    expect(labels(shop.replies[0]?.keyboard).flat()).toContain('🏠 برگرد خانه');
    expect(labels(shop.replies[0]?.keyboard).flat()).not.toContain('بازگشت به منو ⬅️');
  });

  it('leaves every other screen on the shipped layout', async () => {
    // Per menu, not all or nothing: a shop that renames one button still
    // receives later releases' improvements everywhere else.
    await save('categories', [
      { action: 'menu', label: '🏠 برگرد خانه', rowIndex: 0, colIndex: 0, visible: true },
    ]);
    await applySaved();

    expect(labels(menu.walletMenu()).flat()).toEqual([
      '💰 افزایش موجودی',
      '🎁 کد هدیه',
      'بازگشت به منو ⬅️',
    ]);
  });

  it('keeps the callback working after a rename', async () => {
    await save('categories', [
      { action: 'menu', label: 'هرچیزی', rowIndex: 0, colIndex: 0, visible: true },
    ]);
    const { updateId, telegramId } = ids();
    await handleUpdate(db, startUpdate(updateId, telegramId));
    const shop = await handleUpdate(db, press(updateId + 1, telegramId, 'buy'));
    expect(labels(shop.replies[0]?.keyboard).flat()).toContain('هرچیزی');
    expect(datas(shop.replies[0]?.keyboard)).toContain('menu');
  });

  it('draws the data rows above the chrome, whatever the layout says', async () => {
    const { updateId, telegramId } = ids();
    await handleUpdate(db, startUpdate(updateId, telegramId));
    const shop = await handleUpdate(db, press(updateId + 1, telegramId, 'buy'));

    const rows = shop.replies[0]?.keyboard ?? [];
    const chromeAt = rows.findIndex((r) => r.some((b) => b.callback_data === 'menu'));
    const dataAt = rows.findIndex((r) => r.some((b) => b.callback_data?.startsWith('cat:')));
    expect(dataAt).toBeGreaterThanOrEqual(0);
    expect(dataAt).toBeLessThan(chromeAt);
  });
});

describe('a button whose precondition is not met', () => {
  it('is dropped and its place closed up', () => {
    // The wallet row on an invoice: with no balance there is nothing to offer,
    // and «پرداخت از کیف پول» pointing at an empty wallet is worse than no
    // button. Its whole row goes rather than leaving a gap.
    const withBalance = menu.checkoutMenu(7, 1_950_000, CARD, {
      balanceIrr: 2_000_000,
      totalIrr: 1_950_000,
    });
    const without = menu.checkoutMenu(7, 1_950_000, CARD);

    expect(datas(withBalance)).toContain('wpay:7');
    expect(datas(without)).not.toContain('wpay:7');
    expect(datas(without)).not.toContain('tpo:7');
    // The two that always apply are still there, and no empty row survived.
    expect(datas(without)).toEqual(['paid:7', 'menu']);
    expect(without.every((r) => r.length > 0)).toBe(true);
  });

  it('offers a top-up instead when the balance is there but not enough', () => {
    const short = menu.checkoutMenu(9, 1_950_000, CARD, {
      balanceIrr: 500_000,
      totalIrr: 1_950_000,
    });
    expect(datas(short)).toContain('tpo:9');
    expect(datas(short)).not.toContain('wpay:9');
  });

  it('fills the slot in its label from the live values', () => {
    const rows = menu.checkoutMenu(11, 1_950_000, CARD, {
      balanceIrr: 2_000_000,
      totalIrr: 1_950_000,
    });
    expect(labels(rows).flat()).toContain('💰 پرداخت از کیف پول (200,000 تومان)');
  });

  it('never leaves a raw slot on a button', () => {
    for (const rows of [
      menu.checkoutMenu(1, 1_950_000, CARD),
      menu.checkoutMenu(1, 5, CARD, { balanceIrr: 10, totalIrr: 5 }),
      menu.serviceDetailMenu(null),
      menu.walletMenu(),
    ]) {
      for (const label of labels(rows).flat()) {
        expect(label, label).not.toMatch(/\{[a-zA-Z]/);
      }
    }
  });

  it('gives a manual service no panel buttons at all', () => {
    // Nothing to call for a service no panel owns, and a button that cannot
    // work is how a customer arrives at support saying they pressed it.
    expect(datas(menu.serviceDetailMenu(null))).toEqual(['mine', 'menu']);
  });

  it('shows one of the on/off pair, never both', () => {
    const on = menu.serviceDetailMenu({
      id: 4,
      disabled: false,
      volumeIrrPerGb: null,
      timeIrrPerDay: null,
    });
    const off = menu.serviceDetailMenu({
      id: 4,
      disabled: true,
      volumeIrrPerGb: null,
      timeIrrPerDay: null,
    });
    expect(datas(on)).toContain('off:4');
    expect(datas(on)).not.toContain('on:4');
    expect(datas(off)).toContain('on:4');
    expect(datas(off)).not.toContain('off:4');
  });
});

describe('the buttons a shop may not remove', () => {
  it('refuses a layout that has dropped one', () => {
    // «✅ پرداخت کردم» is the customer's only way to say they transferred the
    // money. Without it the invoice is a dead end that looks complete.
    const withoutPaid = DEFAULT_LAYOUTS.checkout.filter((b) => b.action !== 'paid');
    expect(checkLayout('checkout', [...withoutPaid])).toEqual({
      kind: 'REQUIRED_MISSING',
      actions: ['paid'],
    });
  });

  it('refuses one that has merely hidden it', () => {
    const hidden = DEFAULT_LAYOUTS.checkout.map((b) =>
      b.action === 'paid' ? { ...b, visible: false } : b,
    );
    expect(checkLayout('checkout', hidden)).toEqual({
      kind: 'REQUIRED_HIDDEN',
      actions: ['paid'],
    });
  });

  it('still allows renaming and moving it', () => {
    const moved = DEFAULT_LAYOUTS.checkout.map((b) =>
      b.action === 'paid' ? { ...b, label: 'واریز کردم ✅', rowIndex: 19 } : b,
    );
    expect(checkLayout('checkout', moved)).toBeNull();
  });

  it('refuses a label that drops a slot it must carry', () => {
    const noSlot = DEFAULT_LAYOUTS.checkout.map((b) =>
      b.action === 'wpay' ? { ...b, label: '💰 پرداخت از کیف پول' } : b,
    );
    expect(checkLayout('checkout', noSlot)).toEqual({
      kind: 'LABEL_MISSING_PLACEHOLDER',
      action: 'wpay',
      names: ['balance'],
    });
  });

  it('refuses custom emoji markup on a label, switch on or off', () => {
    // The text path checks this and the keyboard path did not, so an admin
    // could save `<tg-emoji …>🔥</tg-emoji> خرید` and get a 200 — then every
    // customer saw the raw tag on the button, which `botTexts.ts` itself calls
    // the worst outcome there is.
    //
    // Stricter than the rule for texts on purpose, and this is the part the
    // audit did not have: an inline button's `text` is plain, always. Telegram
    // parses no entities there at all, so there is no `parse_mode` to set and
    // no shop switch that could make this work. It is refused even with custom
    // emoji fully on, because on a button it can only ever be characters.
    const marked = DEFAULT_LAYOUTS.main.map((b) =>
      b.action === 'buy'
        ? { ...b, label: '<tg-emoji emoji-id="5368324170671202286">🔥</tg-emoji> خرید' }
        : b,
    );
    expect(checkLayout('main', marked)).toEqual({ kind: 'LABEL_MARKUP', actions: ['buy'] });

    // A typo'd tag is refused for the same reason, and named the same way.
    const broken = DEFAULT_LAYOUTS.main.map((b) =>
      b.action === 'buy' ? { ...b, label: '<tg-emoji emoji-id="5"> خرید' } : b,
    );
    expect(checkLayout('main', broken)).toEqual({ kind: 'LABEL_MARKUP', actions: ['buy'] });

    // And an ordinary emoji is still an ordinary emoji.
    const plain = DEFAULT_LAYOUTS.main.map((b) =>
      b.action === 'buy' ? { ...b, label: '🔥 خرید' } : b,
    );
    expect(checkLayout('main', plain)).toBeNull();
  });

  it('refuses a slot the button is never given a value for', () => {
    const invented = DEFAULT_LAYOUTS.checkout.map((b) =>
      b.action === 'paid' ? { ...b, label: '✅ پرداخت کردم {total}' } : b,
    );
    expect(checkLayout('checkout', invented)).toEqual({
      kind: 'LABEL_UNKNOWN_PLACEHOLDER',
      action: 'paid',
      names: ['total'],
    });
  });

  it('marks a required button on every screen that has a dead end without one', () => {
    // Outside truth for the flags: a screen whose only way onward is one button
    // must say so. Checked by walking the registry rather than by listing the
    // screens again here, so a screen added later is covered by construction.
    for (const id of MENU_IDS) {
      // Widened: `as const` narrows each entry to its own literal type, so the
      // optional flags do not exist on the ones that omit them.
      const buttons: readonly MenuAction[] = MENUS[id].buttons;
      const optional = buttons.filter((b) => !b.required && !b.conditional);
      const required = buttons.filter((b) => b.required);
      // Either something is pinned, or more than one unconditional button
      // survives every state — anything else is a screen one edit from silence.
      expect(required.length > 0 || optional.length > 1, `menu ${id}`).toBe(true);
    }
  });
});

describe('the prompt keyboard', () => {
  it('sends the customer back where they came from', async () => {
    // Six screens built this by hand, four quoting «بازگشت ⬅️» letter for
    // letter. One layout now, and the destination stays the bot's to decide.
    const { updateId, telegramId } = ids();
    const plan = await planId('sim-vip-1m-50');
    const vip = await providerId('sim-vip');

    await handleUpdate(db, startUpdate(updateId, telegramId));
    await handleUpdate(db, press(updateId + 1, telegramId, 'buy'));
    await handleUpdate(db, press(updateId + 2, telegramId, `panel:${vip}`));
    await handleUpdate(db, press(updateId + 3, telegramId, `plan:${plan}`));
    const asked = await handleUpdate(db, press(updateId + 4, telegramId, `dsc:${plan}`));

    expect(datas(asked.replies[0]?.keyboard)).toEqual([`plan:${plan}`]);
  });

  it('carries the shop’s wording wherever it is used', async () => {
    await save('prompt', [
      { action: 'back', label: '↩️ بی‌خیال', rowIndex: 0, colIndex: 0, visible: true },
    ]);

    const { updateId, telegramId } = ids();
    await handleUpdate(db, startUpdate(updateId, telegramId));
    await handleUpdate(db, press(updateId + 1, telegramId, 'wal'));
    const gift = await handleUpdate(db, press(updateId + 2, telegramId, 'gft'));

    expect(labels(gift.replies[0]?.keyboard)).toEqual([['↩️ بی‌خیال']]);
    expect(datas(gift.replies[0]?.keyboard)).toEqual(['wal']);
  });

  it('draws nothing rather than a button pointing nowhere', () => {
    // `back` has no destination of its own. A caller that forgot to supply one
    // would otherwise render a button that fires the literal string `back`,
    // which `decode` rejects — a button that draws and does nothing.
    expect(buildMenu('prompt', DEFAULT_LAYOUTS.prompt)).toEqual([]);
  });
});

describe('a saved layout that no longer makes sense', () => {
  it('is ignored for a menu this build does not have', async () => {
    // A row can name a screen a later release removed, or one a hand-written
    // INSERT invented. Loading it would put a key on the layouts object that no
    // menu id covers, and every consumer that walks the object would then see a
    // screen the bot cannot draw.
    await db
      .prepare(
        `INSERT INTO bot_keyboard_buttons (menu, action, label, row_index, col_index, visible)
         VALUES ('somescreenwedeleted', 'menu', 'x', 0, 0, true)`,
      )
      .run();
    invalidateBotContent();
    const content = await loadBotContent(db);

    expect(Object.keys(content.layouts).sort()).toEqual([...MENU_IDS].sort());
    // And every real screen still draws, which is the point: one stale row must
    // not be able to blank the bot.
    menu.applyContent(content);
    expect(labels(menu.walletMenu()).flat()).toContain('بازگشت به منو ⬅️');
  });

  it('drops a button this build no longer dispatches', async () => {
    await save('wallet', [
      { action: 'top', label: '💰 شارژ', rowIndex: 0, colIndex: 0, visible: true },
      { action: 'gone', label: 'قدیمی', rowIndex: 0, colIndex: 1, visible: true },
      { action: 'menu', label: 'بازگشت', rowIndex: 1, colIndex: 0, visible: true },
    ]);
    await applySaved();
    expect(labels(menu.walletMenu())).toEqual([['💰 شارژ'], ['بازگشت']]);
  });

  it('leaves no blank row when a whole row is hidden', async () => {
    await save('wallet', [
      { action: 'top', label: '💰 شارژ', rowIndex: 0, colIndex: 0, visible: true },
      { action: 'gft', label: '🎁 هدیه', rowIndex: 1, colIndex: 0, visible: false },
      { action: 'menu', label: 'بازگشت', rowIndex: 2, colIndex: 0, visible: true },
    ]);
    await applySaved();
    const rows = menu.walletMenu();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.length > 0)).toBe(true);
  });
});
