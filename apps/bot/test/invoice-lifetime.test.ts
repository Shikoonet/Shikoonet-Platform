/**
 * An invoice lives exactly as long as the card printed on it is held.
 *
 * Until 2026-09-17 there were two clocks: `pay/card_hold_minutes` freed the
 * card after ten minutes and `bot/order_ttl_hours` kept the invoice alive for
 * twenty-four. A customer who came back from their banking app at minute
 * fifteen held a live invoice naming a card that was already in somebody
 * else's hands. Migration 0070 made it one clock, and this file is the proof:
 * the deadline is the hold, the invoice says so, and when the deadline passes
 * the invoice message itself is turned into the notice — so the card number
 * stops standing in the chat.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CARD_HOLD_MINUTES } from '@shikoo/domain';
import { handleUpdate } from '../src/handle.js';
import { enqueue, flush } from '../src/notify.js';
import { rememberInvoiceMessage } from '../src/payment.js';
import { pollOnce, run } from '../src/poll.js';
import { TelegramRejection, type TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId } from './helpers/shop.js';
import { stubApi } from './helpers/telegram.js';

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 740_000 + n, telegramId: 741_000 + n };
}

/** The screen the customer pressed «خرید» on — the message the invoice is drawn into. */
const SCREEN = 55;

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `life${telegramId}` },
      message: { message_id: SCREEN, chat: { id: telegramId } },
      data,
    },
  };
}

async function setHoldMinutes(json: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (scope, key, value) VALUES ('pay', 'card_hold_minutes', ?1::jsonb)
       ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value`,
    )
    .bind(json)
    .run();
}

async function openInvoice(telegramId: number) {
  return db
    .prepare(
      `SELECT p.public_id, p.invoice_message_id,
              o.public_id AS order_public_id, o.expires_at, o.status
         FROM payments p JOIN orders o ON o.id = p.order_id JOIN users u ON u.id = o.user_id
        WHERE u.telegram_id = ?1
        ORDER BY p.id DESC LIMIT 1`,
    )
    .bind(telegramId)
    .first<{
      public_id: string;
      invoice_message_id: number | null;
      order_public_id: string;
      expires_at: string;
      status: string;
    }>();
}

beforeAll(async () => {
  await ensureCatalog();
});

afterEach(async () => {
  await setHoldMinutes(String(DEFAULT_CARD_HOLD_MINUTES));
});

describe('the deadline on an invoice', () => {
  it('is the card hold, read from the same setting the card picker reads', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    // Not the default, so a deadline that ignored the setting could not pass
    // by coincidence; not the old 24 hours either.
    await setHoldMinutes('"7"');

    const out = await handleUpdate(
      db,
      press(updateId, telegramId, `order:${await planId('sim-vip-1m-50')}`),
    );
    const invoice = (await openInvoice(telegramId))!;

    const gap = new Date(invoice.expires_at).getTime() - Date.now();
    expect(gap).toBeGreaterThan(7 * 60_000 - 30_000);
    expect(gap).toBeLessThanOrEqual(7 * 60_000 + 30_000);
    // And the customer is told, on the invoice, in Tehran wall-clock time.
    expect(out.replies[0]?.text).toContain('فقط تا ساعت');
    // The reply is marked as the invoice, which is what lets `poll.ts`
    // remember the message it lands on.
    expect(out.replies[0]?.invoiceOf).toBe(invoice.public_id);
  });

  it('falls back to the default when the setting is zero, rather than dying at birth', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    await setHoldMinutes('"0"');

    await handleUpdate(db, press(updateId, telegramId, `order:${await planId('sim-gold-10')}`));
    const invoice = (await openInvoice(telegramId))!;

    const gap = new Date(invoice.expires_at).getTime() - Date.now();
    expect(gap).toBeGreaterThan(DEFAULT_CARD_HOLD_MINUTES * 60_000 - 30_000);
  });
});

describe('which message the invoice is', () => {
  it('is remembered from the screen the invoice was drawn into', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const plan = await planId('sim-vip-1m-20');
    const api = stubApi({ getUpdates: async () => [press(updateId, telegramId, `order:${plan}`)] });

    await pollOnce(db, api, updateId);

    expect((await openInvoice(telegramId))?.invoice_message_id).toBe(SCREEN);
  });

  it('is remembered from the id Telegram hands back when the invoice had to be a new message', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const plan = await planId('sim-vip-1m-20');
    const api = stubApi({
      getUpdates: async () => [press(updateId, telegramId, `order:${plan}`)],
      // The screen is too old to edit — Telegram's 48-hour rule — so the
      // invoice goes out as a fresh message with an id only Telegram knows.
      editMessageText: async () => {
        throw new TelegramRejection('Bad Request: message to edit not found', 400);
      },
      sendMessage: async () => ({ messageId: 777 }),
    });

    await pollOnce(db, api, updateId);

    expect((await openInvoice(telegramId))?.invoice_message_id).toBe(777);
  });

  it('is released by an older invoice when a newer one takes the same screen', async () => {
    // A customer opens an invoice, goes back, and buys something else — on the
    // same message. Two open orders, one screen. When the first expires it must
    // not overwrite the second's live invoice.
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await handleUpdate(db, press(updateId, telegramId, `order:${await planId('sim-vip-1m-50')}`));
    const first = (await openInvoice(telegramId))!;
    await handleUpdate(db, press(updateId + 1, telegramId, `order:${await planId('sim-gold-10')}`));
    const second = (await openInvoice(telegramId))!;
    expect(second.public_id).not.toBe(first.public_id);

    await rememberInvoiceMessage(db, first.public_id, SCREEN);
    await rememberInvoiceMessage(db, second.public_id, SCREEN);

    const { results } = await db
      .prepare(`SELECT public_id, invoice_message_id FROM payments WHERE user_id = ?1 ORDER BY id`)
      .bind(userId)
      .all<{ public_id: string; invoice_message_id: number | null }>();
    expect(results).toEqual([
      { public_id: first.public_id, invoice_message_id: null },
      { public_id: second.public_id, invoice_message_id: SCREEN },
    ]);
  });
});

describe('when the deadline passes', () => {
  /** Ages every deadline this customer holds, then runs one sweep cycle with no updates. */
  async function expireThrough(telegramId: number) {
    await db
      .prepare(
        `UPDATE orders o SET expires_at = now() - interval '1 minute'
           FROM users u
          WHERE o.user_id = u.id AND u.telegram_id = ?1 AND o.expires_at IS NOT NULL`,
      )
      .bind(telegramId)
      .run();
    const edited: { chatId: number; messageId: number; text: string }[] = [];
    const sent: { chatId: number; text: string }[] = [];
    const controller = new AbortController();
    const api = stubApi({
      // One cycle, no updates: only the sweeps and the outbox run.
      getUpdates: async () => {
        controller.abort();
        return [];
      },
      editMessageText: async (chatId, messageId, text) => {
        edited.push({ chatId, messageId, text });
      },
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
        return { messageId: null };
      },
    });
    await run(db, api, { signal: controller.signal, timeoutSec: 1 });
    return {
      edited: edited.filter((m) => m.chatId === telegramId),
      sent: sent.filter((m) => m.chatId === telegramId),
    };
  }

  it('turns the invoice message itself into the notice, buttons and card number gone', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const plan = await planId('sim-vip-1m-50');
    await pollOnce(
      db,
      stubApi({ getUpdates: async () => [press(updateId, telegramId, `order:${plan}`)] }),
      updateId,
    );
    const invoice = (await openInvoice(telegramId))!;
    expect(invoice.invoice_message_id).toBe(SCREEN);

    const { edited, sent } = await expireThrough(telegramId);

    expect(sent).toEqual([]);
    expect(edited).toHaveLength(1);
    expect(edited[0]?.messageId).toBe(SCREEN);
    expect(edited[0]?.text).toContain(invoice.order_public_id);
    expect(edited[0]?.text).toContain('واریز نکنید');
    expect((await openInvoice(telegramId))?.status).toBe('EXPIRED');
  });

  it('sends a new message when the bot never learned which message the invoice is', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    // Straight through the handler: no poll loop, so nothing recorded the id.
    await handleUpdate(db, press(updateId, telegramId, `order:${await planId('sim-gold-10')}`));
    expect((await openInvoice(telegramId))?.invoice_message_id).toBeNull();

    const { edited, sent } = await expireThrough(telegramId);

    expect(edited).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('واریز نکنید');
  });
});

describe('an outbox row that edits', () => {
  const CHAT = 742_900_001;

  async function statusOf(key: string): Promise<string | undefined> {
    const row = await db
      .prepare(`SELECT status FROM bot_notifications WHERE dedupe_key = ?1`)
      .bind(key)
      .first<{ status: string }>();
    return row?.status;
  }

  it('lands as a new message when Telegram refuses the edit, and is SENT', async () => {
    const key = `test:edit-refused-${Date.now()}`;
    await db.withSession((tx) =>
      enqueue(tx, { dedupeKey: key, chatId: CHAT, text: 'گذشت', editMessageId: 12 }),
    );
    const sent: string[] = [];
    const api = stubApi({
      editMessageText: async () => {
        throw new TelegramRejection('Bad Request: message to edit not found', 400);
      },
      sendMessage: async (_chatId, text) => {
        sent.push(text);
        return { messageId: null };
      },
    });

    const result = await flush(db, api, { limit: 50 });

    expect(sent).toEqual(['گذشت']);
    expect(result.failed).toBe(0);
    expect(await statusOf(key)).toBe('SENT');
  });

  it('is retried, not re-sent, when the edit fails for a reason that says nothing about the message', async () => {
    const key = `test:edit-network-${Date.now()}`;
    await db.withSession((tx) =>
      enqueue(tx, { dedupeKey: key, chatId: CHAT, text: 'گذشت', editMessageId: 12 }),
    );
    let sends = 0;
    const api = stubApi({
      editMessageText: async () => {
        throw new Error('socket hang up');
      },
      sendMessage: async () => {
        sends += 1;
        return { messageId: null };
      },
    });

    const result = await flush(db, api, { limit: 50 });

    expect(sends).toBe(0);
    expect(result.failed).toBe(1);
    expect(await statusOf(key)).toBe('FAILED');
  });
});
