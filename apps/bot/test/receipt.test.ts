/**
 * The receipt: a photo, and what it is allowed to move.
 *
 * Before this, `handleUpdate` read `message.text` and nothing else, so a
 * customer's receipt reached the bot and was dropped on the floor —
 * `receipt_submitted_at` was never written by anything in this repository. Two
 * things depended on that column: an admin deciding about somebody's money with
 * a document in front of them, and the matcher's ten-minute WAIT, which anchors
 * on it.
 *
 * Every assertion here goes through `handleUpdate` with an update shaped the way
 * Telegram sends one, not through `recordReceipt` — the bug being fixed was in
 * the dispatch, and a test that called the new function directly would have been
 * green before the fix as well.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import * as menu from '../src/menu.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId } from './helpers/shop.js';

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 610_000 + n, telegramId: 611_000 + n };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `rcpt${telegramId}` },
      message: { message_id: 77, chat: { id: telegramId } },
      data,
    },
  };
}

/**
 * A photo message, in Telegram's own shape: several renditions, smallest first.
 * The bot must keep the last one — the largest — because a receipt is read.
 */
function sendsPhoto(updateId: number, telegramId: number, fileIds: string[]): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: telegramId },
      from: { id: telegramId, username: `rcpt${telegramId}` },
      photo: fileIds.map((file_id) => ({ file_id })),
    },
  };
}

/** Buys something and presses «پرداخت کردم», which is what opens the claim. */
async function buyAndClaim(productCode: string) {
  const { updateId, telegramId } = ids();
  const userId = await makeCustomer(telegramId);
  const plan = await planId(productCode);

  const invoice = await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
  const order = await db
    .prepare(`SELECT id FROM orders WHERE user_id = ?1 ORDER BY id DESC LIMIT 1`)
    .bind(userId)
    .first<{ id: number }>();
  const paid = await handleUpdate(db, press(updateId + 1, telegramId, `paid:${order!.id}`));

  const claim = await db
    .prepare(
      `SELECT c.id, p.public_id
         FROM payments p
         JOIN payment_claims c ON c.external_order_id = 'shikoo:' || p.public_id
        WHERE p.user_id = ?1
        ORDER BY p.id DESC LIMIT 1`,
    )
    .bind(userId)
    .first<{ id: string; public_id: string }>();

  return { updateId, telegramId, userId, claimId: claim!.id, invoice, paid };
}

async function claimRow(claimId: string) {
  return db
    .prepare(
      `SELECT receipt_submitted_at, receipt_url_or_r2_key, status
         FROM payment_claims WHERE id = ?1`,
    )
    .bind(claimId)
    .first<{
      receipt_submitted_at: number | null;
      receipt_url_or_r2_key: string | null;
      status: string;
    }>();
}

beforeAll(async () => {
  await ensureCatalog();
});

describe('a customer sending their receipt', () => {
  it('attaches it to the claim under review and stamps the clock', async () => {
    const sale = await buyAndClaim('sim-vip-1m-50');
    expect((await claimRow(sale.claimId))?.receipt_submitted_at).toBeNull();

    const before = Date.now();
    const out = await handleUpdate(
      db,
      sendsPhoto(sale.updateId + 2, sale.telegramId, ['small-file-id-000', 'LARGEST-file-id-001']),
    );

    expect(out.status).toBe('processed');
    expect(out.replies[0]?.text).toContain('رسید شما دریافت شد');

    const row = await claimRow(sale.claimId);
    // The largest rendition, which is the one somebody can actually read.
    expect(row?.receipt_url_or_r2_key).toBe('LARGEST-file-id-001');
    expect(row?.receipt_submitted_at).toBeGreaterThanOrEqual(before);
  });

  it('is invited to, on the screen that comes right after «پرداخت کردم»', async () => {
    const sale = await buyAndClaim('sim-gold-10');
    // Not a claim about the registry — the sentence has to be in the message the
    // customer is actually sent, which is the thing that was missing.
    expect(sale.paid.replies[0]?.text).toContain('عکسش را بفرستید');
  });

  it('keeps the newest picture without moving the waiting clock', async () => {
    // `receipt_submitted_at` is the anchor for the ten minutes the matcher will
    // keep waiting for a bank SMS before it gives up and asks a person. A
    // customer who could restart that clock by sending another photo could hold
    // their own claim out of the manual queue for as long as they liked.
    const sale = await buyAndClaim('sim-vip-1m-20');
    await handleUpdate(db, sendsPhoto(sale.updateId + 2, sale.telegramId, ['first-receipt-0001']));
    const first = await claimRow(sale.claimId);

    const out = await handleUpdate(
      db,
      sendsPhoto(sale.updateId + 3, sale.telegramId, ['second-receipt-002']),
    );

    expect(out.replies[0]?.text).toBe(menu.RECEIPT_REPLACED);
    const second = await claimRow(sale.claimId);
    expect(second?.receipt_url_or_r2_key).toBe('second-receipt-002');
    expect(second?.receipt_submitted_at).toBe(first?.receipt_submitted_at);
  });

  it('is refused once the payment has been decided', async () => {
    const sale = await buyAndClaim('sim-shop-spotify');
    await db
      .prepare(`UPDATE payment_claims SET status = 'VERIFIED' WHERE id = ?1`)
      .bind(sale.claimId)
      .run();

    const out = await handleUpdate(
      db,
      sendsPhoto(sale.updateId + 2, sale.telegramId, ['too-late-receipt-01']),
    );

    expect(out.replies[0]?.text).toBe(menu.RECEIPT_SETTLED);
    // A settled claim is history. Stamping it would make the record of what
    // happened disagree with what happened.
    const row = await claimRow(sale.claimId);
    expect(row?.receipt_url_or_r2_key).toBeNull();
    expect(row?.receipt_submitted_at).toBeNull();
  });

  it('says what to do when nothing of theirs is waiting', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);

    const out = await handleUpdate(db, sendsPhoto(updateId, telegramId, ['unexpected-photo-1']));

    expect(out.status).toBe('processed');
    expect(out.replies[0]?.text).toBe(menu.RECEIPT_NOTHING_WAITING);
  });

  it('does not take a file id that is not one', async () => {
    // The update is untrusted input — anyone can post an update-shaped body at a
    // bot — and this string ends up in a column we later hand back to Telegram.
    const sale = await buyAndClaim('sim-vip-1m-50');

    const out = await handleUpdate(
      db,
      sendsPhoto(sale.updateId + 2, sale.telegramId, ['../../etc/passwd']),
    );

    expect(out.replies[0]?.text).toBe(menu.RECEIPT_NOTHING_WAITING);
    expect((await claimRow(sale.claimId))?.receipt_url_or_r2_key).toBeNull();
  });

  it('does not stop a customer typing', async () => {
    // The dispatch was rearranged around `message.photo`, and a message with no
    // photo must still reach the handler it always reached.
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);

    const out = await handleUpdate(db, {
      update_id: updateId,
      message: {
        message_id: updateId,
        chat: { id: telegramId },
        from: { id: telegramId, username: `rcpt${telegramId}` },
        text: '/start',
      },
    });

    expect(out.status).toBe('processed');
    expect(out.replies[0]?.keyboard?.flat().map((b) => b.callback_data)).toContain('buy');
  });
});
