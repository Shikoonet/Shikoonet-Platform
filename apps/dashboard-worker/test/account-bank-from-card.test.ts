/**
 * An account learns its bank from the first card mapped to it.
 *
 * Three of the eight banks the shop receives from — Resalat, Maskan, Mehr —
 * never write their own name in the SMS. The parser reads their money and their
 * account correctly and reports `bank: UNKNOWN`, and everything the operator
 * actually looks at takes the bank from `financial_accounts.bank_name` instead.
 * So an account whose row has no bank shows none, forever, on every screen.
 *
 * Guessing the bank from the ACCOUNT number was measured against the shop's own
 * 26 accounts on 2026-08-29 and got 15 right, 1 wrong and 10 don't-knows — and
 * the one it got wrong was a five-digit Melli account matching a thirteen-digit
 * Shahr one on four leading characters. A rule that is right 58% of the time
 * writes a wrong bank onto a money row.
 *
 * The CARD number answers the same question properly. `bank_card_prefixes` is a
 * real issuer registry, it is already in the panel for the operator to edit, and
 * the card-create route already computes `identifyBank(digits, prefixes)` for
 * the badge it returns. Filling the account's empty bank from it costs one
 * statement and invents nothing.
 *
 * It only ever FILLS. A bank an operator typed is never overwritten by an issuer
 * table that may be out of date — the same reason the route reports a Luhn
 * failure rather than refusing the save.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ACCOUNT = 'bank-from-card-account';
/** A real Bank Shahr BIN: 504706. */
const SHAHR_CARD = '5047061674560137';

async function addCard(accountId: string, cardNumber: string) {
  return app.fetch(
    new Request(`https://example.com/api/v1/accounts/${accountId}/payment-cards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      body: JSON.stringify({ cardNumber }),
    }),
    baseEnv,
  );
}

async function bankOfAccount(): Promise<string | null> {
  const row = await baseEnv.DB.prepare(`SELECT bank_name FROM financial_accounts WHERE id = ?1`)
    .bind(ACCOUNT)
    .first<{ bank_name: string }>();
  return row?.bank_name ?? null;
}

async function seedAccount(bankName: string) {
  await baseEnv.DB.prepare(`DELETE FROM payment_cards WHERE financial_account_id = ?1`)
    .bind(ACCOUNT)
    .run();
  await baseEnv.DB.prepare(`DELETE FROM financial_accounts WHERE id = ?1`).bind(ACCOUNT).run();
  await baseEnv.DB.prepare(
    `INSERT INTO financial_accounts
       (id, bank_name, display_name, owner_label, account_type, account_hint,
        card_last_four, account_last_four, iban, device_id, active,
        parser_configuration, status, created_at, updated_at)
     VALUES (?1, ?2, 'bank-from-card account', NULL, 'ACCOUNT', '10.9220133.1',
             NULL, NULL, NULL, NULL, 1, '{}', 'ACTIVE', 1, 1)`,
  )
    .bind(ACCOUNT, bankName)
    .run();
}

beforeAll(async () => {
  await applySchema();
  await baseEnv.DB.prepare(
    `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
     VALUES (?1, ?2, 'ADMIN', 1, 1, 1)
     ON CONFLICT (email) DO UPDATE SET role = 'ADMIN', active = 1`,
  )
    .bind(crypto.randomUUID(), baseEnv.TEST_ACCESS_USER!)
    .run();
  // The issuer row the fill depends on. Seeded here rather than assumed: a test
  // that passes only because somebody else's fixture happened to leave 504706
  // in the table is not testing this.
  await baseEnv.DB.prepare(
    `INSERT INTO bank_card_prefixes (prefix, bank_name, updated_at, updated_by)
     VALUES ('504706', 'SHAHR', 1, 'test')
     ON CONFLICT (prefix) DO UPDATE SET bank_name = 'SHAHR'`,
  ).run();
});

beforeEach(async () => {
  await baseEnv.DB.prepare(`DELETE FROM payment_cards WHERE card_digits = ?1`)
    .bind(SHAHR_CARD)
    .run();
});

describe('an account with no bank of its own', () => {
  it('takes the bank from the card that was just mapped to it', async () => {
    await seedAccount('');

    expect((await addCard(ACCOUNT, SHAHR_CARD)).status).toBe(200);

    expect(await bankOfAccount()).toBe('SHAHR');
  });

  it("treats the parser's «UNKNOWN» as no bank at all", async () => {
    // The seed and `autoCreatePendingAccount` write different placeholders for
    // the same idea — `''` from the auto-create path, `'UNKNOWN'` from the
    // parser's evidence. Both mean «nobody has said», and both must be fillable
    // or the fix works on half the rows.
    await seedAccount('UNKNOWN');

    await addCard(ACCOUNT, SHAHR_CARD);

    expect(await bankOfAccount()).toBe('SHAHR');
  });
});

describe('an account that already knows its bank', () => {
  it('keeps the name a person typed, even when the card disagrees', async () => {
    // The issuer table can be stale, and the operator is the authority on their
    // own account. Filling is not correcting.
    await seedAccount('بانک رسالت');

    await addCard(ACCOUNT, SHAHR_CARD);

    expect(await bankOfAccount()).toBe('بانک رسالت');
  });
});

describe('a card whose issuer is not in the table', () => {
  it('leaves the account exactly as it was', async () => {
    await seedAccount('');

    // 9999 is in no issuer row, so `identifyBank` returns null and there is
    // nothing to fill with. The account must not end up with 'null' or ''.
    const res = await addCard(ACCOUNT, '9999999999999995');

    expect(res.status).toBe(200);
    expect(await bankOfAccount()).toBe('');
  });
});
