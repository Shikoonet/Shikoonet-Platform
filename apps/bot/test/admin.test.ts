/**
 * The admin panel in the bot.
 *
 * The screens are small; the assertions are about who is refused. A customer
 * who forges `pnl` or `clv:<uuid>` must get exactly what they get for any
 * unknown callback — nothing — and an admin approval must go through
 * `verifyMirzabotClaim`, which is the only path allowed to settle one of these
 * (see `.claude/skills/mirzabot-matching`).
 *
 * The other half is the audit trail: every decision leaves a row in a table the
 * schema will not let anyone edit afterwards.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import * as menu from '../src/menu.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 7, 14, 9, 0, 0);
const AMOUNT_IRR = 1_950_000;

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 500_000 + n, telegramId: 520_000 + n };
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

async function makeAdmin(
  telegramId: number,
  role = 'ADMIN',
  permissions: Record<string, boolean> = {},
): Promise<number> {
  await makeCustomer(telegramId);
  const row = await db
    .prepare(
      `INSERT INTO admins (telegram_id, username, role, permissions, active)
       VALUES (?1, ?2, ?3, ?4::jsonb, true)
       ON CONFLICT (telegram_id) DO UPDATE
         SET active = true, role = EXCLUDED.role, permissions = EXCLUDED.permissions
       RETURNING id`,
    )
    .bind(telegramId, `adm${telegramId}`, role, JSON.stringify(permissions))
    .first<{ id: number }>();
  return row!.id;
}

/** An account, a card, a customer, a claim — the shape a real payment leaves. */
async function makeClaim(
  customerTelegramId: number,
  options: { withTransaction?: boolean; amountIrr?: number } = {},
): Promise<{ claimId: string; transactionId: string | null; accountId: string }> {
  const amount = options.amountIrr ?? AMOUNT_IRR;
  const accountId = `adm-acct-${customerTelegramId}`;
  await db
    .prepare(
      `INSERT INTO financial_accounts
         (id, bank_name, display_name, account_type, account_hint, active,
          parser_configuration, created_at, updated_at)
       VALUES (?1, 'Melli', 'حساب ادمین‌تست', 'CARD', ?2, 1, '{}', 0, 0)
       ON CONFLICT (id) DO NOTHING`,
    )
    .bind(accountId, String(customerTelegramId).slice(-4))
    .run();

  const claimId = randomUUID();
  await db
    .prepare(
      `INSERT INTO payment_claims
         (id, external_order_id, customer_reference, expected_amount_irr,
          target_financial_account_id, card_digits, submitted_at, paid_clicked_at,
          source_system, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, '6037000000000095', ?6, ?6, 'MIRZABOT', 'PENDING', ?6, ?6)`,
    )
    .bind(claimId, `shikoo:${claimId.slice(0, 10)}`, String(customerTelegramId), amount, accountId, NOW_MS)
    .run();

  if (!options.withTransaction) return { claimId, transactionId: null, accountId };

  const smsId = randomUUID();
  const txId = randomUUID();
  await db
    .prepare(
      `INSERT INTO devices (id, device_code, display_name, created_at, updated_at)
       VALUES ('adm-dev', 'ADM-D1', 'phone', 0, 0) ON CONFLICT (id) DO NOTHING`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO raw_sms_events
         (id, device_id, sender, body_sha256, app_checksum, sms_timestamp, received_at,
          classification, parser_status, created_at)
       VALUES (?1, 'adm-dev', 'BANK', ?2, ?3, ?4, ?4, 'BANK_CREDIT', 'OK', 0)`,
    )
    .bind(smsId, `h-${smsId}`, `c-${smsId}`, NOW_MS)
    .run();
  await db
    .prepare(
      `INSERT INTO transaction_candidates
         (id, raw_sms_event_id, direction, amount_irr, bank_timestamp, financial_account_id,
          processing_disposition, confidence, parser_id, parser_version, status, created_at, updated_at)
       VALUES (?1, ?2, 'CREDIT', ?3, ?4, ?5, 'ACTIONABLE', 1.0, 'p', 'v1', 'PARSED', 0, 0)`,
    )
    .bind(txId, smsId, amount, NOW_MS + 20_000, accountId)
    .run();
  return { claimId, transactionId: txId, accountId };
}

async function auditRows(claimId: string) {
  const { results } = await db
    .prepare(
      `SELECT action, actor_telegram_id, actor_role FROM audit_logs
        WHERE entity_id = ?1 ORDER BY created_at, id`,
    )
    .bind(claimId)
    .all<{ action: string; actor_telegram_id: number | null; actor_role: string }>();
  return results ?? [];
}

beforeAll(async () => {
  await ensureCatalog();
  // `ids()` restarts at the same numbers every run, but `admins` rows do not
  // go away — so a Telegram id that this file made an admin in one run is
  // still an admin in the next, and whichever test happens to draw that number
  // next silently gets a different answer. It bit "a customer who types
  // /panel": adding tests above it shifted the sequence onto an id an earlier
  // run had promoted, and a test about customers started asserting on an admin.
  //
  // Scoped to this file's own range rather than emptying the table, because the
  // suite shares one database.
  await db.prepare(`DELETE FROM admins WHERE telegram_id BETWEEN 500000 AND 599999`).run();
});

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('who may see the panel', () => {
  it('answers nothing at all to a customer who types /panel', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);

    const out = await handleUpdate(db, types(updateId, telegramId, '/panel'));

    // Not "you are not an admin" — that would confirm the command exists.
    expect(out.status).toBe('ignored');
    expect(out.replies).toHaveLength(0);
  });

  it('ignores a forged admin callback from a customer', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const { claimId } = await makeClaim(telegramId);

    for (const [i, data] of ['pnl', 'clm', `clv:${claimId}`, 'apx', 'cnf'].entries()) {
      const out = await handleUpdate(db, press(updateId + i, telegramId, data));
      expect(out.status, data).toBe('ignored');
    }
    const claim = await db
      .prepare(`SELECT status FROM payment_claims WHERE id = ?1`)
      .bind(claimId)
      .first<{ status: string }>();
    expect(claim?.status).toBe('PENDING');
  });

  it('ignores an admin whose row has been switched off', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    await db.prepare(`UPDATE admins SET active = false WHERE telegram_id = ?1`).bind(telegramId).run();

    const out = await handleUpdate(db, types(updateId, telegramId, '/panel'));

    expect(out.status).toBe('ignored');
  });

  it('opens for an admin', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);

    const out = await handleUpdate(db, types(updateId, telegramId, '/panel'));

    expect(out.replies[0]?.text).toContain(menu.ADMIN_HOME);
  });

  it('works for an admin who has never been a customer', async () => {
    // Found on the browser: `/panel` opened for an admin with no `users` row
    // and then every button answered "press /start", because the callback
    // handler reads `users` first and the review session is keyed by its id.
    const { updateId, telegramId } = ids();
    await db
      .prepare(
        `INSERT INTO admins (telegram_id, username, role, active)
         VALUES (?1, 'never-started', 'ADMIN', true)
         ON CONFLICT (telegram_id) DO UPDATE SET active = true`,
      )
      .bind(telegramId)
      .run();

    await handleUpdate(db, types(updateId, telegramId, '/panel'));
    const listed = await handleUpdate(db, press(updateId + 1, telegramId, 'clm'));

    expect(listed.replies[0]?.text).not.toBe(menu.NOT_REGISTERED);
    expect(listed.status).toBe('processed');
  });
});

describe('what a SUPPORT operator may do', () => {
  // Until 2026-08-14 the answer was "everything". `adminFor` proved the sender
  // was an admin and nothing ever asked which kind; `admin.role` reached one
  // line of the whole file, inside `audit()`, to translate SUPPORT into
  // REVIEWER for the log. So the escalation was recorded and permitted.
  //
  // Measured against the dashboard rather than against itself: the same
  // operation over HTTP is behind `role !== 'ADMIN'` on all 14 write routes.

  it('may still read the queue', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId, 'SUPPORT');
    const customer = ids().telegramId;
    await makeCustomer(customer);
    const { claimId } = await makeClaim(customer);

    for (const [i, data] of ['pnl', 'clm', `clv:${claimId}`].entries()) {
      const out = await handleUpdate(db, press(updateId + i, telegramId, data));
      expect(out.status, data).toBe('processed');
      expect(out.replies[0]?.text, data).not.toContain('دسترس نقش شما');
    }
  });

  it('cannot mark an order paid with no bank transaction behind it', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId, 'SUPPORT');
    const customer = ids().telegramId;
    await makeCustomer(customer);
    const { claimId } = await makeClaim(customer);

    await handleUpdate(db, press(updateId, telegramId, `clv:${claimId}`));
    const asked = await handleUpdate(db, press(updateId + 1, telegramId, 'apx'));
    const confirmed = await handleUpdate(db, press(updateId + 2, telegramId, 'cnf'));

    expect(asked.replies[0]?.text).toBe(menu.ADMIN_NOT_ALLOWED);
    expect(confirmed.replies[0]?.text).toBe(menu.ADMIN_NOT_ALLOWED);
    // The claim is untouched — this is the assertion that matters.
    const claim = await db
      .prepare(`SELECT status FROM payment_claims WHERE id = ?1`)
      .bind(claimId)
      .first<{ status: string }>();
    expect(claim?.status).toBe('PENDING');
  });

  it('cannot approve against a real transaction either', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId, 'SUPPORT');
    const customer = ids().telegramId;
    await makeCustomer(customer);
    const { claimId, transactionId } = await makeClaim(customer, { withTransaction: true });

    await handleUpdate(db, press(updateId, telegramId, `clv:${claimId}`));
    const out = await handleUpdate(db, press(updateId + 1, telegramId, `apv:${transactionId}`));

    expect(out.replies[0]?.text).toBe(menu.ADMIN_NOT_ALLOWED);
    const match = await db
      .prepare(`SELECT count(*)::int AS n FROM reconciliation_matches WHERE payment_claim_id = ?1`)
      .bind(claimId)
      .first<{ n: number }>();
    expect(match?.n).toBe(0);
  });

  it('cannot reject one', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId, 'SUPPORT');
    const customer = ids().telegramId;
    await makeCustomer(customer);
    const { claimId } = await makeClaim(customer);

    await handleUpdate(db, press(updateId, telegramId, `clv:${claimId}`));
    await handleUpdate(db, press(updateId + 1, telegramId, 'rej'));
    await handleUpdate(db, press(updateId + 2, telegramId, 'cnf'));

    const claim = await db
      .prepare(`SELECT status FROM payment_claims WHERE id = ?1`)
      .bind(claimId)
      .first<{ status: string }>();
    expect(claim?.status).toBe('PENDING');
  });

  it('leaves the refusal in the audit log', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId, 'SUPPORT');
    const customer = ids().telegramId;
    await makeCustomer(customer);
    const { claimId } = await makeClaim(customer);

    await handleUpdate(db, press(updateId, telegramId, `clv:${claimId}`));
    await handleUpdate(db, press(updateId + 1, telegramId, 'apx'));

    const row = await db
      .prepare(
        `SELECT action, reason FROM audit_logs
          WHERE actor_telegram_id = ?1 AND action = 'claim.action.refused'`,
      )
      .bind(telegramId)
      .first<{ action: string; reason: string | null }>();
    expect(row?.reason).toContain('SUPPORT');
  });

  it('does not stop an OWNER or an ADMIN', async () => {
    for (const role of ['OWNER', 'ADMIN'] as const) {
      const { updateId, telegramId } = ids();
      await makeAdmin(telegramId, role);
      const customer = ids().telegramId;
      await makeCustomer(customer);
      const { claimId, transactionId } = await makeClaim(customer, { withTransaction: true });

      await handleUpdate(db, press(updateId, telegramId, `clv:${claimId}`));
      const out = await handleUpdate(db, press(updateId + 1, telegramId, `apv:${transactionId}`));

      expect(out.replies[0]?.text, role).toContain('تایید شد');
    }
  });
});

describe('per-operator permissions', () => {
  // The role is now a default, not the rule. `admins.permissions` has existed
  // since `0005_ops.sql` and nothing ever read it; every production row holds
  // `{}`, which is why an empty object has to keep meaning what the role has
  // always meant rather than deny-all.

  const buttons = (out: { replies: { keyboard?: { callback_data: string }[][] }[] }) =>
    (out.replies[0]?.keyboard ?? []).flat().map((b) => b.callback_data);

  it('lets a SUPPORT operator reject once that is granted, and no more', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId, 'SUPPORT', { 'claims.reject': true });
    const customer = ids().telegramId;
    await makeCustomer(customer);
    const { claimId } = await makeClaim(customer);

    await handleUpdate(db, press(updateId, telegramId, `clv:${claimId}`));
    await handleUpdate(db, press(updateId + 1, telegramId, 'rej'));
    await handleUpdate(db, press(updateId + 2, telegramId, 'cnf'));

    const claim = await db
      .prepare(`SELECT status FROM payment_claims WHERE id = ?1`)
      .bind(claimId)
      .first<{ status: string }>();
    expect(claim?.status).toBe('REJECTED');

    // Granting one decision grants exactly one: approving without a bank
    // transaction is still refused.
    const other = ids();
    const { claimId: second } = await makeClaim(other.telegramId);
    await handleUpdate(db, press(updateId + 3, telegramId, `clv:${second}`));
    const refused = await handleUpdate(db, press(updateId + 4, telegramId, 'apx'));
    expect(refused.replies[0]?.text).toBe(menu.ADMIN_NOT_ALLOWED);
  });

  it('takes a decision away from an ADMIN when it is revoked', async () => {
    // The other direction: the default is "everything", and `false` overrides.
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId, 'ADMIN', { 'claims.approve_without_tx': false });
    const customer = ids().telegramId;
    await makeCustomer(customer);
    const { claimId } = await makeClaim(customer);

    await handleUpdate(db, press(updateId, telegramId, `clv:${claimId}`));
    const out = await handleUpdate(db, press(updateId + 1, telegramId, 'apx'));
    expect(out.replies[0]?.text).toBe(menu.ADMIN_NOT_ALLOWED);

    const claim = await db
      .prepare(`SELECT status FROM payment_claims WHERE id = ?1`)
      .bind(claimId)
      .first<{ status: string }>();
    expect(claim?.status).toBe('PENDING');
  });

  it('does not draw a button the operator would be refused', async () => {
    // Not a guard — `callback_data` is a field anyone can post and the refusal
    // above stands on its own. This is so the shop does not look broken.
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId, 'SUPPORT');
    const customer = ids().telegramId;
    await makeCustomer(customer);
    const { claimId, transactionId } = await makeClaim(customer, { withTransaction: true });

    const detail = await handleUpdate(db, press(updateId, telegramId, `clv:${claimId}`));
    const shown = buttons(detail);
    expect(shown).not.toContain('apx');
    expect(shown).not.toContain('rej');
    expect(shown.some((d) => d.startsWith('apv:'))).toBe(false);
    // The way back is not a permission, and is still there.
    expect(shown).toContain('clm');

    // An ADMIN on the same claim sees all three.
    const boss = ids();
    await makeAdmin(boss.telegramId, 'ADMIN');
    const asAdmin = await handleUpdate(db, press(boss.updateId, boss.telegramId, `clv:${claimId}`));
    const bossButtons = buttons(asAdmin);
    expect(bossButtons).toContain('apx');
    expect(bossButtons).toContain('rej');
    expect(bossButtons).toContain(`apv:${transactionId}`);
  });

  it('hides the queue from an operator who may not read it', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId, 'SUPPORT', { 'claims.view': false });
    const customer = ids().telegramId;
    await makeCustomer(customer);
    await makeClaim(customer);

    const panel = await handleUpdate(db, types(updateId, telegramId, '/panel'));
    expect(buttons(panel)).not.toContain('clm');

    // And pressing it anyway is refused, because the keyboard is not the guard.
    const forged = await handleUpdate(db, press(updateId + 1, telegramId, 'clm'));
    expect(forged.replies[0]?.text).toBe(menu.ADMIN_NOT_ALLOWED);
  });

  it('never locks an OWNER out of their own shop', async () => {
    // An owner who could revoke their own `claims.view` would close the payment
    // queue with no way back that does not involve SQL.
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId, 'OWNER', {
      'claims.view': false,
      'claims.approve': false,
      'claims.reject': false,
      'claims.approve_without_tx': false,
    });
    const customer = ids().telegramId;
    await makeCustomer(customer);
    const { claimId } = await makeClaim(customer);

    const out = await handleUpdate(db, press(updateId, telegramId, `clv:${claimId}`));
    expect(out.replies[0]?.text).not.toBe(menu.ADMIN_NOT_ALLOWED);
    expect(buttons(out)).toContain('apx');
  });

  it('ignores a permissions column that is not an object', async () => {
    // Hand-edited rows exist. An array or a string reads as "nothing set",
    // which falls back to the role — not to deny-all, and not to a crash.
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId, 'ADMIN');
    await db
      .prepare(`UPDATE admins SET permissions = '["claims.approve"]'::jsonb WHERE telegram_id = ?1`)
      .bind(telegramId)
      .run();

    const customer = ids().telegramId;
    await makeCustomer(customer);
    const { claimId } = await makeClaim(customer);
    const out = await handleUpdate(db, press(updateId, telegramId, `clv:${claimId}`));
    expect(out.replies[0]?.text).not.toBe(menu.ADMIN_NOT_ALLOWED);
    expect(buttons(out)).toContain('rej');
  });
});

describe('approving a payment', () => {
  it('settles it against the bank transaction the admin picked', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const customer = ids().telegramId;
    await makeCustomer(customer);
    const { claimId, transactionId } = await makeClaim(customer, { withTransaction: true });

    await handleUpdate(db, press(updateId, telegramId, `clv:${claimId}`));
    const out = await handleUpdate(db, press(updateId + 1, telegramId, `apv:${transactionId}`));

    expect(out.replies[0]?.text).toContain('تایید شد');
    const claim = await db
      .prepare(`SELECT status FROM payment_claims WHERE id = ?1`)
      .bind(claimId)
      .first<{ status: string }>();
    expect(claim?.status).toBe('VERIFIED');
    const match = await db
      .prepare(
        `SELECT status FROM reconciliation_matches WHERE payment_claim_id = ?1`,
      )
      .bind(claimId)
      .first<{ status: string }>();
    expect(match?.status).toBe('CONFIRMED');
  });

  it('writes down who approved it, in a table nobody can edit afterwards', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const customer = ids().telegramId;
    await makeCustomer(customer);
    const { claimId, transactionId } = await makeClaim(customer, { withTransaction: true });

    await handleUpdate(db, press(updateId, telegramId, `clv:${claimId}`));
    await handleUpdate(db, press(updateId + 1, telegramId, `apv:${transactionId}`));

    expect(await auditRows(claimId)).toEqual([
      { action: 'claim.approve', actor_telegram_id: telegramId, actor_role: 'ADMIN' },
    ]);
    // And the row cannot be rewritten. 0005 puts a trigger on it.
    await expect(
      db.prepare(`UPDATE audit_logs SET action = 'tampered' WHERE entity_id = ?1`).bind(claimId).run(),
    ).rejects.toThrow();
  });

  it('refuses a transaction that belongs to another account', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const customer = ids().telegramId;
    await makeCustomer(customer);
    const { claimId } = await makeClaim(customer);
    const other = ids().telegramId;
    await makeCustomer(other);
    const elsewhere = await makeClaim(other, { withTransaction: true });

    await handleUpdate(db, press(updateId, telegramId, `clv:${claimId}`));
    const out = await handleUpdate(
      db,
      press(updateId + 1, telegramId, `apv:${elsewhere.transactionId}`),
    );

    // The refusal is `verifyMirzabotClaim`'s, not this screen's.
    expect(out.replies[0]?.text).toContain('ACCOUNT_MISMATCH');
    const claim = await db
      .prepare(`SELECT status FROM payment_claims WHERE id = ?1`)
      .bind(claimId)
      .first<{ status: string }>();
    expect(claim?.status).toBe('PENDING');
    expect((await auditRows(claimId))[0]?.action).toBe('claim.approve.failed');
  });

  it('will not spend one bank transaction on two claims', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const first = ids().telegramId;
    await makeCustomer(first);
    const one = await makeClaim(first, { withTransaction: true });
    // A second claim for the same amount against the same account.
    const second = randomUUID();
    await db
      .prepare(
        `INSERT INTO payment_claims
           (id, external_order_id, customer_reference, expected_amount_irr,
            target_financial_account_id, submitted_at, paid_clicked_at,
            source_system, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 'MIRZABOT', 'PENDING', ?6, ?6)`,
      )
      .bind(second, `shikoo:${second.slice(0, 10)}`, String(first), AMOUNT_IRR, one.accountId, NOW_MS)
      .run();

    await handleUpdate(db, press(updateId, telegramId, `clv:${one.claimId}`));
    await handleUpdate(db, press(updateId + 1, telegramId, `apv:${one.transactionId}`));
    await handleUpdate(db, press(updateId + 2, telegramId, `clv:${second}`));
    const out = await handleUpdate(db, press(updateId + 3, telegramId, `apv:${one.transactionId}`));

    expect(out.replies[0]?.text).toContain('⛔');
    const claim = await db
      .prepare(`SELECT status FROM payment_claims WHERE id = ?1`)
      .bind(second)
      .first<{ status: string }>();
    expect(claim?.status).toBe('PENDING');
  });
});

describe('the two decisions that need confirming', () => {
  it('does not settle without a transaction until it is confirmed', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const customer = ids().telegramId;
    await makeCustomer(customer);
    const { claimId } = await makeClaim(customer);

    await handleUpdate(db, press(updateId, telegramId, `clv:${claimId}`));
    const asked = await handleUpdate(db, press(updateId + 1, telegramId, 'apx'));
    expect(asked.replies[0]?.text).toBe(menu.CONFIRM_APPROVE_WITHOUT_TX);
    let claim = await db
      .prepare(`SELECT status FROM payment_claims WHERE id = ?1`)
      .bind(claimId)
      .first<{ status: string }>();
    expect(claim?.status).toBe('PENDING');

    await handleUpdate(db, press(updateId + 2, telegramId, 'cnf'));

    claim = await db
      .prepare(`SELECT status FROM payment_claims WHERE id = ?1`)
      .bind(claimId)
      .first<{ status: string }>();
    expect(claim?.status).toBe('VERIFIED');
    expect((await auditRows(claimId))[0]?.action).toBe('claim.approve.no_transaction');
  });

  it('rejects only after confirming, and says so in the ledger', async () => {
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const customer = ids().telegramId;
    await makeCustomer(customer);
    const { claimId } = await makeClaim(customer);

    await handleUpdate(db, press(updateId, telegramId, `clv:${claimId}`));
    await handleUpdate(db, press(updateId + 1, telegramId, 'rej'));
    await handleUpdate(db, press(updateId + 2, telegramId, 'cnf'));

    const claim = await db
      .prepare(`SELECT status FROM payment_claims WHERE id = ?1`)
      .bind(claimId)
      .first<{ status: string }>();
    expect(claim?.status).toBe('REJECTED');
    expect((await auditRows(claimId))[0]?.action).toBe('claim.reject');
  });

  it('confirms nothing when nothing was asked', async () => {
    // A `cnf` on its own must not settle whatever claim was last looked at.
    const { updateId, telegramId } = ids();
    await makeAdmin(telegramId);
    const customer = ids().telegramId;
    await makeCustomer(customer);
    const { claimId } = await makeClaim(customer);

    await handleUpdate(db, press(updateId, telegramId, `clv:${claimId}`));
    const out = await handleUpdate(db, press(updateId + 1, telegramId, 'cnf'));

    expect(out.replies[0]?.text).toBe(menu.CLAIM_GONE);
    const claim = await db
      .prepare(`SELECT status FROM payment_claims WHERE id = ?1`)
      .bind(claimId)
      .first<{ status: string }>();
    expect(claim?.status).toBe('PENDING');
  });
});
