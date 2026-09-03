/**
 * The admin's premium-emoji screen, inside the bot.
 *
 * Sam, 2026-09-03: «قسمت ایموجی‌ها درست کار نمی‌کنه» — add a menu in the bot
 * itself where an admin can give it a premium emoji and put that emoji on the
 * keyboard.
 *
 * The reason it belongs in the bot rather than only in the panel is the id. A
 * custom emoji is a 64-bit number, and a person who wants a particular glyph
 * has it in their keyboard — not its sticker set's name. Telegram attaches the
 * id to the message entity, so sending the emoji IS the lookup.
 *
 * What is defended here:
 *
 *   - a customer cannot reach any of it, drawn or posted;
 *   - what comes back is drawn by the same path a customer's screen is, so an
 *     admin looking at the list is looking at the live answer to «can this bot
 *     send premium emoji at all»;
 *   - putting one on a button writes the SHOP's layout, in the shape the send
 *     path can actually draw.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db, resetBot } from './helpers/env.js';
import { makeCustomer } from './helpers/shop.js';
import { handleUpdate } from '../src/handle.js';
import { invalidateBotContent } from '../src/botContent.js';
import { customEmojiIn } from '../src/emoji.js';
import { DEFAULT_LAYOUTS } from '@shikoo/contracts';

const FIRE_ID = '5368324170671202286';

let nextId = 0;
function ids(): { updateId: number; telegramId: number } {
  const n = ++nextId * 10;
  return { updateId: 655_000 + n, telegramId: 555_000 + n };
}

async function makeAdmin(telegramId: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admins (telegram_id, role, active) VALUES (?1, 'ADMIN', true)
       ON CONFLICT (telegram_id) DO UPDATE SET active = true`,
    )
    .bind(telegramId)
    .run();
}

function press(updateId: number, telegramId: number, data: string) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: telegramId },
      message: { message_id: 900, chat: { id: telegramId } },
      data,
    },
  };
}

/** A message carrying a premium emoji, exactly as Telegram delivers one. */
function sentEmoji(updateId: number, telegramId: number, id = FIRE_ID) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: telegramId },
      chat: { id: telegramId },
      text: '🔥',
      entities: [{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: id }],
    },
  };
}

beforeEach(async () => {
  await resetBot();
  await db.prepare(`DELETE FROM bot_keyboard_buttons`).run();
  await db.prepare(`DELETE FROM emoji_pack_items WHERE pack_id IN
    (SELECT id FROM emoji_packs WHERE set_name = '__from_bot__')`).run();
  await db.prepare(`DELETE FROM emoji_packs WHERE set_name = '__from_bot__'`).run();
  invalidateBotContent();
});

describe('reading the id off the message', () => {
  it('takes the id and the glyph a customer without Premium will see', () => {
    // The glyph is sliced out of the text by the entity's own offsets. Inventing
    // one would put a different picture on a non-Premium customer's screen than
    // the admin chose.
    expect(
      customEmojiIn({
        text: 'سلام 🔥',
        entities: [{ type: 'custom_emoji', offset: 5, length: 2, custom_emoji_id: FIRE_ID }],
      }),
    ).toEqual([{ customEmojiId: FIRE_ID, fallbackEmoji: '🔥' }]);
  });

  it('ignores an ordinary emoji, which carries no id at all', () => {
    expect(customEmojiIn({ text: '🔥', entities: [] })).toEqual([]);
    expect(customEmojiIn({ text: '🔥' })).toEqual([]);
  });
});

describe('who may open it', () => {
  it('is not drawn for a customer', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const out = await handleUpdate(db, {
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: telegramId },
        chat: { id: telegramId },
        text: '/start',
      },
    });
    const rows = out.replies[0]?.replyKeyboard;
    const labels = (Array.isArray(rows) ? rows : []).flat().map((b) => b.text);
    expect(labels.some((l) => l.includes('ایموجی پریمیوم'))).toBe(false);
  });

  it('is drawn for an admin', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    await makeAdmin(telegramId);
    const out = await handleUpdate(db, {
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: telegramId },
        chat: { id: telegramId },
        text: '/start',
      },
    });
    const rows = out.replies[0]?.replyKeyboard;
    const labels = (Array.isArray(rows) ? rows : []).flat().map((b) => b.text);
    expect(labels.some((l) => l.includes('ایموجی پریمیوم'))).toBe(true);
  });

  it('refuses a customer who posts the callback anyway', async () => {
    // Not drawn is not closed: `callback_data` is unsigned. And the answer is
    // the main menu rather than «شما ادمین نیستید», because confirming that an
    // admin surface exists is the one thing a probe is after.
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);

    const out = await handleUpdate(db, press(updateId, telegramId, 'emj'));

    expect(out.replies[0]?.text ?? '').not.toContain('ایموجی پریمیوم');
  });
});

describe('giving the bot an emoji', () => {
  it('stores what was sent and offers it back as a drawn button', async () => {
    const { telegramId } = ids();
    await makeCustomer(telegramId);
    await makeAdmin(telegramId);

    await handleUpdate(db, press(ids().updateId, telegramId, 'emja'));
    const saved = await handleUpdate(db, sentEmoji(ids().updateId, telegramId));

    expect(saved.status).toBe('processed');
    expect(saved.replies[0]?.text ?? '').toContain('ذخیره شد');
    // The button carries the TAG, which `keyboardFor` turns into the button's
    // icon on the way out. That is what makes this screen the live proof.
    const drawn = (saved.replies[0]?.keyboard ?? []).flat().map((b) => b.text);
    expect(drawn.some((t) => t.includes(FIRE_ID))).toBe(true);
  });

  it('says so plainly when the message held no premium emoji', async () => {
    const { telegramId } = ids();
    await makeCustomer(telegramId);
    await makeAdmin(telegramId);
    await handleUpdate(db, press(ids().updateId, telegramId, 'emja'));

    const plain = ids();
    const out = await handleUpdate(db, {
      update_id: plain.updateId,
      message: {
        message_id: plain.updateId,
        from: { id: telegramId },
        chat: { id: telegramId },
        text: '🔥',
      },
    });

    expect(out.replies[0]?.text ?? '').toContain('ایموجی پریمیومی نبود');
  });
});

describe('putting it on a button', () => {
  it('writes the shop’s own layout, in the shape the send path can draw', async () => {
    const { telegramId } = ids();
    await makeCustomer(telegramId);
    await makeAdmin(telegramId);
    await handleUpdate(db, press(ids().updateId, telegramId, 'emja'));
    await handleUpdate(db, sentEmoji(ids().updateId, telegramId));

    const row = await db
      .prepare(
        `SELECT i.id FROM emoji_pack_items i JOIN emoji_packs p ON p.id = i.pack_id
          WHERE p.set_name = '__from_bot__'`,
      )
      .first<{ id: number }>();

    // First press: which button. Second: that one.
    const pick = await handleUpdate(db, press(ids().updateId, telegramId, `emjb:${row!.id}`));
    expect(pick.replies[0]?.text ?? '').toContain('کدام دکمه');

    // Slot 1, the first DECLARED button. A zero would not even decode —
    // `parseId` refuses one — and that is deliberate: the slot indexes the
    // action list in the source, so it cannot move when a layout is edited.
    const applied = await handleUpdate(db, press(ids().updateId, telegramId, `emjb:${row!.id}:1`));
    expect(applied.replies[0]?.text ?? '').toContain('نشست');

    // Slot 1 is the first DECLARED action — `renew` — so that is the row to
    // read. Reading «any row of main» passed by luck while only one existed.
    const saved = await db
      .prepare(`SELECT action, label FROM bot_keyboard_buttons
                 WHERE menu = 'main' AND action = 'renew'`)
      .first<{ action: string; label: string }>();
    // The tag is at the FRONT — the only place a button has an icon slot.
    expect(saved?.label.startsWith(`<tg-emoji emoji-id="${FIRE_ID}">`)).toBe(true);
    expect(saved?.label).not.toBe('');
  });

  it('leaves the rest of the menu alone on a shop that never arranged it', async () => {
    // The bug this pins is the worst one in the branch, and no test of this
    // feature could have found it: a saved layout REPLACES the shipped one, so
    // writing a single row made that button the entire menu — for every
    // customer. It was found by `buy.test` going red, a suite that does not
    // mention emoji.
    const { telegramId } = ids();
    await makeCustomer(telegramId);
    await makeAdmin(telegramId);
    await handleUpdate(db, press(ids().updateId, telegramId, 'emja'));
    await handleUpdate(db, sentEmoji(ids().updateId, telegramId));
    const row = await db
      .prepare(
        `SELECT i.id FROM emoji_pack_items i JOIN emoji_packs p ON p.id = i.pack_id
          WHERE p.set_name = '__from_bot__'`,
      )
      .first<{ id: number }>();

    await handleUpdate(db, press(ids().updateId, telegramId, `emjb:${row!.id}:1`));

    const { results } = await db
      .prepare(`SELECT action FROM bot_keyboard_buttons WHERE menu = 'main'`)
      .all<{ action: string }>();
    // Every shipped button is still there, not just the one that was touched.
    expect(results?.length).toBe(DEFAULT_LAYOUTS.main.length);
    expect(results?.map((r) => r.action)).toContain('buy');

    // And the customer's own menu still holds them.
    invalidateBotContent();
    const started = await handleUpdate(db, {
      update_id: ids().updateId,
      message: {
        message_id: 1,
        from: { id: telegramId },
        chat: { id: telegramId },
        text: '/start',
      },
    });
    const rows = started.replies[0]?.replyKeyboard;
    const labels = (Array.isArray(rows) ? rows : []).flat().map((b) => b.text);
    expect(labels.some((l) => l.includes('خرید'))).toBe(true);
  });

  it('says it did not fit instead of throwing a constraint at the admin', async () => {
    // Found by review, not by me. `setButtonEmoji` checked the SHAPE of the
    // composed label and not its length, so a button already near the cap went
    // over it — and the only thing that noticed was the CHECK from 0053, as an
    // exception out of an admin's button press with a constraint name for a
    // message.
    //
    // 64 is the cap, measured on what is drawn. The glyph and its space add
    // two, so a 63-character label cannot take one.
    const { telegramId } = ids();
    await makeCustomer(telegramId);
    await makeAdmin(telegramId);
    // The WHOLE layout, with one label lengthened — a single row would make
    // that button the entire menu, which is the bug the test above pins.
    for (const b of DEFAULT_LAYOUTS.main) {
      await db
        .prepare(
          `INSERT INTO bot_keyboard_buttons (menu, action, label, row_index, col_index, visible)
           VALUES ('main', ?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(
          b.action,
          b.action === 'renew' ? 'ت'.repeat(63) : b.label,
          b.rowIndex,
          b.colIndex,
          b.visible,
        )
        .run();
    }
    invalidateBotContent();

    await handleUpdate(db, press(ids().updateId, telegramId, 'emja'));
    await handleUpdate(db, sentEmoji(ids().updateId, telegramId));
    const row = await db
      .prepare(
        `SELECT i.id FROM emoji_pack_items i JOIN emoji_packs p ON p.id = i.pack_id
          WHERE p.set_name = '__from_bot__'`,
      )
      .first<{ id: number }>();

    const out = await handleUpdate(db, press(ids().updateId, telegramId, `emjb:${row!.id}:1`));

    // A sentence, not a stack trace — and the button is untouched.
    expect(out.replies[0]?.text ?? '').toContain('جا نشد');
    const saved = await db
      .prepare(`SELECT label FROM bot_keyboard_buttons WHERE menu = 'main' AND action = 'renew'`)
      .first<{ label: string }>();
    expect(saved?.label).toBe('ت'.repeat(63));
  });

  it('swaps the emoji instead of stacking a second one', async () => {
    // A button has one icon slot. Two tags would mean the second is silently
    // dropped at send time and the admin is looking at a label they cannot
    // explain.
    const { telegramId } = ids();
    await makeCustomer(telegramId);
    await makeAdmin(telegramId);
    await handleUpdate(db, press(ids().updateId, telegramId, 'emja'));
    await handleUpdate(db, sentEmoji(ids().updateId, telegramId));
    await handleUpdate(db, press(ids().updateId, telegramId, 'emja'));
    await handleUpdate(db, sentEmoji(ids().updateId, telegramId, '5237699328843200968'));

    const { results } = await db
      .prepare(
        `SELECT i.id FROM emoji_pack_items i JOIN emoji_packs p ON p.id = i.pack_id
          WHERE p.set_name = '__from_bot__' ORDER BY i.id`,
      )
      .all<{ id: number }>();
    const [first, second] = results ?? [];

    await handleUpdate(db, press(ids().updateId, telegramId, `emjb:${first!.id}:1`));
    await handleUpdate(db, press(ids().updateId, telegramId, `emjb:${second!.id}:1`));

    const saved = await db
      .prepare(`SELECT label FROM bot_keyboard_buttons
                 WHERE menu = 'main' AND action = 'renew'`)
      .first<{ label: string }>();
    const tags = [...(saved?.label ?? '').matchAll(/<tg-emoji/g)];
    expect(tags).toHaveLength(1);
    expect(saved?.label).toContain('5237699328843200968');
  });
});
