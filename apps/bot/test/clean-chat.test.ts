/**
 * One live screen, and a permanent way home under the chat.
 *
 * Two changes with one purpose, and both are about what the customer SEES after
 * they have used the bot for a minute.
 *
 * A button press has always edited the screen in place, so the shop never left
 * a trail. Everything TYPED did: a discount code, a wallet amount, the name for
 * an account — each one a message from the customer and an answer from the bot,
 * and after three of them the screen they are meant to be looking at is
 * somewhere up the scrollback. So a typed answer now edits the screen that
 * ASKED, and the customer's own message is deleted.
 *
 * The navigation row under the chat makes the first change safe to have: a
 * customer whose screen is being edited in place still has a stable way back
 * to the shop's inline menu, and pressing it is also how they abandon a
 * question they no longer want to answer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSchema, db, resetBot } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId } from './helpers/shop.js';
import { handleUpdate } from '../src/handle.js';
import * as menu from '../src/menu.js';
import { invalidateBotContent } from '../src/botContent.js';

let nextId = 0;
function ids(): { updateId: number; telegramId: number } {
  const n = ++nextId * 10;
  return { updateId: 611_000 + n, telegramId: 511_000 + n };
}

function typed(updateId: number, telegramId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: telegramId, username: `cc${telegramId}` },
      chat: { id: telegramId },
      text,
    },
  };
}

function pressed(updateId: number, telegramId: number, data: string, screenId: number) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: telegramId, username: `cc${telegramId}` },
      message: { message_id: screenId, chat: { id: telegramId } },
      data,
    },
  };
}

beforeEach(async () => {
  await assertSchema();
  await resetBot();
  // The layout is shop-wide and this suite renames a button in one test. Left
  // behind, that rename reaches every other suite on this database — `buy.test`
  // went red from a file it does not mention, which is rule 8 in one line.
  await db.prepare(`DELETE FROM bot_keyboard_buttons`).run();
  invalidateBotContent();
  await ensureCatalog();
});

afterEach(async () => {
  await db.prepare(`DELETE FROM bot_keyboard_buttons`).run();
  invalidateBotContent();
});

describe('a typed answer', () => {
  it('edits the screen that asked, and takes the typing out of the chat', async () => {
    const { telegramId } = ids();
    await makeCustomer(telegramId);
    const plan = await planId('sim-vip-1m-50');
    const SCREEN = 4242;

    // «کد تخفیف دارم», pressed on the plan screen.
    const asked = await handleUpdate(db, pressed(ids().updateId, telegramId, `dsc:${plan}`, SCREEN));
    expect(asked.replies[0]?.editMessageId).toBe(SCREEN);

    // The customer types a code that does not exist. Which answer comes back is
    // not what this test is about — where it goes is.
    const typing = ids();
    const answered = await handleUpdate(db, typed(typing.updateId, telegramId, 'NOPE'));

    expect(answered.status).toBe('processed');
    // Written back into the screen, not below it.
    expect(answered.replies[0]?.editMessageId).toBe(SCREEN);
    // And the customer's own message is gone, so the chat still holds one screen.
    expect(answered.deletes).toEqual([
      { chatId: telegramId, messageId: typing.updateId },
    ]);
  });

  it('sends a new message when there is no screen to write back into', async () => {
    // A session written before this existed, or a question asked from a message
    // Telegram has since dropped. The answer must still arrive — falling back to
    // a new message is the whole reason `screenOf` is optional.
    const { telegramId } = ids();
    const user = await makeCustomer(telegramId);
    await db
      .prepare(
        `INSERT INTO bot_sessions (user_id, step, data, updated_at)
         VALUES (?1, 'gift', '{}'::jsonb, now())
         ON CONFLICT (user_id) DO UPDATE SET step = 'gift', data = '{}'::jsonb`,
      )
      .bind(user)
      .run();

    const typing = ids();
    const out = await handleUpdate(db, typed(typing.updateId, telegramId, 'SOMECODE'));

    expect(out.status).toBe('processed');
    expect(out.replies[0]?.editMessageId).toBeUndefined();
    // The typing still goes: a chat with no screen to keep is still a chat that
    // should not fill up.
    expect(out.deletes).toEqual([{ chatId: telegramId, messageId: typing.updateId }]);
  });
});

describe('/start tidying up after the last visit', () => {
  it('takes the command and the abandoned screen off the chat', async () => {
    // Sam, 2026-09-04: «می‌خوام داخل چت خیلی تمیز باشه و چت‌های قدیمی پاک بشه».
    // Walking the live bot, every `/start` left two messages behind — the
    // command and a welcome — on top of whatever half-finished screen the last
    // visit had stopped on, still showing buttons for a flow that no longer
    // exists.
    const { telegramId } = ids();
    const user = await makeCustomer(telegramId);
    const plan = await planId('sim-vip-1m-50');

    // A question, left open on a screen — the wreck `/start` is abandoning.
    const SCREEN = 4242;
    await handleUpdate(db, pressed(ids().updateId, telegramId, `dsc:${plan}`, SCREEN));

    const startId = ids().updateId;
    const started = await handleUpdate(db, typed(startId, telegramId, '/start'));
    const gone = (started.deletes ?? []).map((d) => d.messageId);

    expect(started.status).toBe('processed');
    expect(gone, 'the screen the abandoned flow was on').toContain(SCREEN);
    expect(gone, 'the «/start» the customer just typed').toContain(startId);

    // And the session really is reset, not just visually tidied.
    const row = await db
      .prepare(`SELECT step FROM bot_sessions WHERE user_id = ?1`)
      .bind(user)
      .first<{ step: string | null }>();
    expect(row?.step).toBeNull();
  });

  it('leaves earlier visits alone', async () => {
    // The line between tidying up after itself and rewriting somebody's
    // history. A second `/start` with nothing open deletes only the command
    // that asked for it — the welcome from the first visit stays where it is.
    //
    // Asserted as the exact message and chat, not as a count: «one thing was
    // deleted» is also true of a regression that deletes the FIRST visit's
    // message instead, which is the one thing this test exists to forbid.
    // Review caught that on PR #99, and it is rule 6 again.
    const { telegramId } = ids();
    await makeCustomer(telegramId);
    const firstId = ids().updateId;
    await handleUpdate(db, typed(firstId, telegramId, '/start'));

    const secondId = ids().updateId;
    const second = await handleUpdate(db, typed(secondId, telegramId, '/start'));

    expect(second.deletes ?? []).toEqual([{ chatId: telegramId, messageId: secondId }]);
  });
});

describe('the navigation bar installed by /start', () => {
  it('keeps the home row below the app and the inline main menu as the last message', async () => {
    // `/start` is also the upgrade and repair path. Restricting the row to the
    // INSERT branch would leave every existing customer on whatever keyboard a
    // previous release happened to install. The inline half is asserted at the
    // end of the reply list because that order is what the customer sees.
    const { telegramId } = ids();

    const first = await handleUpdate(db, typed(ids().updateId, telegramId, '/start'));
    expect(first.replies[0]?.replyKeyboard).toEqual(menu.homeReplyMenu());
    expect(first.replies[0]?.replyKeyboard).toEqual([
      [{ text: menu.HOME_REPLY_LABEL, style: 'success' }],
    ]);
    expect(first.replies[0]?.keyboard).toBeUndefined();
    expect(first.replies.at(-1)?.text).toBe(menu.MENU_TITLE);
    expect(first.replies.at(-1)?.keyboard).toEqual(
      menu.mainMenu({ is_reseller: false, is_admin: false }),
    );

    const again = await handleUpdate(db, typed(ids().updateId, telegramId, '/start'));
    expect(again.replies[0]?.replyKeyboard).toEqual(menu.homeReplyMenu());
    expect(again.replies.at(-1)?.text).toBe(menu.MENU_TITLE);
    expect(again.replies.at(-1)?.keyboard).toBeDefined();
  });
});

describe('the navigation bar under the chat', () => {
  it('opens the same screen the inline button opens', async () => {
    // The bottom keyboard sends a LABEL, not a callback. If the two roads led to
    // different screens, the shop would have two menus that drift — and the one
    // people press is the one nobody tests.
    const { telegramId } = ids();
    await makeCustomer(telegramId);

    const viaLabel = await handleUpdate(
      db,
      typed(ids().updateId, telegramId, menu.HOME_REPLY_LABEL),
    );
    const viaButton = await handleUpdate(db, pressed(ids().updateId, telegramId, 'menu', 900));

    expect(viaLabel.status).toBe('processed');
    expect(viaLabel.replies[0]?.text).toBe(viaButton.replies[0]?.text);
    expect(viaLabel.replies[0]?.keyboard).toEqual(viaButton.replies[0]?.keyboard);
  });

  it('turns green «برگشت» inside a menu and returns home from its first screen', async () => {
    const { telegramId } = ids();
    await makeCustomer(telegramId);

    const inside = await handleUpdate(
      db,
      pressed(ids().updateId, telegramId, 'buy', 901),
    );
    expect(inside.replyKeyboardUpdate).toEqual({
      chatId: telegramId,
      keyboard: [[{ text: menu.BACK_REPLY_LABEL, style: 'success' }]],
    });

    const back = await handleUpdate(
      db,
      typed(ids().updateId, telegramId, menu.BACK_REPLY_LABEL),
    );
    expect(back.replies[0]?.text).toBe(menu.MENU_TITLE);
    expect(back.replyKeyboardUpdate).toEqual({
      chatId: telegramId,
      keyboard: [[{ text: menu.HOME_REPLY_LABEL, style: 'success' }]],
    });
  });

  it('remembers the real parent for «برگشت» on a deeper screen', async () => {
    const { telegramId } = ids();
    await makeCustomer(telegramId);
    const plan = await planId('sim-vip-1m-50');

    const prompt = await handleUpdate(
      db,
      pressed(ids().updateId, telegramId, `dsc:${plan}`, 902),
    );
    expect(prompt.replyKeyboardUpdate?.keyboard).toEqual(menu.backReplyMenu());

    const back = await handleUpdate(
      db,
      typed(ids().updateId, telegramId, menu.BACK_REPLY_LABEL),
    );
    const direct = await handleUpdate(
      db,
      pressed(ids().updateId, telegramId, `plan:${plan}`, 903),
    );
    expect(back.replies[0]?.text).toBe(direct.replies[0]?.text);
    // Both screens are still below the main menu, so no redundant Telegram
    // keyboard replacement is requested — only the saved parent changes.
    expect(back.replyKeyboardUpdate).toBeUndefined();
  });

  it('abandons an open question rather than answering it', async () => {
    // Pressing «خرید» while the bot waits for a discount code is a customer
    // walking away. Reading their press as the answer is the one interpretation
    // that is certainly wrong — and it is what happens if the session is
    // consulted before the menu.
    const { telegramId } = ids();
    const user = await makeCustomer(telegramId);
    const plan = await planId('sim-vip-1m-50');
    await handleUpdate(db, pressed(ids().updateId, telegramId, `dsc:${plan}`, 77));

    await handleUpdate(db, typed(ids().updateId, telegramId, menu.HOME_REPLY_LABEL));

    const row = await db
      .prepare(`SELECT step FROM bot_sessions WHERE user_id = ?1`)
      .bind(user)
      .first<{ step: string | null }>();
    expect(row?.step).toBeNull();
  });

  it('still accepts a renamed button left by the previous full keyboard', async () => {
    // Deploying the one-row navbar cannot atomically replace a reply keyboard
    // in every existing chat. Until a customer next presses `/start`, labels
    // installed by the previous release must still lead somewhere.
    const { telegramId } = ids();
    await makeCustomer(telegramId);
    await db
      .prepare(
        `INSERT INTO bot_keyboard_buttons (menu, action, label, row_index, col_index, visible)
         VALUES ('main', 'buy', '🛒 فروشگاه شیکو', 0, 0, true)`,
      )
      .run();
    invalidateBotContent();

    const out = await handleUpdate(db, typed(ids().updateId, telegramId, '🛒 فروشگاه شیکو'));
    expect(out.status).toBe('processed');
    // The shop's first screen, whatever it turned out to be — not silence.
    expect(out.replies[0]?.text ?? '').not.toBe('');
  });
});
