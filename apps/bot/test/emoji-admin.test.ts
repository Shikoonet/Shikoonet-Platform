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
import { customEmojiIn, setButtonEmoji } from '../src/emoji.js';
import { DEFAULT_LAYOUTS } from '@shikoo/contracts';

const FIRE_ID = '5368324170671202286';

let nextId = 0;
function ids(): { updateId: number; telegramId: number } {
  const n = ++nextId * 10;
  return { updateId: 655_000 + n, telegramId: 555_000 + n };
}

async function makeAdmin(telegramId: number, role = 'ADMIN'): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admins (telegram_id, role, active) VALUES (?1, ?2, true)
       ON CONFLICT (telegram_id) DO UPDATE SET active = true, role = EXCLUDED.role`,
    )
    .bind(telegramId, role)
    .run();
}

/** Whether the shop's menu offers this person the emoji screen. */
async function seesEmojiButton(telegramId: number): Promise<boolean> {
  const out = await handleUpdate(db, {
    update_id: ids().updateId,
    message: {
      message_id: 1,
      from: { id: telegramId },
      chat: { id: telegramId },
      text: '/start',
    },
  });
  const rows = out.replies[0]?.replyKeyboard;
  return (Array.isArray(rows) ? rows : [])
    .flat()
    .some((b) => b.text.includes('ایموجی پریمیوم'));
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

  it('is not drawn for SUPPORT, who may walk the shop but not reshape it', async () => {
    // Sam: «برای همه نشان داده می‌شود، فقط باید برای ادمین‌ها و owner باشد.»
    // `admins.role` has held OWNER / ADMIN / SUPPORT since 0001 and the bot's
    // check ignored it, so anybody in the table — support staff included — was
    // offered a screen that changes what every customer sees.
    //
    // `isActiveAdmin` is deliberately NOT narrowed with it: support still walks
    // past the closed sign, the flood counter and the channel gate, because
    // answering a customer at 2am needs all three. Seeing the shop and changing
    // it are different permissions.
    const { telegramId } = ids();
    await makeCustomer(telegramId);
    await makeAdmin(telegramId, 'SUPPORT');
    expect(await seesEmojiButton(telegramId)).toBe(false);
  });

  it('is drawn for OWNER', async () => {
    const { telegramId } = ids();
    await makeCustomer(telegramId);
    await makeAdmin(telegramId, 'OWNER');
    expect(await seesEmojiButton(telegramId)).toBe(true);
  });

  it('refuses SUPPORT who posts the callback anyway', async () => {
    // Undrawn is not closed, for a role as much as for a stranger.
    const { telegramId } = ids();
    await makeCustomer(telegramId);
    await makeAdmin(telegramId, 'SUPPORT');
    const out = await handleUpdate(db, press(ids().updateId, telegramId, 'emj'));
    expect(out.replies[0]?.text ?? '').not.toContain('کدام دکمه');
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

describe('the order the screens ask in', () => {
  it('opens on the BUTTONS, and puts the emoji on with one press', async () => {
    // Sam, 2026-09-03: «برم تو منوی ایموجی، منو رو انتخاب کنم، و وقتی ایموجی‌ای
    // که می‌خوام رو می‌زنم همون جایگزین بشه». The first build asked for the
    // emoji first and then where to put it, which reads backwards: an admin
    // arrives already knowing which button they are unhappy with.
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

    // 1. the menu opens on the shop's own buttons
    const home = await handleUpdate(db, press(ids().updateId, telegramId, 'emj'));
    expect(home.replies[0]?.text ?? '').toContain('کدام دکمه');
    const labels = (home.replies[0]?.keyboard ?? []).flat().map((b) => b.text);
    expect(labels.some((l) => l.includes('تمدید'))).toBe(true);

    // 2. one press later, that button's tiles
    const one = await handleUpdate(db, press(ids().updateId, telegramId, 'emjb:1'));
    expect((one.replies[0]?.keyboard ?? []).flat().some((b) => b.text.includes(FIRE_ID))).toBe(true);

    // 3. and pressing a tile swaps it, on the same screen
    const done = await handleUpdate(db, press(ids().updateId, telegramId, `emjb:1:${row!.id}`));
    expect(done.replies[0]?.text ?? '').toContain('عوض شد');
    const saved = await db
      .prepare(`SELECT label FROM bot_keyboard_buttons WHERE menu = 'main' AND action = 'renew'`)
      .first<{ label: string }>();
    expect(saved?.label).toContain(FIRE_ID);
  });
});

describe('giving the bot an emoji', () => {
  it('offers it straight back as a drawn tile, on the button it came from', async () => {
    const { telegramId } = ids();
    await makeCustomer(telegramId);
    await makeAdmin(telegramId);

    // «افزودن» pressed from a BUTTON's screen carries that button's slot, so
    // the emoji the admin just gave the bot is one tap from being on it.
    await handleUpdate(db, press(ids().updateId, telegramId, 'emja:1'));
    const saved = await handleUpdate(db, sentEmoji(ids().updateId, telegramId));

    expect(saved.status).toBe('processed');
    // Back on that button's screen, not on the button list.
    expect(saved.replies[0]?.text ?? '').toContain('تمدید');
    // The tile carries the TAG, which `keyboardFor` turns into the button's
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
    // First press: that button's screen, with every emoji as a tile.
    const pick = await handleUpdate(db, press(ids().updateId, telegramId, 'emjb:1'));
    expect(pick.replies[0]?.text ?? '').toContain('تمدید');

    // `emjb:<slot>:<emojiId>` — the button first, then the emoji, which is the
    // order the screens ask in. Slot 1 is the first DECLARED button; a zero
    // would not even decode, since `parseId` refuses one.
    const applied = await handleUpdate(db, press(ids().updateId, telegramId, `emjb:1:${row!.id}`));
    expect(applied.replies[0]?.text ?? '').toContain('عوض شد');

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

    await handleUpdate(db, press(ids().updateId, telegramId, `emjb:1:${row!.id}`));

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

  it('writes the label even when another writer seeded the layout first', async () => {
    // The race the review named, staged rather than approximated.
    //
    // `setButtonEmoji` asks whether any layout is saved, and seeds the shipped
    // one when the answer is no. Every insert in that loop is DO NOTHING, so a
    // layout written by somebody else in between — a second admin, or the panel
    // saving — turns all of them into no-ops, the target's included. The old
    // code returned «placed» at that point without looking.
    //
    // The interleaving is produced by answering the question truthfully and
    // then, before the caller can act on the answer, doing what the other
    // writer would have done. That is exactly the window, and nothing else in
    // this suite can reach it: by the time a test can insert rows, the check
    // has either not run or already passed.
    let seeded = false;
    const racing = {
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        if (!sql.includes('SELECT 1 AS present')) return stmt;
        return {
          ...stmt,
          bind: (...args: unknown[]) => stmt.bind(...(args as never[])),
          first: async <T>() => {
            const answer = await stmt.first<T>();
            if (!seeded) {
              seeded = true;
              // Somebody else's COMPLETE layout, target button included. That
              // is what makes every insert in the loop below a no-op — a first
              // draft of this test had the racer omit `renew`, so our own
              // insert succeeded and the old code was right by accident.
              for (const b of DEFAULT_LAYOUTS.main) {
                await db
                  .prepare(
                    `INSERT INTO bot_keyboard_buttons
                       (menu, action, label, row_index, col_index, visible)
                     VALUES ('main', ?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT (menu, action) DO NOTHING`,
                  )
                  .bind(b.action, b.label, b.rowIndex, b.colIndex, b.visible)
                  .run();
              }
            }
            return answer;
          },
        };
      },
    } as unknown as typeof db;

    const placed = await setButtonEmoji(racing, 'renew', '♻️ تمدید سرویس', {
      customEmojiId: FIRE_ID,
      fallbackEmoji: '🔥',
    });

    // The row has to carry OUR label. The old code returned this same string
    // without writing it, so the admin read «نشست» while the button still said
    // what the other writer had put there — which is why the assertion is on
    // the TABLE and not on the return value.
    const renew = await db
      .prepare(`SELECT label FROM bot_keyboard_buttons WHERE menu = 'main' AND action = 'renew'`)
      .first<{ label: string }>();
    expect(renew?.label).toContain(FIRE_ID);
    expect(placed).toContain(FIRE_ID);
  });

  it('does not claim success when the button is not in this shop’s layout', async () => {
    // The seeding branch used to return «placed» without looking, so a layout
    // written by somebody else between the check and the inserts — every one of
    // which is DO NOTHING — left the admin told «نشست» about a button carrying
    // another person's text.
    //
    // The race itself needs two writers and cannot be staged here without
    // hooks. What CAN be staged is the state it lands in, which is the same
    // state as «an admin removed this button from the layout on purpose»: rows
    // exist for `main`, and the target is not among them. Both now take the
    // same path, which is why one test covers the logic of both.
    const { telegramId } = ids();
    await makeCustomer(telegramId);
    await makeAdmin(telegramId);
    for (const b of DEFAULT_LAYOUTS.main.filter((x) => x.action !== 'renew')) {
      await db
        .prepare(
          `INSERT INTO bot_keyboard_buttons (menu, action, label, row_index, col_index, visible)
           VALUES ('main', ?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(b.action, b.label, b.rowIndex, b.colIndex, b.visible)
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

    // Slot 1 is `renew`, the button this shop does not have.
    const out = await handleUpdate(db, press(ids().updateId, telegramId, `emjb:1:${row!.id}`));

    expect(out.replies[0]?.text ?? '').toContain('دیگر در کیبورد');
    // And it was not quietly added back.
    const added = await db
      .prepare(`SELECT action FROM bot_keyboard_buttons WHERE menu = 'main' AND action = 'renew'`)
      .first<{ action: string }>();
    expect(added).toBeNull();
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

    const out = await handleUpdate(db, press(ids().updateId, telegramId, `emjb:1:${row!.id}`));

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

    await handleUpdate(db, press(ids().updateId, telegramId, `emjb:1:${first!.id}`));
    await handleUpdate(db, press(ids().updateId, telegramId, `emjb:1:${second!.id}`));

    const saved = await db
      .prepare(`SELECT label FROM bot_keyboard_buttons
                 WHERE menu = 'main' AND action = 'renew'`)
      .first<{ label: string }>();
    const tags = [...(saved?.label ?? '').matchAll(/<tg-emoji/g)];
    expect(tags).toHaveLength(1);
    expect(saved?.label).toContain('5237699328843200968');
  });
});
