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
// The encoding moved to `@shikoo/contracts` when the dashboard needed to read
// it too — the bot writes a receipt handle and the panel serves it, so neither
// of them can own the format.
import { receiptRef } from '@shikoo/contracts';
import { activateContinuityMode, deactivateContinuityMode } from '@shikoo/domain';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId } from './helpers/shop.js';
import { settleVerifiedPayments } from '../src/settle.js';

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

/**
 * The same receipt, sent with «Send as File» — a `document`, not a `photo`.
 *
 * Which is what somebody sending a bank slip taps, because it arrives
 * uncompressed and therefore readable. Before this it fell through every
 * handler and was dropped without a word, which is the exact failure this
 * file's header attributes to the legacy bot — reintroduced by the fix for it.
 */
function sendsFile(
  updateId: number,
  telegramId: number,
  fileId: string,
  mimeType?: string,
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: telegramId },
      from: { id: telegramId, username: `rcpt${telegramId}` },
      document: { file_id: fileId, ...(mimeType === undefined ? {} : { mime_type: mimeType }) },
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

/**
 * Walks the admin to the claim screen and returns the reply that carries the
 * receipt, whichever way it is carried.
 *
 * Through `handleUpdate` and `clv:` rather than by reading the column, because
 * the thing under test is which API call the operator's screen will make — and
 * a test that read the column would be green with the wrong one chosen.
 */
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

  it('still accepts the receipt after Continuity has released the order', async () => {
    const actor = 'continuity-receipt@example.com';
    await activateContinuityMode(db, {
      actorEmail: actor,
      reason: 'bank evidence channel is down',
      durationMs: 30 * 60 * 1000,
      confirmed: true,
    });

    try {
      const sale = await buyAndClaim('sim-gold-10');
      expect((await claimRow(sale.claimId))?.status).toBe('FULFILLED_UNRECONCILED');
      expect(await settleVerifiedPayments(db)).toBeGreaterThanOrEqual(1);
      const payment = await db
        .prepare(
          `SELECT p.status
             FROM payments p
             JOIN payment_claims c ON c.external_order_id = 'shikoo:' || p.public_id
            WHERE c.id = ?1`,
        )
        .bind(sale.claimId)
        .first<{ status: string }>();
      expect(payment?.status).toBe('PAID');

      const out = await handleUpdate(
        db,
        sendsPhoto(sale.updateId + 2, sale.telegramId, ['continuity-receipt-0001']),
      );

      expect(out.replies[0]?.text).toContain('رسید شما دریافت شد');
      const row = await claimRow(sale.claimId);
      expect(row?.status).toBe('FULFILLED_UNRECONCILED');
      expect(row?.receipt_url_or_r2_key).toBe('continuity-receipt-0001');
      expect(row?.receipt_submitted_at).not.toBeNull();
    } finally {
      await deactivateContinuityMode(db, { actorEmail: actor });
    }
  });

  it('is invited to, on the screen that comes right after «پرداخت کردم»', async () => {
    const sale = await buyAndClaim('sim-gold-10');
    // Not a claim about the registry — the sentence has to be in the message the
    // customer is actually sent, which is the thing that was missing.
    //
    // The wording changed on 2026-08-24 and the change is the point. It opened
    // «اگر رسید واریز دارید…», which reads as an offer, and sat under a first
    // line already saying the payment was recorded — so a customer finished
    // reading believing there was nothing left to do. Sam read it exactly that
    // way and reported that the bot never asked.
    expect(sale.paid.replies[0]?.text).toContain('عکس رسید واریز را همین‌جا بفرستید');
    expect(sale.paid.replies[0]?.text).not.toContain('اگر رسید');
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
    // `/start` answers with the fixed navigation row. The claim is unchanged:
    // a message with no photo still reaches the handler it always reached.
    const rows = out.replies[0]?.replyKeyboard;
    expect(Array.isArray(rows) && rows.flat().length).toBeGreaterThan(0);
  });
});

describe('a receipt sent as a file', () => {
  it('is attached, just as a photo is', async () => {
    const sale = await buyAndClaim('sim-gold-10');

    const out = await handleUpdate(
      db,
      sendsFile(sale.updateId + 2, sale.telegramId, 'AgACdocreceipt0000001', 'image/jpeg'),
    );

    expect(out.status).toBe('processed');
    const row = await claimRow(sale.claimId);
    expect(row?.receipt_submitted_at).not.toBeNull();
    // Stored with its kind, because Telegram keeps documents and photos in
    // separate id spaces and refuses each other's handles. Without the mark the
    // admin's screen would show nothing at the one moment it matters.
    expect(row?.receipt_url_or_r2_key).toBe('doc:AgACdocreceipt0000001');
  });

  it('takes a bank PDF, which is the other thing a receipt arrives as', async () => {
    const sale = await buyAndClaim('sim-vip-1m-20');
    await handleUpdate(
      db,
      sendsFile(sale.updateId + 2, sale.telegramId, 'AgACdocreceipt0000002', 'application/pdf'),
    );
    expect((await claimRow(sale.claimId))?.receipt_url_or_r2_key).toBe('doc:AgACdocreceipt0000002');
  });

  it('refuses anything that is not a receipt, and says so', async () => {
    // Told rather than ignored. A customer who sent the wrong thing and heard
    // nothing assumes it arrived, and then waits for a service.
    const sale = await buyAndClaim('sim-vip-1m-50');

    const out = await handleUpdate(
      db,
      sendsFile(sale.updateId + 2, sale.telegramId, 'AgACdocreceipt0000003', 'application/zip'),
    );

    expect(out.replies[0]?.text).toBe(menu.RECEIPT_WRONG_FILE);
    expect((await claimRow(sale.claimId))?.receipt_url_or_r2_key).toBeNull();
  });

  it('refuses a file whose type Telegram did not state', async () => {
    // `mime_type` is optional in the API, so its absence says nothing — and
    // "unknown" is not "image".
    const sale = await buyAndClaim('sim-gold-10');

    const out = await handleUpdate(
      db,
      sendsFile(sale.updateId + 2, sale.telegramId, 'AgACdocreceipt0000004'),
    );

    expect(out.replies[0]?.text).toBe(menu.RECEIPT_WRONG_FILE);
    expect((await claimRow(sale.claimId))?.receipt_url_or_r2_key).toBeNull();
  });

  it('is stored marked as a file, so whoever shows it sends the right kind', async () => {
    // Telegram keeps documents and photos in separate id spaces: a document's
    // handle given to `sendPhoto` is refused outright, and an operator would
    // see nothing while the screen still said a receipt had arrived. The kind
    // therefore has to survive WITH the id.
    //
    // Asserted on the stored row rather than on a screen. The screen that used
    // to render this was the bot's own claim page and it is the dashboard's
    // now — but the marker is what makes that possible, and a guarantee only a
    // deleted caller tested is a guarantee nobody is keeping.
    const sale = await buyAndClaim('sim-vip-1m-20');
    await handleUpdate(
      db,
      sendsFile(sale.updateId + 2, sale.telegramId, 'AgACdocreceipt0000005', 'image/png'),
    );

    const stored = (await claimRow(sale.claimId))?.receipt_url_or_r2_key;
    expect(stored).toBe('doc:AgACdocreceipt0000005');
    expect(receiptRef(stored!)).toEqual({ fileId: 'AgACdocreceipt0000005', isDocument: true });
  });

  it('is stored bare when it arrived as a photo, as every migrated row is', async () => {
    const sale = await buyAndClaim('sim-vip-1m-50');
    await handleUpdate(
      db,
      sendsPhoto(sale.updateId + 2, sale.telegramId, ['AgACphotoreceipt000006']),
    );

    const stored = (await claimRow(sale.claimId))?.receipt_url_or_r2_key;
    expect(stored).toBe('AgACphotoreceipt000006');
    expect(receiptRef(stored!)).toEqual({ fileId: 'AgACphotoreceipt000006', isDocument: false });
  });
});

/**
 * The customer the shop has cut off, who has already sent money.
 *
 * The flood guard blocks at 35 updates in a minute, and the things that reach
 * it are not all abuse: repeated taps while the bot is slow, an album, a
 * callback Telegram redelivers. Whoever it catches, the money is already in the
 * bank — and before this, every door back was shut in silence. The receipt was
 * ignored, «پرداخت کردم» was ignored, `expireUnpaidOrders` killed the invoice,
 * and there was no way to ask what happened from inside the bot.
 *
 * The assertions below are about the DATABASE, not about the reply text: what
 * matters is that the evidence is attached to the claim an operator will read.
 */
describe('a blocked customer who has already paid', () => {
  async function block(telegramId: number): Promise<void> {
    await db
      .prepare(
        `UPDATE users SET status = 'BLOCKED', blocked_reason = 'auto-blocked for flooding the bot'
          WHERE telegram_id = ?1`,
      )
      .bind(telegramId)
      .run();
  }

  it('still has their receipt attached to the claim', async () => {
    const sale = await buyAndClaim('sim-vip-1m-50');
    await block(sale.telegramId);

    const out = await handleUpdate(
      db,
      sendsPhoto(sale.updateId + 2, sale.telegramId, ['blocked-receipt-000001']),
    );

    expect(out.status).toBe('processed');
    const row = await claimRow(sale.claimId);
    expect(row?.receipt_url_or_r2_key).toBe('blocked-receipt-000001');
    expect(row?.receipt_submitted_at).not.toBeNull();
  });

  it('can still press «پرداخت کردم» on an order they already own', async () => {
    // Ordered but not yet claimed, which is the window the block used to close
    // for good: the money is sent and the bot has never been told.
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const plan = await planId('sim-gold-10');
    await handleUpdate(db, press(updateId, telegramId, `order:${plan}`));
    const order = await db
      .prepare(`SELECT id FROM orders WHERE user_id = ?1 ORDER BY id DESC LIMIT 1`)
      .bind(userId)
      .first<{ id: number }>();

    await block(telegramId);
    const out = await handleUpdate(db, press(updateId + 1, telegramId, `paid:${order!.id}`));

    expect(out.status).toBe('processed');
    const claim = await db
      .prepare(
        `SELECT count(*)::int AS n
           FROM payments p
           JOIN payment_claims c ON c.external_order_id = 'shikoo:' || p.public_id
          WHERE p.user_id = ?1`,
      )
      .bind(userId)
      .first<{ n: number }>();
    expect(claim?.n).toBe(1);
  });

  it('is still refused everything else, and answered nothing', async () => {
    // The block has to keep costing a flooder what it always cost, or it stops
    // being a block. Only the two payment-recovery doors are open.
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    await block(telegramId);

    const menuPress = await handleUpdate(db, press(updateId, telegramId, 'menu'));
    expect(menuPress.status).toBe('ignored');
    expect(menuPress.replies).toEqual([]);

    // A picture from somebody with no payment waiting: recorded nowhere, and
    // not worth a reply either.
    const stray = await handleUpdate(
      db,
      sendsPhoto(updateId + 1, telegramId, ['stray-picture-000002']),
    );
    expect(stray.status).toBe('ignored');
    expect(stray.replies).toEqual([]);
  });
});

describe('asking twice', () => {
  it('still asks for the receipt on a second press of «پرداخت کردم»', async () => {
    /*
     * The first press is the one a customer is least likely to be reading
     * carefully, having just come back from their banking app — and pressing
     * again is what somebody does when they are not sure the first tap
     * registered. That reply was the title and the tracking id and nothing
     * else, so the bot mentioned a receipt exactly once, at the worst possible
     * moment, and never again.
     *
     * `checkoutFor` also answers `claimed` for an order that already has a live
     * claim, and that path lands on this same reply.
     */
    const sale = await buyAndClaim('sim-gold-10');
    const order = await db
      .prepare(`SELECT id FROM orders WHERE user_id = ?1 ORDER BY id DESC LIMIT 1`)
      .bind(sale.userId)
      .first<{ id: number }>();

    const again = await handleUpdate(
      db,
      press(sale.updateId + 2, sale.telegramId, `paid:${order!.id}`),
    );

    expect(again.replies[0]?.text).toContain('قبلاً ثبت شده');
    expect(again.replies[0]?.text).toContain('عکس رسید واریز را همین‌جا بفرستید');
  });
});
