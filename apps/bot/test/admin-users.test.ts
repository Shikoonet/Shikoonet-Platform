/**
 * The customer's page in the bot's admin panel.
 *
 * The point of this file is that an operator on a phone can do the same two
 * things to a customer's account that the panel can, through the same code, and
 * that neither of them can be done by somebody who may not.
 *
 * Two rules are worth stating because they are what the assertions check:
 *
 *   **The balance is never assigned.** Every adjustment is a row in
 *   append-only `wallet_entries`; the balance is a trigger's derivation. So the
 *   test reads the entries, not the balance, when it wants to know what
 *   happened — a balance can be right for the wrong reason.
 *
 *   **The customer being acted on comes from the session, never the button.**
 *   A `cnf` forged with somebody else's id must not decide about them.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import * as menu from '../src/menu.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 7, 14, 9, 0, 0);

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 660_000 + n, telegramId: 650_000 + n };
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

async function entriesFor(userId: number) {
  const { results } = await db
    .prepare(
      `SELECT amount_irr, kind, actor, note FROM wallet_entries
        WHERE user_id = ?1 ORDER BY id`,
    )
    .bind(userId)
    .all<{ amount_irr: number; kind: string; actor: string | null; note: string | null }>();
  return results ?? [];
}

async function statusOf(userId: number) {
  return db
    .prepare(`SELECT status, blocked_reason FROM users WHERE id = ?1`)
    .bind(userId)
    .first<{ status: string; blocked_reason: string | null }>();
}

const dataOf = (out: Awaited<ReturnType<typeof handleUpdate>>): string[] =>
  (out.replies[0]?.keyboard ?? []).flat().map((b) => b.callback_data ?? '');

beforeAll(async () => {
  await ensureCatalog();
  await db.prepare(`DELETE FROM admins WHERE telegram_id BETWEEN 650000 AND 659999`).run();
});

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('finding somebody', () => {
  it('finds them by their exact Telegram id', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const target = ids().telegramId;
    const targetId = await makeCustomer(target);

    await handleUpdate(db, press(updateId, telegramId, 'usf'));
    const out = await handleUpdate(db, types(updateId + 1, telegramId, String(target)));

    // One hit goes straight to the page rather than to a list of one, so what
    // proves it found the right person is that the page's own buttons carry
    // that customer's id.
    expect(out.replies[0]?.text).toContain(String(target));
    expect(dataOf(out)).toContain(`uwp:${targetId}`);
  });

  it('finds them by part of their username, with the @ optional', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const target = ids().telegramId;
    const targetId = await makeCustomer(target);
    await db
      .prepare(`UPDATE users SET username = 'reza_the_buyer' WHERE id = ?1`)
      .bind(targetId)
      .run();

    await handleUpdate(db, press(updateId, telegramId, 'usf'));
    const out = await handleUpdate(db, types(updateId + 1, telegramId, '@the_buyer'));

    expect(dataOf(out)).toContain(`uwp:${targetId}`);
  });

  it('finds them by an order number they quoted', async () => {
    // The one the panel's own search cannot do, and the one a customer actually
    // has to hand: «سفارش … پرداخت کردم ولی سرویس نیامد».
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const targetId = await makeCustomer(ids().telegramId);
    await db
      .prepare(
        `INSERT INTO orders (public_id, user_id, kind, status, quantity, unit_price_irr, total_irr)
         VALUES ('SHK-FINDME-1', ?1, 'NEW_PURCHASE', 'PAID', 1, 500000, 500000)`,
      )
      .bind(targetId)
      .run();

    await handleUpdate(db, press(updateId, telegramId, 'usf'));
    const out = await handleUpdate(db, types(updateId + 1, telegramId, 'shk-findme-1'));

    expect(dataOf(out)).toContain(`uwp:${targetId}`);
  });

  it('accepts a Telegram id typed on a Persian keyboard', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const target = ids().telegramId;
    const targetId = await makeCustomer(target);
    const persian = String(target).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]!);

    await handleUpdate(db, press(updateId, telegramId, 'usf'));
    const out = await handleUpdate(db, types(updateId + 1, telegramId, persian));

    expect(dataOf(out)).toContain(`uwp:${targetId}`);
  });

  it('says so, and keeps the question open, when nobody matches', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);

    await handleUpdate(db, press(updateId, telegramId, 'usf'));
    const out = await handleUpdate(db, types(updateId + 1, telegramId, 'nobody-at-all-xyz'));
    expect(out.replies[0]?.text).toBe(menu.ADMIN_USER_NONE);

    // Still asked: typing again works without pressing the button again.
    const again = await handleUpdate(db, types(updateId + 2, telegramId, 'nobody-at-all-xyz'));
    expect(again.replies[0]?.text).toBe(menu.ADMIN_USER_NONE);
  });
});

describe('moving a customer’s money', () => {
  it('writes an entry rather than assigning the balance', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const targetId = await makeCustomer(ids().telegramId);

    await handleUpdate(db, press(updateId, telegramId, `uwp:${targetId}`));
    const out = await handleUpdate(db, types(updateId + 1, telegramId, '25000'));

    const entries = await entriesFor(targetId);
    expect(entries).toHaveLength(1);
    // Toman in, IRR out. 25,000 Toman is 250,000 IRR and nothing else.
    expect(entries[0]?.amount_irr).toBe(250_000);
    expect(entries[0]?.kind).toBe('ADMIN_ADJUST');
    expect(entries[0]?.actor).toBe(`admin:${telegramId}`);
    expect(out.replies[0]?.text).toContain('25,000');
  });

  it('takes money off, and says plainly when that leaves a debt', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const targetId = await makeCustomer(ids().telegramId);

    await handleUpdate(db, press(updateId, telegramId, `uwm:${targetId}`));
    const out = await handleUpdate(db, types(updateId + 1, telegramId, '3000'));

    expect((await entriesFor(targetId))[0]?.amount_irr).toBe(-30_000);
    // Reported, not refused: correcting a credit the customer already spent has
    // to be possible, and `spendOnOrder` refuses to spend from a negative
    // wallet anyway, so it cannot become a free service.
    expect(out.replies[0]?.text).toContain('منفی');
  });

  it('refuses an amount above the single-correction ceiling', async () => {
    // A correction larger than the largest deposit the shop accepts is far more
    // likely to be a typed extra zero than an intent, and an extra zero on a
    // debit has no undo.
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const targetId = await makeCustomer(ids().telegramId);

    await handleUpdate(db, press(updateId, telegramId, `uwp:${targetId}`));
    await handleUpdate(db, types(updateId + 1, telegramId, '99000000000'));

    expect(await entriesFor(targetId)).toHaveLength(0);
  });

  it('refuses text where a number was asked for, and writes nothing', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const targetId = await makeCustomer(ids().telegramId);

    await handleUpdate(db, press(updateId, telegramId, `uwp:${targetId}`));
    const out = await handleUpdate(db, types(updateId + 1, telegramId, 'یک میلیون'));

    expect(out.replies[0]?.text).toBe(menu.ADMIN_USER_AMOUNT_BAD);
    expect(await entriesFor(targetId)).toHaveLength(0);
  });

  it('pays once when Telegram delivers the same message twice', async () => {
    // `telegram_updates` dedupes by update id; this is the layer below it, and
    // it is the one that matters if an operator's client retries.
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const targetId = await makeCustomer(ids().telegramId);

    await handleUpdate(db, press(updateId, telegramId, `uwp:${targetId}`));
    const typed = types(updateId + 1, telegramId, '10000');
    await handleUpdate(db, typed);
    await handleUpdate(db, press(updateId + 2, telegramId, `uwp:${targetId}`));
    await handleUpdate(db, { ...typed, update_id: updateId + 3 });

    const entries = await entriesFor(targetId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amount_irr).toBe(100_000);
  });

  it('lets a corrected amount through, because the amount is part of the key', async () => {
    // The failure this prevents: an operator types 50,000, notices, corrects it
    // to 500,000, and gets a silent no-op that reports success.
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const targetId = await makeCustomer(ids().telegramId);

    await handleUpdate(db, press(updateId, telegramId, `uwp:${targetId}`));
    await handleUpdate(db, types(updateId + 1, telegramId, '5000'));
    await handleUpdate(db, press(updateId + 2, telegramId, `uwp:${targetId}`));
    // Same message id on purpose — only the amount differs.
    await handleUpdate(db, {
      update_id: updateId + 3,
      message: {
        message_id: updateId + 1,
        chat: { id: telegramId },
        from: { id: telegramId, username: `adm${telegramId}` },
        text: '50000',
      },
    });

    expect((await entriesFor(targetId)).map((e) => e.amount_irr)).toEqual([50_000, 500_000]);
  });
});

describe('the standing discount', () => {
  it('sets it, and the page shows it back', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const targetId = await makeCustomer(ids().telegramId);

    await handleUpdate(db, press(updateId, telegramId, `udp:${targetId}`));
    const out = await handleUpdate(db, types(updateId + 1, telegramId, '15'));

    const row = await db
      .prepare(`SELECT discount_percent FROM users WHERE id = ?1`)
      .bind(targetId)
      .first<{ discount_percent: number }>();
    expect(Number(row?.discount_percent)).toBe(15);
    expect(out.replies[0]?.text).toContain('15');
  });

  it('refuses more than a hundred percent, and writes nothing', async () => {
    // A discount over 100 prices the plan below zero, and the order guards
    // would then refuse every purchase this customer made — a support call
    // that looks like a broken shop.
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const targetId = await makeCustomer(ids().telegramId);

    await handleUpdate(db, press(updateId, telegramId, `udp:${targetId}`));
    const out = await handleUpdate(db, types(updateId + 1, telegramId, '150'));

    expect(out.replies[0]?.text).toBe(menu.ADMIN_USER_DISCOUNT_BAD);
    const row = await db
      .prepare(`SELECT discount_percent FROM users WHERE id = ?1`)
      .bind(targetId)
      .first<{ discount_percent: number }>();
    expect(Number(row?.discount_percent)).toBe(0);
  });
});

describe('messaging one customer', () => {
  it('sends it to them and confirms to the admin', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const target = ids().telegramId;
    const targetId = await makeCustomer(target);

    await handleUpdate(db, press(updateId, telegramId, `umg:${targetId}`));
    const out = await handleUpdate(db, types(updateId + 1, telegramId, 'سرویس شما تمدید شد'));

    // Two replies: the customer's chat first, then the operator's own screen.
    expect(out.replies[0]?.chatId).toBe(target);
    expect(out.replies[0]?.text).toContain('سرویس شما تمدید شد');
    // Attributed. An unattributed message from the bot somebody bought a
    // subscription through reads as a scam.
    expect(out.replies[0]?.text).not.toBe('سرویس شما تمدید شد');
    expect(out.replies[1]?.chatId).toBe(telegramId);
  });

  it('is a SUPPORT operator’s job, and is drawn for them', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId, 'SUPPORT');
    const targetId = await makeCustomer(ids().telegramId);

    const page = await handleUpdate(db, press(updateId, telegramId, `usr:${targetId}`));
    const shown = dataOf(page);

    expect(shown).toContain(`umg:${targetId}`);
    // And still not the two that change the account.
    expect(shown).not.toContain(`udp:${targetId}`);
    expect(shown).not.toContain(`uwp:${targetId}`);
  });
});

describe('blocking somebody', () => {
  it('asks first, and does nothing until the confirmation', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const targetId = await makeCustomer(ids().telegramId);

    const asked = await handleUpdate(db, press(updateId, telegramId, `ubl:${targetId}`));
    expect(dataOf(asked)).toContain('cnf');
    expect((await statusOf(targetId))?.status).toBe('ACTIVE');

    await handleUpdate(db, press(updateId + 1, telegramId, 'cnf'));
    expect((await statusOf(targetId))?.status).toBe('BLOCKED');
  });

  it('lets them back in, and clears the stale reason', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const targetId = await makeCustomer(ids().telegramId);

    await handleUpdate(db, press(updateId, telegramId, `ubl:${targetId}`));
    await handleUpdate(db, press(updateId + 1, telegramId, 'cnf'));
    await handleUpdate(db, press(updateId + 2, telegramId, `uub:${targetId}`));
    await handleUpdate(db, press(updateId + 3, telegramId, 'cnf'));

    const row = await statusOf(targetId);
    expect(row?.status).toBe('ACTIVE');
    // A stale «چرا مسدود شد» on an active account is a sentence an operator
    // reads as current.
    expect(row?.blocked_reason).toBeNull();
  });

  it('decides about the customer in the session, not the one in the button', async () => {
    // The forgery this stops: ask to block A, then post `cnf` — there is no id
    // on `cnf` at all, and the id it uses was written beside the decision.
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const victimId = await makeCustomer(ids().telegramId);
    const otherId = await makeCustomer(ids().telegramId);

    await handleUpdate(db, press(updateId, telegramId, `ubl:${victimId}`));
    await handleUpdate(db, press(updateId + 1, telegramId, 'cnf'));

    expect((await statusOf(victimId))?.status).toBe('BLOCKED');
    expect((await statusOf(otherId))?.status).toBe('ACTIVE');
  });

  it('writes every decision to the append-only log', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const targetId = await makeCustomer(ids().telegramId);

    await handleUpdate(db, press(updateId, telegramId, `ubl:${targetId}`));
    await handleUpdate(db, press(updateId + 1, telegramId, 'cnf'));

    const { results } = await db
      .prepare(
        `SELECT action, actor_telegram_id FROM audit_logs
          WHERE entity_type = 'CUSTOMER' AND entity_id = ?1`,
      )
      .bind(String(targetId))
      .all<{ action: string; actor_telegram_id: number | null }>();
    expect(results?.map((r) => r.action)).toContain('customer.blocked');
    expect(results?.[0]?.actor_telegram_id).toBe(telegramId);
  });
});

describe('who may do what', () => {
  it('lets a SUPPORT operator look, and not touch', async () => {
    // The legacy `support` tier could look a customer up — that is the job. It
    // could not change their money.
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId, 'SUPPORT');
    const targetId = await makeCustomer(ids().telegramId);

    const home = await handleUpdate(db, press(updateId, telegramId, 'pnl'));
    expect(dataOf(home)).toContain('usf');

    const page = await handleUpdate(db, press(updateId + 1, telegramId, `usr:${targetId}`));
    const shown = dataOf(page);
    expect(shown).not.toContain(`uwp:${targetId}`);
    expect(shown).not.toContain(`ubl:${targetId}`);
  });

  it('refuses a SUPPORT operator who posts the wallet callback anyway', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId, 'SUPPORT');
    const targetId = await makeCustomer(ids().telegramId);

    const out = await handleUpdate(db, press(updateId, telegramId, `uwp:${targetId}`));

    expect(out.replies[0]?.text).toBe(menu.ADMIN_NOT_ALLOWED);
    expect(await entriesFor(targetId)).toHaveLength(0);
  });

  it('refuses a SUPPORT operator who posts the block confirmation anyway', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId, 'SUPPORT');
    const targetId = await makeCustomer(ids().telegramId);

    await handleUpdate(db, press(updateId, telegramId, `ubl:${targetId}`));
    const out = await handleUpdate(db, press(updateId + 1, telegramId, 'cnf'));

    expect(out.replies[0]?.text).toBe(menu.ADMIN_NOT_ALLOWED);
    expect((await statusOf(targetId))?.status).toBe('ACTIVE');
  });

  it('ignores a customer who forges the whole flow', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const targetId = await makeCustomer(ids().telegramId);

    expect((await handleUpdate(db, press(updateId, telegramId, 'usf'))).status).toBe('ignored');
    expect(
      (await handleUpdate(db, press(updateId + 1, telegramId, `uwp:${targetId}`))).status,
    ).toBe('ignored');
    expect(await entriesFor(targetId)).toHaveLength(0);
  });

  it('stops a typed amount from an admin whose permission was taken away mid-flow', async () => {
    // The row is still an admin — only the tick is gone. The half of the check
    // that the "switched off" test below cannot reach: being asked for an
    // amount a minute ago is not authority to move the money now.
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const targetId = await makeCustomer(ids().telegramId);

    await handleUpdate(db, press(updateId, telegramId, `uwp:${targetId}`));
    await db
      .prepare(
        `UPDATE admins SET permissions = '{"users.wallet": false}'::jsonb WHERE telegram_id = ?1`,
      )
      .bind(telegramId)
      .run();
    const out = await handleUpdate(db, types(updateId + 1, telegramId, '10000'));

    expect(out.status).toBe('ignored');
    expect(await entriesFor(targetId)).toHaveLength(0);
  });

  it('stops a typed amount from an admin whose row was switched off mid-flow', async () => {
    // Being asked a question a minute ago is not authority.
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const targetId = await makeCustomer(ids().telegramId);

    await handleUpdate(db, press(updateId, telegramId, `uwp:${targetId}`));
    await db
      .prepare(`UPDATE admins SET active = false WHERE telegram_id = ?1`)
      .bind(telegramId)
      .run();
    const out = await handleUpdate(db, types(updateId + 1, telegramId, '10000'));

    expect(out.status).toBe('ignored');
    expect(await entriesFor(targetId)).toHaveLength(0);
  });
});
