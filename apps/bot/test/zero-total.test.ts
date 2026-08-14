/**
 * An order that comes to nothing.
 *
 * `discount.test.ts` already builds this state and asserts `total_irr: 0` — and
 * it is green, because it stops at the order row. The damage is one press
 * further on, and it is not confined to the customer who caused it:
 *
 *   total 0 → «pay from wallet» renders (`0 >= 0`) → the balance guard passes
 *   (`0 < 0` is false) → a wallet entry for `-0` → `CHECK (amount_irr <> 0)`
 *   → exception → the whole update rolls back, including the `telegram_updates`
 *   row that makes delivery once-only → the same update is handed back forever
 *   and no later update in that batch is ever acknowledged.
 *
 * One customer with a 100% standing discount stops the bot for everybody.
 *
 * Whether zero should instead be delivered free is a product question, and the
 * dump answers it: the single production account carrying `pricediscount = 100`
 * has zero invoices and zero payments. Nobody has ever bought at that price, so
 * a free-fulfilment path would be a second money path written for a case that
 * has never happened. Refusing is what this asserts.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 7, 14, 9, 0, 0);

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 960_000 + n, telegramId: 970_000 + n };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `zero${telegramId}` },
      message: { message_id: 7, chat: { id: telegramId } },
      data,
    },
  };
}

async function lastOrder(userId: number) {
  return db
    .prepare(
      `SELECT id, total_irr, status FROM orders WHERE user_id = ?1 ORDER BY id DESC LIMIT 1`,
    )
    .bind(userId)
    .first<{ id: number; total_irr: number; status: string }>();
}

async function walletEntryCount(userId: number): Promise<number> {
  const row = await db
    .prepare(`SELECT count(*)::int AS n FROM wallet_entries WHERE user_id = ?1`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

let VIP_PLAN = 0;

beforeAll(async () => {
  await ensureCatalog();
  VIP_PLAN = await planId('sim-vip-1m-50');
});

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a 100% standing discount', () => {
  it('does not write an order that costs nothing', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId, { discountPercent: 100 });

    const out = await handleUpdate(db, press(updateId, telegramId, `order:${VIP_PLAN}`));

    // The customer is told something, rather than left on a dead screen.
    expect(out.replies[0]?.text ?? '').not.toBe('');
    expect(await lastOrder(userId)).toBeNull();
  });

  it('survives the wallet press that used to take the bot down', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId, { discountPercent: 100 });

    await handleUpdate(db, press(updateId, telegramId, `order:${VIP_PLAN}`));
    const order = await lastOrder(userId);

    // «pay from wallet» is what a zero total renders (`0 >= 0`), and pressing it
    // is where the `-0` ledger row was attempted. `handleUpdate` must resolve:
    // a throw here is what rolls the once-only row back.
    await expect(
      handleUpdate(db, press(updateId + 1, telegramId, `wpay:${order?.id ?? 1}`)),
    ).resolves.toBeDefined();

    // And no ledger row was written for a movement of nothing.
    expect(await walletEntryCount(userId)).toBe(0);
  });

  it('leaves the once-only record in place so the update is never replayed', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId, { discountPercent: 100 });

    await handleUpdate(db, press(updateId, telegramId, `order:${VIP_PLAN}`));
    const order = await lastOrder(userId);
    await handleUpdate(db, press(updateId + 1, telegramId, `wpay:${order?.id ?? 1}`)).catch(
      () => undefined,
    );

    // This is the row a rollback destroyed. Its survival is what stops the
    // poller handing the same update back for ever.
    const seen = await db
      .prepare(`SELECT count(*)::int AS n FROM telegram_updates WHERE update_id = ?1`)
      .bind(updateId + 1)
      .first<{ n: number }>();
    expect(seen?.n).toBe(1);
  });
});

describe('a 100% code on top of a standing discount', () => {
  it('refuses the order rather than charging nothing for it', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId, { discountPercent: 60 });
    await db
      .prepare(
        `INSERT INTO discount_codes (code, kind, percent, applies_to, created_at)
         VALUES ('zerofree', 'PERCENT_OFF', 100, 'ALL', now())
         ON CONFLICT (code) DO NOTHING`,
      )
      .run();

    await handleUpdate(db, press(updateId, telegramId, `dsc:${VIP_PLAN}`));
    await handleUpdate(db, {
      update_id: updateId + 1,
      message: {
        message_id: updateId + 1,
        chat: { id: telegramId },
        from: { id: telegramId, username: `zero${telegramId}` },
        text: 'zerofree',
      },
    });
    await handleUpdate(db, press(updateId + 2, telegramId, `order:${VIP_PLAN}`));

    expect(await lastOrder(userId)).toBeNull();
    expect(await walletEntryCount(userId)).toBe(0);
  });
});
