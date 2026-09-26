/**
 * «🏢 پنل نمایندگی» — a reseller buying their own panel's volume (#474).
 *
 * What is worth asserting, and each has a test below:
 *
 *   - The screen is only for the owner, and every id is re-read with the
 *     caller's own: a forged `rsp:<id>` of somebody else's panel finds nothing.
 *   - Nothing is sold that cannot be delivered: the panel is asked before the
 *     order exists (the admin is theirs, the role is safe, a reseller card
 *     exists), because card money cannot be given back by the bot.
 *   - The invoice draws a RESELLER card and nothing from the wallet, and none
 *     of the wallet doors — pay from the balance, top up the rest — opens.
 *   - The price is the whole order at its tier, the panel's own table.
 *   - Delivery: our row is the ledger and the panel its mirror. Each order is
 *     added once; a retry, a reclaim, a second order and a failed-then-retried
 *     order all leave the panel at exactly what was sold — never lower.
 *   - The new password goes out once, in a protected message of its own, and
 *     is stored nowhere.
 *
 * The panel is `adminPanel()`, which behaves as PasarGuard 5.2.1 was measured
 * to in the #474 probe.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateContinuityMode, deactivateContinuityMode } from '@shikoo/domain';
import { DEFAULT_CONTENT } from '../src/botContent.js';
import { handleUpdate } from '../src/handle.js';
import { DEFAULT_LAYOUTS } from '../src/keyboard.js';
import * as menu from '../src/menu.js';
import { recordPaidClick, recordReceipt } from '../src/payment.js';
import { provisionPaidOrders } from '../src/provision.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { adminPanel, RESELLER_ROLE, RESELLER_ROLE_ID, type FakeAdmin } from './helpers/adminPanel.js';
import { db, resetBot } from './helpers/env.js';
import { ensureCatalog, FIXTURE_CARD, makeCustomer } from './helpers/shop.js';
import { CUSTOMER, PANEL_OWNER, RESELLER } from './helpers/viewers.js';

const NOW_MS = Date.UTC(2026, 8, 26, 9, 0, 0);
const DAY = 86_400_000;
const TIB = 1024 ** 4;
const PANEL_CODE = 'sim-reseller-panel';
/** Luhn-valid, like the fixture customer card. */
const RESELLER_CARD = '6037990000000105';
const RESELLER_ACCOUNT = 'sim-reseller-account';

/** Sam's example: from 1 TB at 3,000,000 Toman each, from 3 TB at 2,000,000. */
const SALE = {
  tiers: [
    { from_tb: 1, price_per_tb_irr: 30_000_000 },
    { from_tb: 3, price_per_tb_irr: 20_000_000 },
  ],
  role_id: RESELLER_ROLE_ID,
  term_days: 90,
  max_order_irr: null,
};

let providerId: number;
let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  // A hundred apart: a test uses its own update id and up to +20 beyond it,
  // and a repeated update id is a duplicate delivery that answers nothing.
  const n = nextId++ * 100;
  return { updateId: 1_470_000 + n, telegramId: 1_480_000 + n };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `rs${telegramId}` },
      message: { message_id: 5, chat: { id: telegramId } },
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
      from: { id: telegramId, username: `rs${telegramId}` },
      text,
    },
  };
}

async function makeAccount(
  userId: number,
  opts: { status: 'PENDING' | 'ACTIVE'; username: string; dataLimitBytes?: number | null },
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO reseller_accounts (user_id, provider_id, panel_admin_username, name, status, data_limit_bytes)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id`,
    )
    .bind(userId, providerId, opts.username, `shop ${opts.username}`, opts.status, opts.dataLimitBytes ?? null)
    .first<{ id: number }>();
  return row!.id;
}

function panelAdmin(username: string, telegramId: number, dataLimit: number | null): FakeAdmin {
  return { username, data_limit: dataLimit, used_traffic: 0, note: null, telegram_id: telegramId, role: RESELLER_ROLE };
}

async function ledger(accountId: number) {
  return db
    .prepare(`SELECT status, data_limit_bytes, expires_at::text AS expires_at FROM reseller_accounts WHERE id = ?1`)
    .bind(accountId)
    .first<{ status: string; data_limit_bytes: string | number | null; expires_at: string | null }>();
}

async function lastOrder(userId: number) {
  return db
    .prepare(
      `SELECT id, kind, quantity, unit_price_irr, total_irr, status, target_reseller_id, provider_id,
              reseller_target_limit_bytes
         FROM orders WHERE user_id = ?1 ORDER BY id DESC LIMIT 1`,
    )
    .bind(userId)
    .first<{
      id: number;
      kind: string;
      quantity: number;
      unit_price_irr: number;
      total_irr: number;
      status: string;
      target_reseller_id: number | null;
      provider_id: number | null;
      reseller_target_limit_bytes: string | number | null;
    }>();
}

/** Buys `tb` through the bot: the button, the pre-check, the typed number, the invoice. */
async function buy(telegramId: number, updateId: number, accountId: number, tb: string, fetchImpl: typeof fetch) {
  const asked = await handleUpdate(db, press(updateId, telegramId, `rsb:${accountId}`), fetchImpl);
  const invoice = await handleUpdate(db, types(updateId + 1, telegramId, tb), fetchImpl);
  return { asked, invoice };
}

async function markPaid(orderId: number): Promise<void> {
  await db.prepare(`UPDATE orders SET status = 'PAID', updated_at = now() WHERE id = ?1`).bind(orderId).run();
}

beforeAll(async () => {
  await ensureCatalog();
  process.env[`PANEL_${PANEL_CODE.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = 'shopbot:secret';
  const row = await db
    .prepare(
      `INSERT INTO provisioning_providers (code, name, kind, status, base_url, secret_ref, config)
       VALUES (?1, 'پنل نماینده', 'pasarguard', 'ACTIVE', 'https://reseller.panel.test', ?1, ?2::jsonb)
       ON CONFLICT (code) DO UPDATE SET config = EXCLUDED.config, base_url = EXCLUDED.base_url,
                                        secret_ref = EXCLUDED.secret_ref, kind = EXCLUDED.kind
       RETURNING id`,
    )
    .bind(PANEL_CODE, JSON.stringify({ reseller_sale: SALE }))
    .first<{ id: number }>();
  providerId = row!.id;
  // One account kept for resellers (0104: customer_visible = 2), beside the
  // fixture's customer account.
  await db
    .prepare(
      `INSERT INTO financial_accounts
         (id, bank_name, display_name, account_type, account_hint, card_last_four,
          active, customer_visible, parser_configuration, created_at, updated_at)
       VALUES (?1, 'Melli', 'حساب نماینده', 'CARD', '0105', '0105', 1, 2, '{}', 0, 0)
       ON CONFLICT (id) DO UPDATE SET customer_visible = 2, active = 1`,
    )
    .bind(RESELLER_ACCOUNT)
    .run();
  await db
    .prepare(
      `INSERT INTO payment_cards (id, financial_account_id, card_digits, holder_name, status, created_at)
       VALUES ('sim-reseller-card', ?1, ?2, 'نماینده شیکو', 'ACTIVE', 0)
       ON CONFLICT (card_digits) DO UPDATE SET status = 'ACTIVE'`,
    )
    .bind(RESELLER_ACCOUNT, RESELLER_CARD)
    .run();
});

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  // Another test's PAID order would be delivered by this test's sweep.
  await db.prepare(`UPDATE orders SET status = 'CANCELLED' WHERE status IN ('PAID', 'PROVISIONING')`).run();
  // Card holds are payments rows; a hold from an earlier test is not this one's.
  await db.prepare(`UPDATE payments SET status = 'EXPIRED' WHERE status IN ('PENDING', 'AWAITING_REVIEW')`).run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  // Orders here reference `reseller_accounts`; the dashboard suite deletes
  // that table's rows and must not find them held.
  await resetBot();
  // The reseller card goes, not just its account: other suites borrow «any
  // card's account» (`FROM payment_cards LIMIT 1`) for a second customer card,
  // and one landing on this account would never be drawn for a customer.
  await db.prepare(`DELETE FROM payment_cards WHERE id = 'sim-reseller-card'`).run();
  await db.prepare(`UPDATE financial_accounts SET active = 0 WHERE id = ?1`).bind(RESELLER_ACCOUNT).run();
});

describe('who sees the panel', () => {
  it('draws «🏢 پنل نمایندگی» for an owner only, and hides the application from them', () => {
    const owner = JSON.stringify(menu.mainMenu(PANEL_OWNER));
    expect(owner).toContain('rsp');
    expect(owner).not.toContain('"agr"');
    expect(JSON.stringify(menu.mainMenu(CUSTOMER))).not.toContain('rsp');
    // A tiered reseller without a panel is not an owner.
    expect(JSON.stringify(menu.mainMenu(RESELLER))).not.toContain('rsp');
  });

  it('gives an owner the button even when the shop’s saved layout has none', () => {
    // A layout saved before #474, or one an operator hid the button in.
    const saved = DEFAULT_LAYOUTS.main.filter((b) => b.action !== 'rsp');
    menu.applyContent({ ...DEFAULT_CONTENT, layouts: { ...DEFAULT_LAYOUTS, main: saved } });
    try {
      expect(JSON.stringify(menu.mainMenu(PANEL_OWNER))).toContain('"rsp"');
      expect(JSON.stringify(menu.mainMenu(CUSTOMER))).not.toContain('rsp');
    } finally {
      menu.applyContent(DEFAULT_CONTENT);
    }
  });

  it('opens the one panel straight away, and finds nothing for somebody else’s id', async () => {
    const a = ids();
    const b = ids();
    const ua = await makeCustomer(a.telegramId);
    await makeCustomer(b.telegramId);
    const account = await makeAccount(ua, { status: 'PENDING', username: `shopa${a.telegramId}` });

    const mine = await handleUpdate(db, press(a.updateId, a.telegramId, 'rsp'));
    expect(mine.replies[0]?.text).toContain(`shopa${a.telegramId}`);

    const forged = await handleUpdate(db, press(b.updateId, b.telegramId, `rsp:${account}`));
    expect(forged.replies[0]?.text).toBe(menu.resellerPanelGone());
    expect(forged.replies[0]?.text).not.toContain(`shopa${a.telegramId}`);
  });
});

describe('buying — asked of the panel before anything is paid', () => {
  it('prices the whole order at its tier, on a reseller card, with nothing from the wallet', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    // Money in the wallet, which a customer invoice would spend first.
    await db
      .prepare(
        `INSERT INTO wallet_entries (user_id, amount_irr, kind, idempotency_key)
         VALUES (?1, 500000000, 'ADMIN_ADJUST', ?2)`,
      )
      .bind(userId, `rs-balance-${userId}`)
      .run();
    const account = await makeAccount(userId, { status: 'PENDING', username: `shop${telegramId}` });
    const panel = adminPanel();

    const { asked, invoice } = await buy(telegramId, updateId, account, '۳', panel.fetchImpl);

    // The table is stated before anything is bought.
    expect(asked.replies[0]?.text).toContain('2,000,000');
    const order = await lastOrder(userId);
    expect(order).toMatchObject({
      kind: 'RESELLER_VOLUME',
      quantity: 3,
      // 3 TB is in the «from 3» tier: 3 × 2,000,000 Toman, not 3 × 3,000,000.
      unit_price_irr: 20_000_000,
      total_irr: 60_000_000,
      target_reseller_id: account,
      provider_id: providerId,
      status: 'AWAITING_PAYMENT',
    });
    const text = invoice.replies[0]!.text;
    expect(text.replace(/\D/g, '')).toContain(RESELLER_CARD);
    expect(text.replace(/\D/g, '')).not.toContain(FIXTURE_CARD);
    // Neither wallet door is drawn.
    const buttons = JSON.stringify(invoice.replies[0]!.keyboard);
    expect(buttons).not.toContain('wpay');
    expect(buttons).not.toContain('tpo');
    const pay = await db
      .prepare(`SELECT amount_irr FROM payments WHERE order_id = ?1`)
      .bind(order!.id)
      .first<{ amount_irr: number }>();
    expect(Number(pay!.amount_irr)).toBe(60_000_000);
  });

  it('refuses above one transfer’s worth, and below the first tier', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const account = await makeAccount(userId, { status: 'PENDING', username: `cap${telegramId}` });
    const panel = adminPanel();
    await handleUpdate(db, press(updateId, telegramId, `rsb:${account}`), panel.fetchImpl);
    // 6 TB = 12,000,000 Toman: over the shop's 10,000,000 card ceiling.
    const over = await handleUpdate(db, types(updateId + 1, telegramId, '6'), panel.fetchImpl);
    expect(over.replies[0]?.text).toBe(menu.resellerTbTooMuch(5));
    const zero = await handleUpdate(db, types(updateId + 2, telegramId, '0'), panel.fetchImpl);
    expect(zero.replies[0]?.text).toBe(menu.resellerTbNotANumber());
    expect(await lastOrder(userId)).toBeNull();
  });

  it('refuses before an order when the existing admin is not provably theirs', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const account = await makeAccount(userId, { status: 'ACTIVE', username: `other${telegramId}` });
    // The admin exists, but its Telegram id is somebody else's — a typo in the
    // dashboard naming another reseller's admin.
    const panel = adminPanel([panelAdmin(`other${telegramId}`, 999_999_999, TIB)]);
    const out = await handleUpdate(db, press(updateId, telegramId, `rsb:${account}`), panel.fetchImpl);
    expect(out.replies[0]?.text).toBe(menu.resellerNotReady());
    expect(await lastOrder(userId)).toBeNull();
    // The exact filter was used, never the substring one.
    expect(panel.calls.some((c) => /[?&]username=/.test(c.path))).toBe(false);
  });

  it('refuses before an order when no card is kept for resellers', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const account = await makeAccount(userId, { status: 'PENDING', username: `nocard${telegramId}` });
    await db.prepare(`UPDATE financial_accounts SET active = 0 WHERE id = ?1`).bind(RESELLER_ACCOUNT).run();
    try {
      const out = await handleUpdate(db, press(updateId, telegramId, `rsb:${account}`), adminPanel().fetchImpl);
      expect(out.replies[0]?.text).toBe(menu.resellerNotReady());
    } finally {
      await db.prepare(`UPDATE financial_accounts SET active = 1 WHERE id = ?1`).bind(RESELLER_ACCOUNT).run();
    }
  });

  it('refuses the wallet doors by hand as well — the buttons are unsigned', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const account = await makeAccount(userId, { status: 'PENDING', username: `wal${telegramId}` });
    await buy(telegramId, updateId, account, '1', adminPanel().fetchImpl);
    const order = await lastOrder(userId);
    let n = 5;
    for (const forged of [`wpay:${order!.id}`, `tpo:${order!.id}`]) {
      // Each press its own update: a repeated update id is a duplicate delivery.
      const out = await handleUpdate(db, press(updateId + n++, telegramId, forged));
      expect(out.replies[0]?.text).toBe(menu.ORDER_GONE);
    }
    expect((await lastOrder(userId))?.status).toBe('AWAITING_PAYMENT');
  });
});

describe('the customers’ line and the resellers’ line never cross', () => {
  it('an ordinary invoice never draws the reseller card', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const plan = await db
      .prepare(
        `SELECT pl.id FROM product_plans pl JOIN products p ON p.id = pl.product_id
          JOIN provisioning_providers pv ON pv.id = p.provider_id
         WHERE pl.price_irr > 0 AND p.status = 'ACTIVE' AND pv.kind = 'pasarguard'
         ORDER BY pl.id LIMIT 1`,
      )
      .first<{ id: number }>();
    const out = await handleUpdate(db, press(updateId, telegramId, `order:${plan!.id}`));
    const text = out.replies.map((r) => r.text).join('\n').replace(/\D/g, '');
    expect(text).not.toContain(RESELLER_CARD);
  });
});

describe('delivery — our ledger, the panel its mirror', () => {
  it('creates the first panel: role, Telegram id, note and the volume, then ACTIVE with its term', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const username = `new${telegramId}`;
    const account = await makeAccount(userId, { status: 'PENDING', username });
    const panel = adminPanel();
    await buy(telegramId, updateId, account, '2', panel.fetchImpl);
    const order = await lastOrder(userId);
    await markPaid(order!.id);

    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);

    expect(panel.admins.get(username)).toMatchObject({
      data_limit: 2 * TIB,
      telegram_id: telegramId,
      note: `shikoo:reseller:${account}`,
      role: { id: RESELLER_ROLE_ID },
    });
    const row = await ledger(account);
    expect(row).toMatchObject({ status: 'ACTIVE' });
    expect(Number(row!.data_limit_bytes)).toBe(2 * TIB);
    // The term starts when the panel does: 90 days from delivery.
    expect(Date.parse(row!.expires_at!)).toBeGreaterThanOrEqual(NOW_MS + 89 * DAY);
    expect((await lastOrder(userId))?.status).toBe('COMPLETED');
    // Nothing on the wire or in the database holds a password beyond the create.
    const creates = panel.calls.filter((c) => c.method === 'POST' && c.path === '/api/admin');
    expect(creates).toHaveLength(1);
    const password = String(creates[0]!.body!['password']);
    const leaked = await db
      .prepare(`SELECT count(*)::int AS n FROM bot_notifications WHERE body LIKE '%' || ?1 || '%'`)
      .bind(password)
      .first<{ n: number }>();
    expect(leaked?.n).toBe(0);
  });

  it('adds to an existing admin from ITS limit, and a reclaimed retry adds nothing again', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const username = `old${telegramId}`;
    const account = await makeAccount(userId, { status: 'ACTIVE', username });
    const panel = adminPanel([panelAdmin(username, telegramId, 5 * TIB)]);
    await buy(telegramId, updateId, account, '1', panel.fetchImpl);
    const order = await lastOrder(userId);
    await markPaid(order!.id);

    // The panel is down for the first attempt: the order goes back to PAID with
    // its terabytes already on the ledger (stamped), and the panel untouched.
    panel.failNext['PUT'] = 503;
    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);
    expect((await lastOrder(userId))?.status).toBe('PAID');
    expect(Number((await ledger(account))!.data_limit_bytes)).toBe(6 * TIB);
    expect(panel.admins.get(username)!.data_limit).toBe(5 * TIB);

    // The next pass only mirrors: 6 TB, not 7.
    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);
    expect(panel.admins.get(username)!.data_limit).toBe(6 * TIB);
    expect(Number((await ledger(account))!.data_limit_bytes)).toBe(6 * TIB);
    expect((await lastOrder(userId))?.status).toBe('COMPLETED');
  });

  it('two orders for one reseller in one sweep both land', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const username = `two${telegramId}`;
    const account = await makeAccount(userId, { status: 'ACTIVE', username });
    const panel = adminPanel([panelAdmin(username, telegramId, TIB)]);
    await buy(telegramId, updateId, account, '1', panel.fetchImpl);
    const first = await lastOrder(userId);
    await buy(telegramId, updateId + 10, account, '2', panel.fetchImpl);
    const second = await lastOrder(userId);
    expect(second!.id).not.toBe(first!.id);
    await markPaid(first!.id);
    await markPaid(second!.id);

    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);

    expect(panel.admins.get(username)!.data_limit).toBe(4 * TIB);
    expect(Number((await ledger(account))!.data_limit_bytes)).toBe(4 * TIB);
  });

  it('a failed order gives its terabytes back, and its retry never lowers a newer total', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const username = `back${telegramId}`;
    const account = await makeAccount(userId, { status: 'ACTIVE', username });
    const panel = adminPanel([panelAdmin(username, telegramId, TIB)]);

    // Order A is refused by the panel outright (a 4xx is not worth retrying).
    await buy(telegramId, updateId, account, '1', panel.fetchImpl);
    const a = await lastOrder(userId);
    await markPaid(a!.id);
    panel.failNext['PUT'] = 422;
    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);
    expect((await lastOrder(userId))?.status).toBe('FAILED');
    // Given back: the ledger is where it started, and the stamp is gone.
    expect(Number((await ledger(account))!.data_limit_bytes)).toBe(TIB);
    const failed = await db
      .prepare(`SELECT reseller_target_limit_bytes FROM orders WHERE id = ?1`)
      .bind(a!.id)
      .first<{ reseller_target_limit_bytes: unknown }>();
    expect(failed?.reseller_target_limit_bytes).toBeNull();

    // Order B lands: 1 + 2.
    await buy(telegramId, updateId + 10, account, '2', panel.fetchImpl);
    const b = await lastOrder(userId);
    await markPaid(b!.id);
    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);
    expect(panel.admins.get(username)!.data_limit).toBe(3 * TIB);

    // The dashboard's retry puts A back to PAID. It applies its terabyte afresh
    // on top of B's — 4, never back down to A's old 2.
    await db.prepare(`UPDATE orders SET status = 'PAID', failure_reason = NULL WHERE id = ?1`).bind(a!.id).run();
    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);
    expect(panel.admins.get(username)!.data_limit).toBe(4 * TIB);
    expect(Number((await ledger(account))!.data_limit_bytes)).toBe(4 * TIB);
  });

  it('accepts a 409 only for the admin an earlier attempt made', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const username = `taken${telegramId}`;
    const account = await makeAccount(userId, { status: 'PENDING', username });
    const panel = adminPanel();
    await buy(telegramId, updateId, account, '1', panel.fetchImpl);
    const order = await lastOrder(userId);
    await markPaid(order!.id);
    // Somebody else's admin appears under the name between the check and the
    // delivery.
    panel.admins.set(username, panelAdmin(username, 424_242, TIB));

    await provisionPaidOrders(db, panel.fetchImpl, NOW_MS);

    expect((await lastOrder(userId))?.status).toBe('FAILED');
    expect(panel.admins.get(username)!.telegram_id).toBe(424_242);
    expect(panel.admins.get(username)!.data_limit).toBe(TIB);
    // Nothing is left on the ledger for an order that delivered nothing.
    expect((await ledger(account))!.data_limit_bytes).toBeNull();
    expect((await ledger(account))!.status).toBe('PENDING');
  });
});

describe('«🔑 رمز جدید»', () => {
  it('sends the new password once, protected, with no buttons, and stores it nowhere', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const username = `pw${telegramId}`;
    const account = await makeAccount(userId, { status: 'ACTIVE', username });
    const panel = adminPanel([panelAdmin(username, telegramId, TIB)]);

    const confirm = await handleUpdate(db, press(updateId, telegramId, `rspw:${account}`), panel.fetchImpl);
    expect(confirm.replies[0]?.text).toBe(menu.resellerPasswordConfirm(username));
    // Asking changes nothing on the panel.
    expect(panel.calls.some((c) => c.method === 'PUT')).toBe(false);

    const done = await handleUpdate(db, press(updateId + 1, telegramId, `rspw2:${account}`), panel.fetchImpl);
    const put = panel.calls.find((c) => c.method === 'PUT');
    const password = String(put!.body!['password']);
    expect(password.length).toBe(20);

    const secret = done.replies.find((r) => r.text.includes(password));
    expect(secret).toBeDefined();
    expect(secret!.protectContent).toBe(true);
    expect(secret!.keyboard).toBeUndefined();
    expect(secret!.editMessageId).toBeUndefined();
    // Not in the outbox, not in the session.
    const inOutbox = await db
      .prepare(`SELECT count(*)::int AS n FROM bot_notifications WHERE body LIKE '%' || ?1 || '%'`)
      .bind(password)
      .first<{ n: number }>();
    expect(inOutbox?.n).toBe(0);
    const inSession = await db
      .prepare(`SELECT count(*)::int AS n FROM bot_sessions WHERE data::text LIKE '%' || ?1 || '%'`)
      .bind(password)
      .first<{ n: number }>();
    expect(inSession?.n).toBe(0);
  });

  it('refuses an admin that is not theirs, and changes nothing', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const username = `notmine${telegramId}`;
    const account = await makeAccount(userId, { status: 'ACTIVE', username });
    const panel = adminPanel([panelAdmin(username, 111_111_111, TIB)]);
    const out = await handleUpdate(db, press(updateId, telegramId, `rspw2:${account}`), panel.fetchImpl);
    expect(out.replies[0]?.text).toBe(menu.resellerPasswordFailed());
    expect(panel.calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('the other two ways money could skip a reseller invoice', () => {
  it('continuity mode does not release a reseller order on a receipt alone', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const account = await makeAccount(userId, { status: 'PENDING', username: `cont${telegramId}` });
    await buy(telegramId, updateId, account, '1', adminPanel().fetchImpl);
    const order = await lastOrder(userId);
    await activateContinuityMode(db, {
      actorEmail: 'test@example.com',
      reason: 'sms relay down',
      durationMs: 60 * 60 * 1000,
      confirmed: true,
      now: NOW_MS,
    });
    try {
      await db.withSession((tx) => recordPaidClick(tx, userId, order!.id, telegramId, NOW_MS));
      await db.withSession((tx) =>
        recordReceipt(tx, userId, telegramId, 'AgACAgQAAxkBAAIresellerReceipt01', NOW_MS),
      );
      const claim = await db
        .prepare(
          `SELECT c.status FROM payment_claims c
             JOIN payments p ON c.external_order_id = 'shikoo:' || p.public_id
            WHERE p.order_id = ?1`,
        )
        .bind(order!.id)
        .first<{ status: string }>();
      expect(claim?.status).not.toBe('FULFILLED_UNRECONCILED');
    } finally {
      await deactivateContinuityMode(db, { actorEmail: 'test@example.com' });
    }
  });
});
