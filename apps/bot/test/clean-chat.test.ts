/**
 * One live screen, and the menu under the chat.
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
 * The menu moved under the chat at the same time, which is what makes the first
 * change safe to have: a customer whose screen is being edited in place still
 * has the shop's front door in front of them, and pressing it is also how they
 * abandon a question they no longer want to answer.
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

describe('which door /start opens with', () => {
  it('gives a brand-new customer the bottom keyboard, and a returning one the inline menu', async () => {
    // Found in Sam's own Telegram, 2026-09-04. The welcome said «از منوی زیر
    // انتخاب کنید» and there was nothing under it: the bottom keyboard had been
    // delivered correctly weeks earlier and his client had it COLLAPSED, behind
    // a toggle he had to know to press. We send `is_persistent: true`; that
    // client does not honour it.
    //
    // So a menu is drawn either way, and the two together are self-healing: a
    // customer whose keyboard is hidden presses /start, is no longer new, and
    // gets a menu they can see. That property is what this test is really for —
    // asserting only the first half would pass with the second one deleted.
    const { telegramId } = ids();

    // Nothing creates the row first: `/start` does, which is what makes it new.
    const first = await handleUpdate(db, typed(ids().updateId, telegramId, '/start'));
    expect(first.replies[0]?.replyKeyboard, 'a new customer has no keyboard yet').toBeDefined();
    expect(first.replies[0]?.keyboard).toBeUndefined();

    const again = await handleUpdate(db, typed(ids().updateId, telegramId, '/start'));
    expect(again.replies[0]?.keyboard, 'the door a client cannot collapse').toBeDefined();
    expect(again.replies[0]?.replyKeyboard).toBeUndefined();

    // And it is the same menu both times — one layout, two markups.
    const bottom = (first.replies[0]?.replyKeyboard as { text: string }[][]).flat().map((b) => b.text);
    const inline = (again.replies[0]?.keyboard ?? []).flat().map((b) => b.text);
    expect(inline).toEqual(bottom);
  });
});

describe('the menu under the chat', () => {
  it('opens the same screen the inline button opens', async () => {
    // The bottom keyboard sends a LABEL, not a callback. If the two roads led to
    // different screens, the shop would have two menus that drift — and the one
    // people press is the one nobody tests.
    const { telegramId } = ids();
    await makeCustomer(telegramId);

    const label = (menu.mainReplyMenu({ is_reseller: false, is_admin: false }) as { text: string }[][])
      .flat()
      .map((b) => b.text)
      .find((t) => t.includes('خرید'));
    expect(label).toBeDefined();

    const viaLabel = await handleUpdate(db, typed(ids().updateId, telegramId, label!));
    const viaButton = await handleUpdate(db, pressed(ids().updateId, telegramId, 'buy', 900));

    expect(viaLabel.status).toBe('processed');
    expect(viaLabel.replies[0]?.text).toBe(viaButton.replies[0]?.text);
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

    const label = (menu.mainReplyMenu({ is_reseller: false, is_admin: false }) as { text: string }[][])
      .flat()
      .map((b) => b.text)
      .find((t) => t.includes('خرید'))!;
    await handleUpdate(db, typed(ids().updateId, telegramId, label));

    const row = await db
      .prepare(`SELECT step FROM bot_sessions WHERE user_id = ?1`)
      .bind(user)
      .first<{ step: string | null }>();
    expect(row?.step).toBeNull();
  });

  it('still matches after an admin renames the button', async () => {
    // The labels are the shop's, not ours. A lookup against the shipped defaults
    // would leave a renamed button typing at a bot that has never heard of it.
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
