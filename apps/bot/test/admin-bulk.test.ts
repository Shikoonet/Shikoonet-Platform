/**
 * The two buttons that reach everybody at once.
 *
 * Neither has an undo, so what is tested is not that they work — it is that
 * they cannot happen twice, cannot happen without a confirmation, and cannot
 * happen at all to somebody without the tick.
 *
 * The duplicate is the failure that matters. A customer who misses a broadcast
 * has missed an announcement; a customer who gets it twice has been spammed by
 * a shop holding their money. A customer credited twice is money the shop
 * cannot get back. Both guarantees are database constraints — a unique
 * idempotency key and a composite primary key — and the assertions here read
 * the rows those constraints protect rather than the bot's reply.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import {
  claimBroadcastBatch,
  creditEveryone,
  markBroadcastFailed,
  newBatchId,
  queueBroadcast,
} from '../src/broadcast.js';
import * as menu from '../src/menu.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 7, 14, 9, 0, 0);

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 680_000 + n, telegramId: 670_000 + n };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `adm${telegramId}` },
      message: { message_id: 9, chat: { id: telegramId } },
      data,
    },
  };
}

function types(updateId: number, telegramId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: telegramId },
      from: { id: telegramId, username: `adm${telegramId}` },
      text,
    },
  };
}

async function makeAdmin(telegramId: number, role = 'ADMIN'): Promise<void> {
  await makeCustomer(telegramId);
  await db
    .prepare(
      `INSERT INTO admins (telegram_id, username, role, permissions, active)
       VALUES (?1, ?2, ?3, '{}'::jsonb, true)
       ON CONFLICT (telegram_id) DO UPDATE
         SET role = EXCLUDED.role, permissions = '{}'::jsonb, active = true`,
    )
    .bind(telegramId, `adm${telegramId}`, role)
    .run();
}

/**
 * The bulk credits this test's own operator wrote.
 *
 * Scoped by actor rather than emptied between tests, because `wallet_entries`
 * is append-only in the schema — a trigger refuses DELETE outright, which is
 * the ledger guarantee doing its job. Each test uses a distinct admin id, so
 * `actor` is the clean partition.
 */
async function bulkEntries(telegramId: number): Promise<{ user_id: number; amount_irr: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT user_id, amount_irr FROM wallet_entries
        WHERE idempotency_key LIKE 'bulk:%' AND actor = ?1 ORDER BY user_id`,
    )
    .bind(`admin:${telegramId}`)
    .all<{ user_id: number; amount_irr: number }>();
  return results ?? [];
}

async function recipients(): Promise<{ user_id: number; status: string }[]> {
  const { results } = await db
    .prepare(`SELECT user_id, status FROM broadcast_recipients ORDER BY user_id`)
    .all<{ user_id: number; status: string }>();
  return results ?? [];
}

async function activeCount(): Promise<number> {
  const row = await db
    .prepare(`SELECT count(*)::int AS n FROM users WHERE status = 'ACTIVE'`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  await ensureCatalog();
  await db.prepare(`DELETE FROM admins WHERE telegram_id BETWEEN 670000 AND 679999`).run();
});

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  // The broadcast tables start empty for each test. `wallet_entries` cannot be
  // emptied — it is append-only — so the credits are partitioned by actor
  // instead. `users` is shared with the rest of the suite on purpose: a bulk
  // action reaching rows it did not create is exactly the thing worth guarding.
  await db.prepare(`DELETE FROM broadcast_recipients`).run();
  await db.prepare(`DELETE FROM broadcasts`).run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('crediting every wallet', () => {
  it('shows the total before doing anything, and does nothing until confirmed', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const reach = await activeCount();

    await handleUpdate(db, press(updateId, telegramId, 'bcr'));
    const confirm = await handleUpdate(db, types(updateId + 1, telegramId, '5000'));

    // The total is the number that makes an extra zero visible. 5,000 Toman
    // looks the same as 50,000 at a glance; the sum across everybody does not.
    expect(confirm.replies[0]?.text).toContain((5_000 * reach).toLocaleString('en-US'));
    expect(await bulkEntries(telegramId)).toHaveLength(0);

    await handleUpdate(db, press(updateId + 2, telegramId, 'cnf'));
    const entries = await bulkEntries(telegramId);
    expect(entries).toHaveLength(reach);
    expect(entries.every((e) => e.amount_irr === 50_000)).toBe(true);
  });

  it('does nothing on a second confirmation, because the decision is spent', async () => {
    // The first `cnf` clears the session, so the second finds no pending
    // decision. This is the layer that catches an operator tapping twice, and
    // it is NOT the layer that catches the dangerous case — see below.
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const reach = await activeCount();

    await handleUpdate(db, press(updateId, telegramId, 'bcr'));
    await handleUpdate(db, types(updateId + 1, telegramId, '1000'));
    await handleUpdate(db, press(updateId + 2, telegramId, 'cnf'));
    await handleUpdate(db, press(updateId + 3, telegramId, 'cnf'));

    expect(await bulkEntries(telegramId)).toHaveLength(reach);
  });

  it('credits once when the same batch is applied twice', async () => {
    // The case the session clear cannot catch: two processes confirming the
    // same decision at the same moment, which is what a rolling deploy makes
    // possible and what the plan already flags for the poll loop. Both read the
    // session before either clears it, so both arrive here with the SAME batch
    // id — and the unique index on `idempotency_key` is what stops the second.
    //
    // Called directly rather than through two overlapping updates, because one
    // test process cannot produce that race. What is being proved is that the
    // constraint is where it can win.
    const { telegramId } = ids();
    const batch = newBatchId();
    const reach = await activeCount();

    const first = await creditEveryone(db, batch, 1_000, `admin:${telegramId}`, 'race');
    const second = await creditEveryone(db, batch, 1_000, `admin:${telegramId}`, 'race');

    expect(first).toBe(reach);
    expect(second).toBe(0);
    expect(await bulkEntries(telegramId)).toHaveLength(reach);
  });

  it('refuses an amount above the per-person ceiling', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);

    await handleUpdate(db, press(updateId, telegramId, 'bcr'));
    await handleUpdate(db, types(updateId + 1, telegramId, '99000000000'));
    await handleUpdate(db, press(updateId + 2, telegramId, 'cnf'));

    expect(await bulkEntries(telegramId)).toHaveLength(0);
  });

  it('skips a blocked customer', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const blockedId = await makeCustomer(ids().telegramId);
    await db.prepare(`UPDATE users SET status = 'BLOCKED' WHERE id = ?1`).bind(blockedId).run();

    await handleUpdate(db, press(updateId, telegramId, 'bcr'));
    await handleUpdate(db, types(updateId + 1, telegramId, '1000'));
    await handleUpdate(db, press(updateId + 2, telegramId, 'cnf'));

    expect((await bulkEntries(telegramId)).map((e) => e.user_id)).not.toContain(blockedId);
  });
});

describe('the broadcast', () => {
  it('shows the message exactly as it will be read, then queues it', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const reach = await activeCount();

    await handleUpdate(db, press(updateId, telegramId, 'bct'));
    const confirm = await handleUpdate(
      db,
      types(updateId + 1, telegramId, 'فردا از ۲ تا ۴ ربات خاموش است.'),
    );
    expect(confirm.replies[0]?.text).toContain('فردا از ۲ تا ۴ ربات خاموش است.');
    expect(await recipients()).toHaveLength(0);

    await handleUpdate(db, press(updateId + 2, telegramId, 'cnf'));
    expect(await recipients()).toHaveLength(reach);
    expect((await recipients()).every((r) => r.status === 'PENDING')).toBe(true);
  });

  it('gives a customer who arrives mid-send nothing, because the list was fixed', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);

    await handleUpdate(db, press(updateId, telegramId, 'bct'));
    await handleUpdate(db, types(updateId + 1, telegramId, 'اعلان'));
    await handleUpdate(db, press(updateId + 2, telegramId, 'cnf'));
    const before = (await recipients()).length;

    const latecomerId = await makeCustomer(ids().telegramId);

    expect(await recipients()).toHaveLength(before);
    expect((await recipients()).map((r) => r.user_id)).not.toContain(latecomerId);
  });

  it('hands each recipient out exactly once, however often the sweep runs', async () => {
    // The claim moves the row out of PENDING in the same statement that returns
    // it, so a second sweep — or a second process during a rolling deploy —
    // finds nothing left to take.
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);

    await handleUpdate(db, press(updateId, telegramId, 'bct'));
    await handleUpdate(db, types(updateId + 1, telegramId, 'اعلان'));
    await handleUpdate(db, press(updateId + 2, telegramId, 'cnf'));
    const reach = (await recipients()).length;

    const first = await claimBroadcastBatch(db, 1000);
    const second = await claimBroadcastBatch(db, 1000);

    expect(first).toHaveLength(reach);
    expect(second).toHaveLength(0);
    expect(new Set(first.map((m) => m.chatId)).size).toBe(reach);
    expect(first[0]?.text).toBe('اعلان');
  });

  it('lists each customer once when the same broadcast is queued twice', async () => {
    // The broadcast's half of the same race. `PRIMARY KEY (broadcast_id,
    // user_id)` is what makes the second call a no-op, so two processes
    // confirming one decision cannot put anybody in the list twice — and being
    // in the list twice is being messaged twice.
    const { telegramId } = ids();
    const broadcastId = newBatchId();
    const reach = await activeCount();

    const first = await queueBroadcast(db, broadcastId, 'اعلان', telegramId);
    const second = await queueBroadcast(db, broadcastId, 'اعلان', telegramId);

    expect(first).toBe(reach);
    expect(second).toBe(0);
    expect(await recipients()).toHaveLength(reach);
  });

  it('records a refusal against the recipient rather than retrying them', async () => {
    // The ordinary cause is a customer who blocked the bot. Retrying that
    // forever costs the shop its rate limit for everybody else.
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);

    await handleUpdate(db, press(updateId, telegramId, 'bct'));
    await handleUpdate(db, types(updateId + 1, telegramId, 'اعلان'));
    await handleUpdate(db, press(updateId + 2, telegramId, 'cnf'));

    const batch = await claimBroadcastBatch(db, 1);
    const one = batch[0]!;
    await markBroadcastFailed(db, one.broadcastId, one.userId, 'Forbidden: bot was blocked');

    const rows = await recipients();
    const failed = rows.find((r) => r.user_id === one.userId);
    expect(failed?.status).toBe('FAILED');
    expect(await claimBroadcastBatch(db, 1000)).not.toContainEqual(
      expect.objectContaining({ userId: one.userId }),
    );
  });

  it('refuses a message Telegram would reject outright', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);

    await handleUpdate(db, press(updateId, telegramId, 'bct'));
    const out = await handleUpdate(db, types(updateId + 1, telegramId, 'ا'.repeat(4097)));

    expect(out.replies[0]?.text).toBe(menu.bulkTextTooLong());
    await handleUpdate(db, press(updateId + 2, telegramId, 'cnf'));
    expect(await recipients()).toHaveLength(0);
  });
});

describe('who may reach everybody', () => {
  it('does not draw either button for a SUPPORT operator', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId, 'SUPPORT');

    const home = await handleUpdate(db, press(updateId, telegramId, 'pnl'));
    const shown = (home.replies[0]?.keyboard ?? []).flat().map((b) => b.callback_data);
    expect(shown).not.toContain('bcr');
    expect(shown).not.toContain('bct');
  });

  it('refuses a SUPPORT operator who posts the callbacks anyway', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId, 'SUPPORT');

    const credit = await handleUpdate(db, press(updateId, telegramId, 'bcr'));
    const message = await handleUpdate(db, press(updateId + 1, telegramId, 'bct'));

    expect(credit.replies[0]?.text).toBe(menu.ADMIN_NOT_ALLOWED);
    expect(message.replies[0]?.text).toBe(menu.ADMIN_NOT_ALLOWED);
    expect(await bulkEntries(telegramId)).toHaveLength(0);
    expect(await recipients()).toHaveLength(0);
  });

  it('stops a confirmation from an operator whose tick was removed mid-flow', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);

    await handleUpdate(db, press(updateId, telegramId, 'bcr'));
    await handleUpdate(db, types(updateId + 1, telegramId, '1000'));
    await db
      .prepare(`UPDATE admins SET permissions = '{"bulk.credit": false}'::jsonb WHERE telegram_id = ?1`)
      .bind(telegramId)
      .run();
    const out = await handleUpdate(db, press(updateId + 2, telegramId, 'cnf'));

    expect(out.replies[0]?.text).toBe(menu.ADMIN_NOT_ALLOWED);
    expect(await bulkEntries(telegramId)).toHaveLength(0);
  });
});
