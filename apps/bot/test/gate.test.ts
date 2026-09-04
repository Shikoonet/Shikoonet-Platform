/**
 * The two doors in front of the shop, judged by what the customer is sent.
 *
 * Both are switched on in production today and neither existed in this bot until
 * now. `packages/migrate/test/gates.mysql.test.ts` is the outside truth — that
 * `roll_Status` really spells "on" as `rolleon`, that there really is a channel,
 * and that its row carries a `@handle` Telegram will accept. This file only
 * proves the bot obeys them.
 *
 * ## The two properties worth more than the feature
 *
 * **It fails open.** `function.php:622` records a customer as missing from a
 * channel only when Telegram answered `ok`, so an error lets everybody through.
 * Kept deliberately: letting a non-member browse for an hour costs nothing,
 * refusing every paying customer because one API call timed out costs the day.
 *
 * **It cannot be walked past.** The gate sits at the same single point as the
 * closed sign, because `callback_data` is a field anyone can post and a gate
 * that only guards `/start` guards nothing.
 *
 * ## Cleaning up after itself
 *
 * `required_channels` and `settings` are shop-wide, and a leftover row here
 * gates every customer in the file that runs next. Three separate "green only on
 * a fresh database" bugs in this suite have had exactly that shape, so the
 * teardown is not politeness.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSchema, db } from './helpers/env.js';
import { ensureCatalog, ensurePaymentCard, makeCustomer, planId } from './helpers/shop.js';
import { handleUpdate } from '../src/handle.js';
import { invalidateShopSettings } from '../src/settings.js';
import { MEMBERSHIP_TTL_MS, type MembershipApi } from '../src/gate.js';
import { invalidateBotContent } from '../src/botContent.js';
import * as menu from '../src/menu.js';

/** Its own block of ids, so nothing here can collide with another file's. */
const BASE_TELEGRAM = 662_000;
const BASE_UPDATE = 662_000_000;
let nextId = 0;
function ids(): { updateId: number; telegramId: number } {
  const n = ++nextId;
  return { updateId: BASE_UPDATE + n, telegramId: BASE_TELEGRAM + n };
}

const CHANNEL = { title: 'کانال شیکو', chatRef: '@gate_test_channel', link: 'https://t.me/x' };

function startUpdate(updateId: number, telegramId: number, payload = '') {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: telegramId, username: `g${telegramId}` },
      chat: { id: telegramId },
      text: payload === '' ? '/start' : `/start ${payload}`,
    },
  };
}

function press(updateId: number, telegramId: number, data: string) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `g${telegramId}` },
      message: { message_id: 9191, chat: { id: telegramId } },
      data,
    },
  };
}

/**
 * A Telegram that answers about membership, and counts how often it was asked.
 *
 * The count is an assertion of its own: the whole reason
 * `users.channels_checked_at` exists is to keep this number near one per
 * customer per hour instead of one per button press.
 */
function membership(answer: string | (() => never)): MembershipApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getChatMember(chatRef) {
      calls.push(chatRef);
      if (typeof answer === 'function') return answer();
      return answer;
    },
  };
}

async function addChannel(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO required_channels (title, chat_ref, join_link) VALUES (?1, ?2, ?3)
       ON CONFLICT (chat_ref) DO UPDATE SET active = true`,
    )
    .bind(CHANNEL.title, CHANNEL.chatRef, CHANNEL.link)
    .run();
}

async function requireRules(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (scope, key, value) VALUES ('bot', 'roll_Status', '"rolleon"'::jsonb)
       ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
    )
    .run();
  invalidateShopSettings();
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

async function checkedAt(telegramId: number): Promise<string | null> {
  const row = await db
    .prepare(`SELECT channels_checked_at FROM users WHERE telegram_id = ?1`)
    .bind(telegramId)
    .first<{ channels_checked_at: string | null }>();
  return row?.channels_checked_at ?? null;
}

async function rulesAccepted(telegramId: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT rules_accepted FROM users WHERE telegram_id = ?1`)
    .bind(telegramId)
    .first<{ rules_accepted: boolean }>();
  return row?.rules_accepted ?? false;
}

const buttons = (rows: { text: string; url?: string; callback_data?: string }[][] | undefined) =>
  (rows ?? []).flat();

/**
 * Channels this file did not create, switched off for its duration.
 *
 * Every assertion below counts `getChatMember` calls or asserts which screen
 * comes back, and both answers change if ANY other channel is active — so
 * deleting only its own rows left this file's result depending on what some
 * other package's suite happened to leave behind. It did: a guard-removal probe
 * in `dashboard-worker/test/channels.test.ts` wrote a row its purge did not
 * match, and five tests here went red on a channel they had never heard of.
 *
 * Switched off and switched back rather than deleted, because one of them is
 * the shop's real `@shikoonet` row from the migration and this file does not
 * own it.
 */
let borrowed: number[] = [];

beforeAll(async () => {
  await assertSchema();
  await ensureCatalog();
  await ensurePaymentCard();
  const { results } = await db
    .prepare(`SELECT id FROM required_channels WHERE active AND chat_ref NOT LIKE '@gate_test%'`)
    .all<{ id: number }>();
  borrowed = results.map((r) => Number(r.id));
  if (borrowed.length > 0) {
    await db
      .prepare(`UPDATE required_channels SET active = false WHERE id = ANY(?1)`)
      .bind(borrowed)
      .run();
  }
});

beforeEach(async () => {
  await db.prepare(`DELETE FROM required_channels WHERE chat_ref LIKE '@gate_test%'`).run();
  await db.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = 'roll_Status'`).run();
  await db
    .prepare(`DELETE FROM admins WHERE telegram_id BETWEEN ?1 AND ?2`)
    .bind(BASE_TELEGRAM, BASE_TELEGRAM + 9999)
    .run();
  invalidateShopSettings();
  invalidateBotContent();
  menu.resetContent();
});

afterEach(async () => {
  // Shop-wide rows, removed whether the test passed or threw. A leftover
  // `rolleon` puts a rules screen in front of every customer in the next file.
  await db.prepare(`DELETE FROM required_channels WHERE chat_ref LIKE '@gate_test%'`).run();
  await db.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = 'roll_Status'`).run();
  await db
    .prepare(`DELETE FROM admins WHERE telegram_id BETWEEN ?1 AND ?2`)
    .bind(BASE_TELEGRAM, BASE_TELEGRAM + 9999)
    .run();
  invalidateShopSettings();
  vi.restoreAllMocks();
});

afterAll(async () => {
  // CASCADE, because this file now buys things. Until the receipt tests below
  // it only ever created bare users, so a plain DELETE was enough; the first
  // customer with an order turned the teardown into a foreign-key error that
  // failed the file after every test in it had passed.
  await db
    .prepare(
      `DELETE FROM users WHERE telegram_id BETWEEN ?1 AND ?2
         AND id NOT IN (SELECT user_id FROM orders)`,
    )
    .bind(BASE_TELEGRAM, BASE_TELEGRAM + 9999)
    .run();
  // The ones with orders, in dependency order.
  const { results } = await db
    .prepare(`SELECT id FROM users WHERE telegram_id BETWEEN ?1 AND ?2`)
    .bind(BASE_TELEGRAM, BASE_TELEGRAM + 9999)
    .all<{ id: number }>();
  const ours = (results ?? []).map((r) => Number(r.id));
  if (ours.length > 0) {
    await db
      .prepare(
        `DELETE FROM payment_claims WHERE external_order_id IN
           (SELECT 'shikoo:' || public_id FROM payments WHERE user_id = ANY(?1))`,
      )
      .bind(ours)
      .run();
    await db.prepare(`DELETE FROM payments WHERE user_id = ANY(?1)`).bind(ours).run();
    await db.prepare(`DELETE FROM orders WHERE user_id = ANY(?1)`).bind(ours).run();
    await db.prepare(`DELETE FROM users WHERE id = ANY(?1)`).bind(ours).run();
  }
  if (borrowed.length > 0) {
    await db
      .prepare(`UPDATE required_channels SET active = true WHERE id = ANY(?1)`)
      .bind(borrowed)
      .run();
  }
});

describe('the channel gate', () => {
  it('still tidies the chat for the customer it is holding back', async () => {
    // Found by review on PR #99, and it is the worst chat to leave untidy: a
    // customer who has not joined the channel yet is the one who presses
    // /start again and again, so every attempt would pile up on the one screen
    // that has nothing on it but a wall.
    //
    // `handleStart` returns the gate screen from an EARLIER return than the
    // welcome, so a `deletes` attached only to the welcome never reached them.
    await addChannel();
    const { updateId, telegramId } = ids();

    const out = await handleUpdate(
      db,
      startUpdate(updateId, telegramId),
      globalThis.fetch,
      membership('left'),
    );

    expect(out.replies[0]!.text).toBe(menu.gateChannels());
    expect(out.deletes ?? []).toEqual([{ chatId: telegramId, messageId: updateId }]);
  });

  it('stops a customer who is not in the channel, and offers the way in', async () => {
    await addChannel();
    const { updateId, telegramId } = ids();
    const api = membership('left');

    const out = await handleUpdate(db, startUpdate(updateId, telegramId), globalThis.fetch, api);

    expect(api.calls).toEqual([CHANNEL.chatRef]);
    expect(out.replies).toHaveLength(1);
    expect(out.replies[0]!.text).toBe(menu.gateChannels());
    // The channel's own name on a link button, above the shop's chrome — the
    // shape `index.php:434` draws. A gate with no way through it is a wall.
    const drawn = buttons(out.replies[0]!.keyboard);
    expect(drawn[0]).toEqual({ text: CHANNEL.title, url: CHANNEL.link });
    expect(drawn.at(-1)!.callback_data).toBe('chk');
  });

  it('cannot be walked past with a button press', async () => {
    await addChannel();
    const { telegramId } = ids();
    await makeCustomer(telegramId);
    const api = membership('left');

    // `buy` is a perfectly ordinary button, and this customer has a row — so
    // nothing but the gate stands between them and the catalogue.
    const out = await handleUpdate(
      db,
      press(BASE_UPDATE + 500, telegramId, 'buy'),
      globalThis.fetch,
      api,
    );

    expect(out.replies[0]!.text).toBe(menu.gateChannels());
  });

  it('lets a member through, and remembers that it asked', async () => {
    await addChannel();
    const { updateId, telegramId } = ids();
    const api = membership('member');

    const out = await handleUpdate(db, startUpdate(updateId, telegramId), globalThis.fetch, api);

    expect(out.replies[0]!.text).toBe(menu.WELCOME);
    expect(await checkedAt(telegramId)).not.toBeNull();
  });

  it('does not remember asking when the answer was no', async () => {
    // The stamp is what opens the door for the next hour. Writing it for a
    // customer who is NOT in the channel would let them straight past on their
    // second message — the gate firing exactly once, for one screen.
    await addChannel();
    const { updateId, telegramId } = ids();

    await handleUpdate(db, startUpdate(updateId, telegramId), globalThis.fetch, membership('left'));

    expect(await checkedAt(telegramId)).toBeNull();
  });

  it('asks Telegram once an hour, not once a button press', async () => {
    await addChannel();
    const { updateId, telegramId } = ids();
    const api = membership('member');

    await handleUpdate(db, startUpdate(updateId, telegramId), globalThis.fetch, api);
    await handleUpdate(db, press(updateId + 100, telegramId, 'buy'), globalThis.fetch, api);
    await handleUpdate(db, press(updateId + 101, telegramId, 'wal'), globalThis.fetch, api);
    expect(api.calls).toHaveLength(1);

    // An hour and a second later the door has closed again and it re-asks. The
    // clock is pinned rather than the row backdated, so this measures the
    // constant the code reads and not a timestamp this test invented.
    const later = Date.now() + MEMBERSHIP_TTL_MS + 1000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await handleUpdate(db, press(updateId + 102, telegramId, 'buy'), globalThis.fetch, api);
    expect(api.calls).toHaveLength(2);
  });

  it('lets everyone through when Telegram will not answer', async () => {
    // The property that decides whether this feature is safe to ship. A bot
    // that is not an admin of the channel, a `chat_ref` with a typo in it, and a
    // Telegram that timed out all arrive here, and none of them is evidence
    // about this customer.
    await addChannel();
    const { updateId, telegramId } = ids();
    const api = membership(() => {
      throw new Error('telegram getChatMember rejected: chat not found');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const out = await handleUpdate(db, startUpdate(updateId, telegramId), globalThis.fetch, api);

    expect(api.calls).toHaveLength(1);
    expect(out.replies[0]!.text).toBe(menu.WELCOME);
    // And it does not pretend it confirmed anything: the next update asks again.
    expect(await checkedAt(telegramId)).toBeNull();
  });

  it('does not call Telegram at all when the shop requires no channel', async () => {
    const { updateId, telegramId } = ids();
    const api = membership('left');

    const out = await handleUpdate(db, startUpdate(updateId, telegramId), globalThis.fetch, api);

    expect(api.calls).toEqual([]);
    expect(out.replies[0]!.text).toBe(menu.WELCOME);
    // Not stamped either. The day an admin adds the first channel, every
    // customer must be asked — not held open by a timestamp that answered a
    // different question.
    expect(await checkedAt(telegramId)).toBeNull();
  });

  it('exempts an admin, so the cutover window is still walkable', async () => {
    await addChannel();
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    await makeAdmin(telegramId);
    const api = membership('left');

    const out = await handleUpdate(db, startUpdate(updateId, telegramId), globalThis.fetch, api);

    expect(out.replies[0]!.text).toBe(menu.WELCOME);
    expect(api.calls).toEqual([]);
  });

  it('exempts an admin on a button press too, not only on /start', async () => {
    // Its own test because it is its own guard, in a different function. The
    // cutover window is an announced pause where the shop stops selling and the
    // people running it walk every screen — and they reach those screens by
    // pressing buttons, not by typing /start before each one.
    await addChannel();
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    await makeAdmin(telegramId);
    const api = membership('left');

    const out = await handleUpdate(db, press(updateId, telegramId, 'wal'), globalThis.fetch, api);

    expect(out.replies[0]!.text).not.toBe(menu.gateChannels());
    expect(api.calls).toEqual([]);
  });

  it('records the referrer before it turns the customer away', async () => {
    // Everything /start does before the gate — the session reset, and who
    // invited them — cannot be recovered by asking again once they have joined.
    // The live bot loses exactly this and has to dig the referrer back out of a
    // scratch column afterwards (`index.php:450`).
    await addChannel();
    const inviter = ids();
    const inviterId = await makeCustomer(inviter.telegramId);
    const arrival = ids();

    const out = await handleUpdate(
      db,
      // The payload is the inviter's `users.id`, which is what `referralLink`
      // puts in it — not their telegram id.
      startUpdate(arrival.updateId, arrival.telegramId, String(inviterId)),
      globalThis.fetch,
      membership('left'),
    );

    expect(out.replies[0]!.text).toBe(menu.gateChannels());
    const row = await db
      .prepare(`SELECT referred_by FROM users WHERE telegram_id = ?1`)
      .bind(arrival.telegramId)
      .first<{ referred_by: number | null }>();
    expect(row?.referred_by).toBe(inviterId);
  });
});

describe('«عضو شدم»', () => {
  it('is answered by Telegram, not by the press', async () => {
    await addChannel();
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const api = membership('left');

    const out = await handleUpdate(db, press(updateId, telegramId, 'chk'), globalThis.fetch, api);

    expect(api.calls).toEqual([CHANNEL.chatRef]);
    expect(await checkedAt(telegramId)).toBeNull();
    // A different sentence from the first refusal. Re-sending the identical text
    // reads as a bot that ignored the press — and drawn as an edit, Telegram
    // refuses it outright as "message is not modified".
    expect(out.replies[0]!.text).toBe(menu.gateChannels(true));
    expect(out.replies[0]!.text).not.toBe(menu.gateChannels());
  });

  it('opens the shop once the customer really has joined', async () => {
    await addChannel();
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);

    const out = await handleUpdate(
      db,
      press(updateId, telegramId, 'chk'),
      globalThis.fetch,
      membership('creator'),
    );

    expect(out.replies[0]!.text).toBe(menu.WELCOME);
    expect(await checkedAt(telegramId)).not.toBeNull();
  });

  it('quotes the button by its live label, not by a copy of its wording', async () => {
    // An admin who renames «عضو شدم» in the panel would otherwise leave the
    // sentence pointing at a button that no longer exists, and nothing about the
    // result looks broken. Same coupling `{renewButton}` and `{paidButton}` fix.
    await addChannel();
    await db
      .prepare(
        `INSERT INTO bot_keyboard_buttons (menu, action, label, row_index, col_index, visible)
         VALUES ('gateChannels', 'chk', ?1, 0, 0, true)
         ON CONFLICT (menu, action) DO UPDATE SET label = excluded.label`,
      )
      .bind('پیوستم 🚀')
      .run();
    invalidateBotContent();
    try {
      const { updateId, telegramId } = ids();
      const out = await handleUpdate(
        db,
        startUpdate(updateId, telegramId),
        globalThis.fetch,
        membership('left'),
      );
      expect(out.replies[0]!.text).toContain('پیوستم 🚀');
      expect(buttons(out.replies[0]!.keyboard).at(-1)!.text).toBe('پیوستم 🚀');
    } finally {
      await db.prepare(`DELETE FROM bot_keyboard_buttons WHERE menu = 'gateChannels'`).run();
      invalidateBotContent();
    }
  });
});

describe('the rules gate', () => {
  it('stays down until the shop switches it on', async () => {
    // 963 customers are behind this in production, and the default is off: a
    // settings read that fails must not put a screen in front of all of them
    // that only an admin can take back down.
    const { updateId, telegramId } = ids();

    const out = await handleUpdate(db, startUpdate(updateId, telegramId), globalThis.fetch);

    expect(out.replies[0]!.text).toBe(menu.WELCOME);
    expect(await rulesAccepted(telegramId)).toBe(false);
  });

  it('shows the rules, and nothing else, once it is on', async () => {
    await requireRules();
    const { updateId, telegramId } = ids();

    const out = await handleUpdate(db, startUpdate(updateId, telegramId), globalThis.fetch);

    expect(out.replies[0]!.text).toBe(menu.GATE_RULES);
    expect(buttons(out.replies[0]!.keyboard).map((b) => b.callback_data)).toEqual(['acc']);
  });

  it('opens the shop when the customer accepts, and remembers it', async () => {
    await requireRules();
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);

    const out = await handleUpdate(db, press(updateId, telegramId, 'acc'), globalThis.fetch);

    expect(await rulesAccepted(telegramId)).toBe(true);
    expect(out.replies[0]!.text).toContain(menu.GATE_RULES_ACCEPTED);
    expect(out.replies[0]!.text).toContain(menu.WELCOME);
  });

  it('cannot be used to skip the channel', async () => {
    // Both gates are on and the customer is outside the channel. Accepting the
    // rules is the one thing they are allowed to do, and doing it must not let
    // them past the door in front of it.
    await addChannel();
    await requireRules();
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);

    const out = await handleUpdate(
      db,
      press(updateId, telegramId, 'acc'),
      globalThis.fetch,
      membership('left'),
    );

    expect(await rulesAccepted(telegramId)).toBe(true);
    // The first refusal's wording, not the retry's: «قبول دارم» is not a second
    // attempt at «عضو شدم», and this is the first time this customer has been
    // shown the channel screen.
    expect(out.replies[0]!.text).toBe(menu.gateChannels());
  });

  it('asks for the channel first when both are owed', async () => {
    await addChannel();
    await requireRules();
    const { updateId, telegramId } = ids();

    const out = await handleUpdate(
      db,
      startUpdate(updateId, telegramId),
      globalThis.fetch,
      membership('left'),
    );

    expect(out.replies[0]!.text).toBe(menu.gateChannels());
  });

  it('exempts an admin', async () => {
    await requireRules();
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    await makeAdmin(telegramId);

    const out = await handleUpdate(db, startUpdate(updateId, telegramId), globalThis.fetch);

    expect(out.replies[0]!.text).toBe(menu.WELCOME);
  });
});

/**
 * The one thing that must get through a closed gate.
 *
 * A receipt is not a purchase. It is the second half of one that already
 * happened — the customer has sent money to a card and this is the only
 * evidence of it. Somebody who left the channel between paying and uploading
 * would otherwise be shown "join the channel", which is not what is wrong and
 * cannot be acted on: joining does not deliver the receipt they are holding.
 *
 * The gate stays in front of everything that STARTS a purchase.
 */
describe('a receipt is not stopped by the gate', () => {
  /** Buys and presses «پرداخت کردم» while the shop has no gate yet. */
  async function buyThenClaim(): Promise<{ telegramId: number; updateId: number }> {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const plan = await planId('sim-vip-1m-50');

    await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
    const order = await db
      .prepare(`SELECT id FROM orders WHERE user_id = ?1 ORDER BY id DESC LIMIT 1`)
      .bind(userId)
      .first<{ id: number }>();
    await handleUpdate(db, press(updateId + 1, telegramId, `paid:${order!.id}`));
    return { telegramId, updateId };
  }

  function sendsPhoto(updateId: number, telegramId: number) {
    return {
      update_id: updateId,
      message: {
        message_id: updateId,
        chat: { id: telegramId },
        from: { id: telegramId, username: `g${telegramId}` },
        photo: [{ file_id: 'AgACAgQAAxkBAAIBgate0001' }],
      },
    };
  }

  it('lets a customer who has left the channel still send their receipt', async () => {
    // Bought and clicked «پرداخت کردم» while the shop was open to them...
    const { telegramId, updateId } = await buyThenClaim();
    // ...and by the time the receipt is in their hand, they are not a member.
    await addChannel();
    const api = membership('left');

    const out = await handleUpdate(db, sendsPhoto(updateId + 2, telegramId), globalThis.fetch, api);

    expect(out.replies[0]!.text).not.toBe(menu.gateChannels());
    expect(out.replies[0]!.text).toContain('رسید');
    // The gate did not merely pass them — it was never consulted, so a Telegram
    // that is down or a channel row that is wrong cannot break this path either.
    expect(api.calls).toEqual([]);
  });

  it('still refuses to let a receipt buy anything', async () => {
    // The bypass is scoped to the receipt itself. Somebody outside the channel
    // who sends a photo gets told nothing is waiting — no order, no card, no
    // way in. Without this the gate would be one photo wide.
    await addChannel();
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);

    // +500 and +501: `ids()` steps by one, and the test above consumes three
    // update ids from its own base. A collision here is silently a duplicate,
    // which answers with no replies and reads as a broken assertion.
    const out = await handleUpdate(
      db,
      sendsPhoto(updateId + 500, telegramId),
      globalThis.fetch,
      membership('left'),
    );
    expect(out.replies[0]!.text).toBe(menu.RECEIPT_NOTHING_WAITING);

    // And the moment they try to actually start something, the gate is there.
    const browse = await handleUpdate(
      db,
      startUpdate(updateId + 501, telegramId),
      globalThis.fetch,
      membership('left'),
    );
    expect(browse.replies[0]!.text).toBe(menu.gateChannels());
  });
});
