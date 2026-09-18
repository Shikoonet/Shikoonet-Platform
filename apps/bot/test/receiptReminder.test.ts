/**
 * The second ask for a receipt, five minutes after «پرداخت کردم» (#308).
 *
 * Nothing ships without a picture since 09-17, so a claim with no receipt is
 * a claim going nowhere — and the customer does not know. Once per claim,
 * before the matcher's ten minutes run out, and never for a claim that has a
 * picture, is decided, or was delivered without waiting for one.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import * as menu from '../src/menu.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { RECEIPT_REMINDER_AFTER_MS, remindMissingReceipt } from '../src/receiptReminder.js';
import { db, pendingNotifications } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 8, 18, 9, 0, 0);
const MINUTE = 60_000;

let seq = 0;
function ids(): { updateId: number; telegramId: number } {
  seq += 1;
  return { updateId: 790_000 + seq * 10, telegramId: 791_000 + seq * 10 };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `rmnd${telegramId}` },
      message: { message_id: 77, chat: { id: telegramId } },
      data,
    },
  };
}

function sendsPhoto(updateId: number, telegramId: number, fileId: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: telegramId },
      from: { id: telegramId, username: `rmnd${telegramId}` },
      photo: [{ file_id: fileId }],
    },
  };
}

/** «پرداخت کردم» pressed at `NOW_MS - minutesAgo`, no picture sent. */
async function claimed(minutesAgo: number) {
  const { updateId, telegramId } = ids();
  const userId = await makeCustomer(telegramId);
  const plan = await planId('sim-vip-1m-50');
  await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
  const order = await db
    .prepare(`SELECT id FROM orders WHERE user_id = ?1 ORDER BY id DESC LIMIT 1`)
    .bind(userId)
    .first<{ id: number }>();
  await handleUpdate(db, press(updateId + 1, telegramId, `paid:${order!.id}`));
  const claim = await db
    .prepare(
      `UPDATE payment_claims SET paid_clicked_at = ?2
        WHERE id = (SELECT c.id FROM payment_claims c
                      JOIN payments p ON c.external_order_id = 'shikoo:' || p.public_id
                     WHERE p.user_id = ?1 ORDER BY p.id DESC LIMIT 1)
        RETURNING id`,
    )
    .bind(userId, NOW_MS - minutesAgo * MINUTE)
    .first<{ id: string }>();
  return { updateId, telegramId, userId, claimId: claim!.id };
}

async function reminders(telegramId: number) {
  return (await pendingNotifications()).filter((n) => n.chatId === telegramId);
}

beforeAll(ensureCatalog);

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  // Every claim from an earlier test is still due, so the counts below only
  // mean something on a clean table. Files run serially in this package.
  await db.prepare(`DELETE FROM bot_notifications`).run();
  await db.prepare(`DELETE FROM payment_claims`).run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the reminder', () => {
  it('goes out once, five minutes after «پرداخت کردم» with no picture', async () => {
    const sale = await claimed(5);

    expect(await remindMissingReceipt(db)).toBe(1);
    const sent = await reminders(sale.telegramId);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe(menu.RECEIPT_REMINDER);
    expect(sent[0]?.dedupeKey).toBe(`receipt-nudge:${sale.claimId}`);

    // The second sweep finds the record of the first and does nothing.
    expect(await remindMissingReceipt(db)).toBe(0);
    expect(await reminders(sale.telegramId)).toHaveLength(1);
  });

  it('waits the full five minutes', async () => {
    const sale = await claimed(4);
    expect(await remindMissingReceipt(db)).toBe(0);
    expect(await reminders(sale.telegramId)).toHaveLength(0);

    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS + RECEIPT_REMINDER_AFTER_MS);
    expect(await remindMissingReceipt(db)).toBe(1);
  });

  it('says nothing about a claim that has a picture', async () => {
    const sale = await claimed(6);
    await handleUpdate(db, sendsPhoto(sale.updateId + 2, sale.telegramId, 'first-receipt-0001'));

    expect(await remindMissingReceipt(db)).toBe(0);
  });

  it('says nothing about a claim that is decided or delivered', async () => {
    for (const status of ['VERIFIED', 'REJECTED', 'EXPIRED', 'FULFILLED_UNRECONCILED']) {
      const sale = await claimed(6);
      await db
        .prepare(`UPDATE payment_claims SET status = ?2 WHERE id = ?1`)
        .bind(sale.claimId, status)
        .run();
      expect(await remindMissingReceipt(db)).toBe(0);
    }
  });

  it('leaves the backlog alone: nothing older than an hour', async () => {
    const sale = await claimed(61);
    expect(await remindMissingReceipt(db)).toBe(0);
    expect(await reminders(sale.telegramId)).toHaveLength(0);
  });

  it('re-opens the door: the picture sent after it is taken', async () => {
    const sale = await claimed(5);
    expect(await remindMissingReceipt(db)).toBe(1);

    const out = await handleUpdate(
      db,
      sendsPhoto(sale.updateId + 2, sale.telegramId, 'late-receipt-00001'),
    );

    expect(out.replies[0]?.text).toContain('رسید شما دریافت شد');
    const row = await db
      .prepare(`SELECT receipt_url_or_r2_key FROM payment_claims WHERE id = ?1`)
      .bind(sale.claimId)
      .first<{ receipt_url_or_r2_key: string | null }>();
    expect(row?.receipt_url_or_r2_key).toBe('late-receipt-00001');
  });
});
