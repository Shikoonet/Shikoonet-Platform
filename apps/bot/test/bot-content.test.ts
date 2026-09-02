/**
 * The editable wording and keyboard, judged by what the customer receives.
 *
 * The assertions that matter here do not read the tables back. They run a real
 * update through `handleUpdate` and inspect the reply, because everything
 * between — the loader, the cache, the live bindings in `menu.ts` — is exactly
 * the machinery that could silently keep serving the default. A test that
 * checked `bot_texts` contained the new sentence would pass with the whole
 * wiring removed.
 */

import { CUSTOMER, RESELLER } from './helpers/viewers.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertSchema, db } from './helpers/env.js';
import { handleUpdate } from '../src/handle.js';
import { invalidateBotContent, loadBotContent, DEFAULT_CONTENT } from '../src/botContent.js';
import {
  allMenuActions,
  buildMainMenu,
  checkLayout,
  DEFAULT_LAYOUT,
  DEFAULT_LAYOUTS,
  MENU_IDS,
  MENUS,
} from '../src/keyboard.js';
import { checkOverride, stripCustomEmoji, TEXTS, TEXT_KEYS, Texts, MAX_TEXT_LENGTH } from '@shikoo/contracts';
import { decode } from '../src/callback.js';
import * as menu from '../src/menu.js';

const TG = 788_000_000;
let seq = 0;

async function makeCustomer(): Promise<number> {
  const telegramId = TG + ++seq;
  await db
    .prepare(
      `INSERT INTO users (telegram_id, username, registered_at) VALUES (?1, ?2, now())
     ON CONFLICT (telegram_id) DO NOTHING`,
    )
    .bind(telegramId, `content_${seq}`)
    .run();
  return telegramId;
}

/** A `/start`, which answers with the welcome text and the main keyboard. */
async function start(telegramId: number) {
  const outcome = await handleUpdate(db, {
    update_id: 900_000 + ++seq,
    message: {
      message_id: seq,
      chat: { id: telegramId },
      from: { id: telegramId, username: `content_${seq}` },
      text: '/start',
    },
  });
  return outcome.replies[0];
}

async function clearOverrides(): Promise<void> {
  await db.prepare(`DELETE FROM bot_texts`).run();
  await db.prepare(`DELETE FROM bot_keyboard_buttons`).run();
  invalidateBotContent();
  menu.resetContent();
}

beforeAll(assertSchema);

beforeEach(clearOverrides);
// Module-level bindings are shared between tests in this file, so a test that
// changed the wording must not colour the next one.
afterEach(clearOverrides);

describe('the placeholder contract', () => {
  it('accepts an ordinary rewrite', () => {
    expect(checkOverride('WELCOME', 'سلام! خوش آمدید.')).toBeNull();
  });

  it('refuses a slot the text was never given a value for', () => {
    // Typed hopefully by an admin, this would ship to the customer as the
    // literal characters `{name}`.
    expect(checkOverride('WELCOME', 'سلام {name}')).toEqual({
      kind: 'UNKNOWN_PLACEHOLDER',
      names: ['name'],
    });
  });

  it('refuses dropping a slot the screen depends on', () => {
    // The support screen's whole job is to say who to message. Without
    // {handle} it is a complete-looking, useless screen.
    expect(checkOverride('SUPPORT_SCREEN', '☎️ پشتیبانی\n\nبه ما پیام بدهید.')).toEqual({
      kind: 'MISSING_PLACEHOLDER',
      names: ['handle'],
    });
    expect(checkOverride('SUPPORT_SCREEN', 'به @{handle} پیام بدهید.')).toBeNull();
  });

  it('refuses an empty text and one Telegram would reject', () => {
    expect(checkOverride('WELCOME', '   ')).toEqual({ kind: 'EMPTY' });
    expect(checkOverride('WELCOME', 'ا'.repeat(MAX_TEXT_LENGTH + 1))).toEqual({
      kind: 'TOO_LONG',
      limit: MAX_TEXT_LENGTH,
    });
    expect(checkOverride('WELCOME', 'ا'.repeat(MAX_TEXT_LENGTH))).toBeNull();
  });

  it('refuses a key the bot does not have', () => {
    expect(checkOverride('NOT_A_KEY', 'x')).toEqual({ kind: 'UNKNOWN_KEY' });
  });

  it('declares every slot its default actually uses', () => {
    // Outside truth for the registry: the default is the wording that ships, so
    // a declared slot the default never uses, or one it uses undeclared, is a
    // registry entry that lies about itself.
    for (const key of TEXT_KEYS) {
      const entry = TEXTS[key];
      const inDefault = [...entry.default.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(
        (m) => m[1],
      );
      expect([...new Set(inDefault)].sort()).toEqual([...entry.placeholders].sort());
    }
  });
});

describe('the texts a customer receives', () => {
  it('says the default when nothing is overridden', async () => {
    const reply = await start(await makeCustomer());
    // The default ships with <tg-emoji> markup; the bot ships with customEmoji
    // off by default (the test seeds no override), so `Texts.raw()` strips the
    // markup before the message is sent and the customer sees the fallback.
    expect(reply?.text).toBe(stripCustomEmoji(TEXTS.WELCOME.default));
  });

  it('says the admin’s wording once it is saved', async () => {
    const custom = 'سلام! به فروشگاه ما خوش آمدید 🌟';
    await db
      .prepare(`INSERT INTO bot_texts (key, value) VALUES ('WELCOME', ?1)`)
      .bind(custom)
      .run();
    invalidateBotContent();

    const reply = await start(await makeCustomer());
    expect(reply?.text).toBe(custom);
    expect(reply?.text).not.toBe(TEXTS.WELCOME.default);
  });

  it('goes back to the default when the row is deleted', async () => {
    await db.prepare(`INSERT INTO bot_texts (key, value) VALUES ('WELCOME', 'موقت')`).run();
    invalidateBotContent();
    expect((await start(await makeCustomer()))?.text).toBe('موقت');

    // Reset is DELETE, so a default improved in a later release reaches a shop
    // that had customised it and changed its mind.
    await db.prepare(`DELETE FROM bot_texts WHERE key = 'WELCOME'`).run();
    invalidateBotContent();
    expect((await start(await makeCustomer()))?.text).toBe(stripCustomEmoji(TEXTS.WELCOME.default));
  });

  it('ignores a row that was written by hand and breaks the contract', async () => {
    // The API refuses this, but the table can be reached with psql. The
    // customer must not be the one who finds out.
    await db
      .prepare(`INSERT INTO bot_texts (key, value) VALUES ('SUPPORT_SCREEN', 'به ما پیام بدهید')`)
      .run();
    invalidateBotContent();
    const content = await loadBotContent(db);
    expect(content.texts.raw('SUPPORT_SCREEN')).toBe(TEXTS.SUPPORT_SCREEN.default);
  });

  it('fills the slot rather than concatenating around it', () => {
    const texts = new Texts({
      SUPPORT_SCREEN: 'برای پشتیبانی: @{handle}\nهر روز ۹ تا ۱۸',
    });
    expect(texts.render('SUPPORT_SCREEN', { handle: 'shikoo_help' })).toBe(
      'برای پشتیبانی: @shikoo_help\nهر روز ۹ تا ۱۸',
    );
  });

  it('leaves a slot alone when nothing was given for it', () => {
    // `@` on its own reads as a broken screen; `{handle}` reads as a
    // misconfiguration, and only one of those gets reported to the shop.
    expect(DEFAULT_CONTENT.texts.render('SUPPORT_SCREEN', {})).toContain('{handle}');
  });
});

describe('the keyboard', () => {
  it('is production’s layout when nothing is customised', async () => {
    const reply = await start(await makeCustomer());
    const rows = reply?.keyboard ?? [];
    expect(rows.map((r) => r.map((b) => b.text))).toEqual([
      ['♻️ تمدید سرویس', '🔐 خرید اشتراک'],
      ['🏦 کیف پول + شارژ', '🛍 سرویس های من'],
      ['☎️ پشتیبانی', '📚 آموزش', '👥 زیر مجموعه گیری'],
      ['👨‍💻 درخواست نمایندگی'],
      // Appended, never inserted — see the same list in `menu.test.ts` and the
      // note beside `['tst', 4, 0]` in `botKeyboard.ts`. The four rows above
      // are still `setting.keyboardmain` from the dump, in its order.
      ['🎁 سرویس تست رایگان'],
    ]);
  });

  it('renames, reorders and hides exactly as saved', async () => {
    for (const [action, label, row, col, visible] of [
      ['buy', '🛒 خرید', 0, 0, true],
      ['wal', '💰 کیف پول', 0, 1, true],
      ['renew', '♻️ تمدید', 1, 0, true],
      ['sup', '☎️ پشتیبانی', 1, 1, true],
      ['mine', 'سرویس‌ها', 2, 0, false],
    ] as const) {
      await db
        .prepare(
          `INSERT INTO bot_keyboard_buttons (menu, action, label, row_index, col_index, visible)
         VALUES ('main', ?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(action, label, row, col, visible)
        .run();
    }
    invalidateBotContent();

    const reply = await start(await makeCustomer());
    expect((reply?.keyboard ?? []).map((r) => r.map((b) => b.text))).toEqual([
      ['🛒 خرید', '💰 کیف پول'],
      ['♻️ تمدید', '☎️ پشتیبانی'],
    ]);
  });

  it('keeps every callback working after a rename', () => {
    // The label is what changed; `callback_data` is what the bot dispatches on,
    // and an admin renaming a button must not detach it from its handler.
    const renamed = DEFAULT_LAYOUT.map((b) => ({ ...b, label: `x ${b.action}` }));
    const rows = buildMainMenu(renamed, CUSTOMER);
    const data = rows.flat().map((b) => b.callback_data);
    for (const action of ['renew', 'buy', 'wal', 'mine', 'sup', 'hlp', 'ref', 'agr']) {
      expect(data).toContain(action);
    }
  });

  it('still hides the reseller button from a reseller, whatever the layout says', () => {
    const rows = buildMainMenu(DEFAULT_LAYOUT, RESELLER);
    expect(rows.flat().map((b) => b.callback_data)).not.toContain('agr');
  });

  it('drops an action this build no longer handles instead of drawing a dead button', () => {
    const rows = buildMainMenu(
      [
        { action: 'buy', label: 'خرید', rowIndex: 0, colIndex: 0, visible: true, style: null },
        { action: 'gone', label: 'قدیمی', rowIndex: 0, colIndex: 1, visible: true, style: null },
      ],
      CUSTOMER,
    );
    expect(rows.flat().map((b) => b.text)).toEqual(['خرید']);
  });

  it('leaves no blank row when a whole row is hidden', () => {
    const rows = buildMainMenu(
      [
        { action: 'buy', label: 'خرید', rowIndex: 0, colIndex: 0, visible: true, style: null },
        { action: 'wal', label: 'کیف', rowIndex: 1, colIndex: 0, visible: false, style: null },
        { action: 'sup', label: 'پشتیبانی', rowIndex: 2, colIndex: 0, visible: true, style: null },
      ],
      CUSTOMER,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.length > 0)).toBe(true);
  });
});

describe('layout validation', () => {
  const ok = (over: Partial<Parameters<typeof buildMainMenu>[0][number]> = {}) => [
    { action: 'buy', label: 'خرید', rowIndex: 0, colIndex: 0, visible: true, style: null, ...over },
  ];

  it('accepts every layout the code ships', () => {
    for (const id of MENU_IDS) {
      expect(checkLayout(id, [...DEFAULT_LAYOUTS[id]]), `menu ${id}`).toBeNull();
    }
  });

  it('refuses a keyboard with nothing visible', () => {
    // A customer left on a screen with no button has no way forward and no way
    // back, and only an admin who realises what they did can fix it.
    expect(checkLayout('main', ok({ visible: false }))).toEqual({ kind: 'NOTHING_VISIBLE' });
  });

  it('refuses one whose only visible button no customer sees', () => {
    // `agr` is hidden from resellers, so a layout of just `agr` is empty for
    // every reseller — a subtler version of the same trap.
    expect(
      checkLayout('main', [
        { action: 'agr', label: 'نمایندگی', rowIndex: 0, colIndex: 0, visible: true, style: null },
      ]),
    ).toEqual({ kind: 'NOTHING_VISIBLE' });
  });

  it('refuses one that leaves a whole audience with nothing', () => {
    // «درخواست نمایندگی» is hidden from a reseller — they already are one — so
    // a main menu made only of it is an empty screen for every reseller in the
    // shop. The check has to be against each audience, not against the button
    // list as a whole.
    //
    // This used to pair it with «پنل مدیریت», the other audience-limited
    // button. That one was the bot's own admin panel and the panel is the
    // dashboard's now, so `agr` is the only limited button left.
    expect(
      checkLayout('main', [
        { action: 'agr', label: 'نمایندگی', rowIndex: 0, colIndex: 0, visible: true, style: null },
      ]),
    ).toEqual({ kind: 'NOTHING_VISIBLE' });
  });

  it('refuses an action the bot cannot dispatch', () => {
    expect(checkLayout('main', ok({ action: 'nope' }))).toEqual({
      kind: 'UNKNOWN_ACTION',
      actions: ['nope'],
    });
  });

  it('refuses an action that belongs to a different screen', () => {
    // `paid` is a real callback and a real button — on the invoice. On the main
    // menu it would fire with no order behind it.
    expect(checkLayout('main', ok({ action: 'paid' }))).toEqual({
      kind: 'UNKNOWN_ACTION',
      actions: ['paid'],
    });
  });

  it('refuses a menu it has never heard of', () => {
    expect(checkLayout('nosuchscreen', ok())).toEqual({ kind: 'UNKNOWN_MENU' });
  });

  it('refuses the same button twice and the same cell twice', () => {
    expect(
      checkLayout('main', [
        { action: 'buy', label: 'a', rowIndex: 0, colIndex: 0, visible: true, style: null },
        { action: 'buy', label: 'b', rowIndex: 0, colIndex: 1, visible: true, style: null },
      ]),
    ).toEqual({ kind: 'DUPLICATE_ACTION', actions: ['buy'] });

    expect(
      checkLayout('main', [
        { action: 'buy', label: 'a', rowIndex: 0, colIndex: 0, visible: true, style: null },
        { action: 'wal', label: 'b', rowIndex: 0, colIndex: 0, visible: true, style: null },
      ]),
    ).toEqual({ kind: 'DUPLICATE_CELL' });
  });

  it('refuses an empty or over-long label', () => {
    expect(checkLayout('main', ok({ label: '  ' }))).toEqual({
      kind: 'LABEL_EMPTY',
      actions: ['buy'],
    });
    expect(checkLayout('main', ok({ label: 'ا'.repeat(65) }))?.kind).toBe('LABEL_TOO_LONG');
  });

  it('refuses an empty layout', () => {
    expect(checkLayout('main', [])).toEqual({ kind: 'EMPTY' });
  });

  it('names only actions the bot can actually dispatch', () => {
    // `MENUS` lives in `@shikoo/contracts`, which cannot import the bot's
    // `CallbackAction` union — so the contract that used to be checked by the
    // compiler is checked here instead. An action the palette offers and
    // `parseCallback` rejects is a button that draws and does nothing.
    for (const { menu: menuId, action } of allMenuActions()) {
      // `back` is the one button whose destination the bot supplies, so there
      // is nothing for `decode` to recognise.
      if (action === 'back') continue;
      expect(decode(action), `${menuId} → ${action}`).not.toBeNull();
    }
  });

  it('offers every action its default layout uses', () => {
    // The admin screen builds its palette from `MENUS`. An action in a default
    // layout but missing from the palette would be a button the admin could
    // delete and never add back.
    for (const id of MENU_IDS) {
      const offered = new Set(MENUS[id].buttons.map((b) => b.action));
      for (const b of DEFAULT_LAYOUTS[id]) {
        expect(offered.has(b.action as never), `${id} → ${b.action}`).toBe(true);
      }
    }
  });
});
