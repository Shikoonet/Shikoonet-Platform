/**
 * «بازخوانی» at the domain seam — the four things it must do and the three it
 * must not. Every text here is a bank's real shape with the digits changed;
 * every expectation is what ingest would have written had the parser existed
 * the night the text arrived.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPostgresD1 } from '@shikoo/db';
import { applyReparse, dryRunReparse } from '../../src/smsReparse.js';

const { db, pool } = createPostgresD1();
const P = 'zz-rp-';
const DEVICE = `${P}device`;
const MELLI = `${P}melli`;
const MOM = `${P}mom`;
const SAMAN = `${P}saman`;
const RESALAT = `${P}resalat`;
/** The account generic-debit minted from a year, declined as the operator found it. */
const YEAR = `${P}year`;
// The clock is pinned: the bank-clock fence is two days wide around the
// text's own date, and the window is `days` wide around now.
const NOW = Date.UTC(2026, 8, 19, 11, 0);
const SINCE = NOW - 7 * 86_400_000;

let seq = 0;
async function raw(sender: string, body: string, parserId: string, classification: string, at: number): Promise<string> {
  const id = `${P}sms-${++seq}`;
  await db
    .prepare(
      `INSERT INTO raw_sms_events (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, parser_id, parser_version, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'c', ?6, ?6, ?7, 'WARN', ?8, 'v1', ?6)`,
    )
    .bind(id, DEVICE, sender, body, `${P}hash-${seq}`, at, classification, parserId)
    .run();
  return id;
}

async function genericRow(eventId: string, account: string, direction: 'CREDIT' | 'DEBIT', amountIrr: number, balanceIrr: number, at: number): Promise<string> {
  const id = `${P}tx-${++seq}`;
  await db
    .prepare(
      `INSERT INTO transaction_candidates (id, raw_sms_event_id, financial_account_id, direction, amount_irr, balance_irr, status, bank_timestamp, confidence, parser_id, parser_version, parser_evidence_json, processing_disposition, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'APPROVED', ?7, 0.85, 'generic-credit', '1.0.0', '{}', 'ACTIONABLE', ?7, ?7)`,
    )
    .bind(id, eventId, account, direction, amountIrr, balanceIrr, at)
    .run();
  return id;
}

/** A row a named parser already made — what a re-send must find, whichever side of it arrived first. */
async function namedRow(eventId: string, account: string, direction: 'CREDIT' | 'DEBIT', amountIrr: number, balanceIrr: number, at: number): Promise<string> {
  const id = `${P}tx-${++seq}`;
  await db
    .prepare(
      `INSERT INTO transaction_candidates (id, raw_sms_event_id, financial_account_id, direction, amount_irr, balance_irr, status, bank_timestamp, confidence, parser_id, parser_version, parser_evidence_json, processing_disposition, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'APPROVED', ?7, 0.95, 'melli-transfer-v1', '1.0.0', '{}', 'ACTIONABLE', ?7, ?7)`,
    )
    .bind(id, eventId, account, direction, amountIrr, balanceIrr, at)
    .run();
  return id;
}

async function purge(): Promise<void> {
  await db.prepare(`DELETE FROM account_opening_balances WHERE financial_account_id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM reconciliation_matches WHERE id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM payment_claims WHERE id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM transaction_candidates WHERE id LIKE ?1 OR raw_sms_event_id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM raw_sms_events WHERE id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM financial_accounts WHERE id LIKE ?1`).bind(`${P}%`).run();
  // Other suites leave accounts on this database; the hints below must resolve
  // to ours, and the active-hint index must have room for them. The resolver
  // reads `status`, not `active`: a stranger left ACTIVE makes the hint
  // ambiguous and the row lands on no account.
  await db
    .prepare(
      `UPDATE financial_accounts SET active = 0, status = 'DECLINED'
        WHERE account_hint IN ('06006', '4006', '901-777-1234567-1', '10.1234567.1', '1405') AND id NOT LIKE ?1`,
    )
    .bind(`${P}%`)
    .run();
}

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  await purge();
  await db
    .prepare(`INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at) VALUES (?1, ?1, 'Reparse Phone', 1, 0, 0) ON CONFLICT (id) DO NOTHING`)
    .bind(DEVICE)
    .run();
  for (const [id, bank, name, hint, status] of [
    [MELLI, 'Meli', 'ملی', '06006', 'ACTIVE'],
    [MOM, 'Keshavarzi', 'کشاورزی-مامان', '4006', 'ACTIVE'],
    [SAMAN, 'Saman', 'سامان', '901-777-1234567-1', 'ACTIVE'],
    [RESALAT, 'Resalat', 'رسالت', '10.1234567.1', 'ACTIVE'],
    [YEAR, '', 'Auto: ****', '1405', 'DECLINED'],
  ]) {
    await db
      .prepare(
        `INSERT INTO financial_accounts (id, bank_name, display_name, account_type, account_hint, active, status, parser_configuration, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'ACCOUNT', ?4, 1, ?5, '{}', 0, 0)`,
      )
      .bind(id, bank, name, hint, status)
      .run();
  }
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await purge();
  await pool.end();
});

const MELLI_BILL = 'بانک ملی ایران\nقبض:107,000,000-\nحساب:06006\nمانده:26,481,206\n0627-00:16';
const KESHAVARZI = 'واریز1,000,000\nمانده2,854,098\n050627-06:05\nکارت4006*\nbki. ir';
// 1405/06/28, the day NOW is on — the bank's clock stays inside the two-day fence.
const SAMAN_TRANSFER = 'بانک سامان\nبرداشت مبلغ 20,000,000 انتقال وجه\nاز 901-777-1234567-1\nمانده 61,645,420\n1405/6/28\n09:33:26';
const RESALAT_FEE = '10.1234567.1\n-39,000\n06/28_12:12\nمانده: 9,308,000\nکارمزد پیامک تیر ماه 1405';
const OTP_REDACTED ='انتقال وجه آنی\nاز: 300433163497\nمبلغ 70,000,000 ریال\nرمز [otp-redacted]';

describe('dryRunReparse', () => {
  it('lists what a named parser reads now, counts what nobody reads, and skips filtered, duplicate and redacted texts', async () => {
    const at = NOW - 3_600_000;
    const bill = await raw('+98700717', MELLI_BILL, 'generic-balance', 'BALANCE', at);
    await raw('SOMEBANK', 'سلام، این پیام هیچ عددی ندارد', 'fallback-unknown', 'UNKNOWN', at);
    await raw('B.QMEHRIRAN', OTP_REDACTED, 'fallback-unknown', 'UNKNOWN', at);
    await raw('B.QMEHRIRAN', 'x', 'generic-otp', 'OTP', at);
    const dup = await raw('+98700717', MELLI_BILL, 'generic-balance', 'BALANCE', at + 60_000);
    await db.prepare(`UPDATE raw_sms_events SET duplicate_of = ?1 WHERE id = ?2`).bind(bill, dup).run();
    await raw('old', MELLI_BILL, 'generic-balance', 'BALANCE', SINCE - 86_400_000);

    const r = await dryRunReparse(db, SINCE);
    const ours = r.candidates.filter((c) => c.eventId.startsWith(P));
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({
      eventId: bill,
      was: { parserId: 'generic-balance', classification: 'BALANCE' },
      now: { parserId: 'melli-transfer-v1', direction: 'DEBIT', amountIrr: 107_000_000, balanceIrr: 26_481_206, accountHint: '06006' },
      redeliveryOf: null,
      upgrades: null,
    });
    expect(r.stillUnread).toBeGreaterThanOrEqual(1);
  });

  it('marks the second unread copy of one text as a redelivery of the first', async () => {
    const at = NOW - 2 * 3_600_000;
    const first = await raw('+98700717', MELLI_BILL, 'generic-balance', 'BALANCE', at);
    const resent = await raw('+98700717', MELLI_BILL, 'generic-balance', 'BALANCE', at + 26 * 60_000);
    const r = await dryRunReparse(db, SINCE);
    expect(r.candidates.find((c) => c.eventId === first)?.redeliveryOf).toBeNull();
    expect(r.candidates.find((c) => c.eventId === resent)?.redeliveryOf).toBe(first);
  });

  // Production, 2026-09-22: Maskan's copy arrived at 11:19 and nobody read it;
  // its twin arrived at 12:22 and made the row. Reading the 11:19 text later
  // must still find that row — a re-send is one movement, not a direction.
  it('finds the twin even when the row was made by a copy that arrived later', async () => {
    const unread = NOW - 3 * 3_600_000;
    const earlier = await raw('Bank Melli', MELLI_BILL, 'generic-balance', 'BALANCE', unread);
    const later = await raw('+98700717', MELLI_BILL, 'melli-transfer-v1', 'BANK_TRANSACTION', unread + 63 * 60_000);
    await namedRow(later, MELLI, 'DEBIT', 107_000_000, 26_481_206, unread + 63 * 60_000);

    const r = await dryRunReparse(db, SINCE);
    expect(r.candidates.find((c) => c.eventId === earlier)?.redeliveryOf).toBe(later);
  });

  it('offers to upgrade a guessed row of the same movement, and to read one nothing rests on again', async () => {
    const at = NOW - 3_600_000;
    const guessed = await raw('KESHAVARZI', KESHAVARZI, 'generic-credit', 'BANK_CREDIT', at);
    const tx = await genericRow(guessed, MOM, 'CREDIT', 1_000_000, 4006, at);
    // Same text, but the guess recorded a different amount: another movement.
    // Nothing rests on it, so the guess is offered for replacing, not upgrading.
    const other = await raw('KESHAVARZI', KESHAVARZI, 'generic-credit', 'BANK_CREDIT', at + 1);
    const otherTx = await genericRow(other, MOM, 'CREDIT', 999_999, 4006, at + 1);

    const r = await dryRunReparse(db, SINCE);
    const c = r.candidates.find((x) => x.eventId === guessed);
    expect(c).toMatchObject({ upgrades: { transactionId: tx, balanceIrr: 4006, bankTimestamp: at }, rereads: null, now: { parserId: 'keshavarzi-v1', balanceIrr: 2_854_098 } });
    expect(r.candidates.find((x) => x.eventId === other)).toMatchObject({
      upgrades: null,
      rereads: { transactionId: otherTx, accountId: MOM, amountIrr: 999_999 },
      now: { amountIrr: 1_000_000 },
    });
  });
});

describe('applyReparse', () => {
  it('makes the row through ingest\'s path, relabels the text, and applying again makes nothing', async () => {
    const at = NOW - 3_600_000;
    const bill = await raw('+98700717', MELLI_BILL, 'generic-balance', 'BALANCE', at);
    const a = await applyReparse(db, [bill, `${P}missing`]);
    expect(a.made).toHaveLength(1);
    expect(a.made[0]).toMatchObject({ eventId: bill, parserId: 'melli-transfer-v1', direction: 'DEBIT' });
    expect(a.skipped).toEqual([{ eventId: `${P}missing`, why: 'not_found' }]);
    expect(a.upgraded).toEqual([]);
    expect(a.failed).toEqual([]);
    const row = await db
      .prepare(
        `SELECT t.financial_account_id, t.processing_disposition, t.balance_irr, r.parser_id, r.classification
           FROM transaction_candidates t JOIN raw_sms_events r ON r.id = t.raw_sms_event_id WHERE r.id = ?1`,
      )
      .bind(bill)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({ financial_account_id: MELLI, processing_disposition: 'OUTGOING_IGNORED', balance_irr: 26_481_206, parser_id: 'melli-transfer-v1', classification: 'BANK_TRANSACTION' });

    const again = await applyReparse(db, [bill]);
    expect(again.made).toEqual([]);
    expect(again.skipped).toEqual([{ eventId: bill, why: 'already_has_row' }]);
  });

  it('a re-send gets duplicate_of and no row; a text nobody reads is skipped', async () => {
    const at = NOW - 2 * 3_600_000;
    const first = await raw('+98700717', MELLI_BILL, 'generic-balance', 'BALANCE', at);
    const resent = await raw('+98700717', MELLI_BILL, 'generic-balance', 'BALANCE', at + 26 * 60_000);
    const nobody = await raw('SOMEBANK', 'سلام، این پیام هیچ عددی ندارد', 'fallback-unknown', 'UNKNOWN', at);
    const a = await applyReparse(db, [first, resent, nobody]);
    expect(a.made.map((m) => m.eventId)).toEqual([first]);
    expect(a.skipped).toEqual([
      { eventId: resent, why: 'redelivery' },
      { eventId: nobody, why: 'no_longer_readable' },
    ]);
    const dup = await db.prepare(`SELECT duplicate_of FROM raw_sms_events WHERE id = ?1`).bind(resent).first<{ duplicate_of: string | null }>();
    expect(dup?.duplicate_of).toBe(first);
  });

  // The half that cost money: the dry-run offers the row, and apply makes it.
  it('makes no second row when the twin that owns the movement arrived later', async () => {
    const unread = NOW - 3 * 3_600_000;
    const earlier = await raw('Bank Melli', MELLI_BILL, 'generic-balance', 'BALANCE', unread);
    const later = await raw('+98700717', MELLI_BILL, 'melli-transfer-v1', 'BANK_TRANSACTION', unread + 63 * 60_000);
    await namedRow(later, MELLI, 'DEBIT', 107_000_000, 26_481_206, unread + 63 * 60_000);

    const a = await applyReparse(db, [earlier]);
    expect(a.made).toEqual([]);
    expect(a.skipped).toEqual([{ eventId: earlier, why: 'redelivery' }]);
    const rows = await db
      .prepare(`SELECT COUNT(*)::int AS n FROM transaction_candidates WHERE financial_account_id = ?1`)
      .bind(MELLI)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('upgrades a guessed row in place: balance and the bank\'s clock, same id, same account, same review', async () => {
    const arrival = Date.UTC(2026, 8, 18, 12, 5);
    const guessed = await raw('KESHAVARZI', KESHAVARZI, 'generic-credit', 'BANK_CREDIT', arrival);
    const tx = await genericRow(guessed, MOM, 'CREDIT', 1_000_000, 4006, arrival);
    const a = await applyReparse(db, [guessed]);
    expect(a.made).toEqual([]);
    expect(a.upgraded).toEqual([{ eventId: guessed, transactionId: tx, parserId: 'keshavarzi-v1', direction: 'CREDIT' }]);
    const rows = await db
      .prepare(`SELECT t.id, t.parser_id, t.balance_irr, t.bank_timestamp, t.status, t.financial_account_id, r.parser_id AS raw_parser FROM transaction_candidates t JOIN raw_sms_events r ON r.id = t.raw_sms_event_id WHERE r.id = ?1`)
      .bind(guessed)
      .all<{ id: string; parser_id: string; balance_irr: number; bank_timestamp: string | number; status: string; financial_account_id: string; raw_parser: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ id: tx, parser_id: 'keshavarzi-v1', balance_irr: 2_854_098, status: 'APPROVED', financial_account_id: MOM, raw_parser: 'keshavarzi-v1' });
    // 1405/06/27 06:05 Tehran, the bank's clock — not 12:05 UTC, the arrival.
    expect(Number(rows.results[0]!.bank_timestamp)).toBe(Date.UTC(2026, 8, 18, 2, 35));
    const again = await applyReparse(db, [guessed]);
    expect(again.upgraded).toEqual([]);
    expect(again.skipped).toEqual([{ eventId: guessed, why: 'already_has_row' }]);
  });

  it('upgrades a guessed row that already paid a claim — the match rests on amount and account, and neither changes', async () => {
    // Seven of the eight Keshavarzi rows on production: customer payments,
    // matched by amount, read by generic-credit. The claim must stay paid.
    const arrival = Date.UTC(2026, 8, 18, 12, 5);
    const guessed = await raw('KESHAVARZI', KESHAVARZI, 'generic-credit', 'BANK_CREDIT', arrival);
    const tx = await genericRow(guessed, MOM, 'CREDIT', 1_000_000, 4006, arrival);
    const claim = `${P}claim`;
    await db
      .prepare(
        `INSERT INTO payment_claims (id, external_order_id, expected_amount_irr, target_financial_account_id, submitted_at, source_system, status, metadata_json, suspect_metadata_json, created_at, updated_at)
         VALUES (?1, ?2, 1000000, ?3, ?4, 'test', 'VERIFIED', '{}', '{}', ?4, ?4)`,
      )
      .bind(claim, `test:${claim}`, MOM, arrival)
      .run();
    await db
      .prepare(`INSERT INTO reconciliation_matches (id, transaction_candidate_id, payment_claim_id, score, status, created_at, updated_at) VALUES (?1, ?2, ?3, 1.0, 'CONFIRMED', ?4, ?4)`)
      .bind(`${P}match`, tx, claim, arrival)
      .run();

    const dr = await dryRunReparse(db, SINCE);
    expect(dr.candidates.find((c) => c.eventId === guessed)?.upgrades?.transactionId).toBe(tx);
    const a = await applyReparse(db, [guessed]);
    expect(a.upgraded.map((u) => u.transactionId)).toEqual([tx]);
    const after = await db
      .prepare(
        `SELECT t.parser_id, t.balance_irr, t.amount_irr, t.financial_account_id, m.status AS match_status, m.payment_claim_id
           FROM transaction_candidates t JOIN reconciliation_matches m ON m.transaction_candidate_id = t.id WHERE t.id = ?1`,
      )
      .bind(tx)
      .first<Record<string, unknown>>();
    expect(after).toMatchObject({ parser_id: 'keshavarzi-v1', balance_irr: 2_854_098, amount_irr: 1_000_000, financial_account_id: MOM, match_status: 'CONFIRMED', payment_claim_id: claim });
  });

  it('moves the books\' opening with the row it was read from — balance and clock, so the ledger does not count the money twice', async () => {
    // Production, 2026-09-19: the fresh start had copied the guessed row's
    // arrival as its anchor; the upgrade moved the row 9 s onto the bank's
    // clock, and the statement counted 4,000,000 IRR as a movement after the
    // opening. The anchor follows the row.
    const arrival = Date.UTC(2026, 8, 18, 2, 34, 51);
    const guessed = await raw('KESHAVARZI', KESHAVARZI, 'generic-credit', 'BANK_CREDIT', arrival);
    const tx = await genericRow(guessed, MOM, 'CREDIT', 1_000_000, 4006, arrival);
    await db
      .prepare(`INSERT INTO account_opening_balances (financial_account_id, balance_irr, as_of, transaction_candidate_id, created_by, created_at) VALUES (?1, 4006, ?2, ?3, 'test', ?4)`)
      .bind(MOM, arrival, tx, NOW)
      .run();
    const a = await applyReparse(db, [guessed]);
    expect(a.upgraded).toHaveLength(1);
    const opening = await db
      .prepare(`SELECT balance_irr, as_of FROM account_opening_balances WHERE financial_account_id = ?1`)
      .bind(MOM)
      .first<{ balance_irr: string | number; as_of: string | number }>();
    expect(Number(opening!.balance_irr)).toBe(2_854_098);
    expect(Number(opening!.as_of)).toBe(Date.UTC(2026, 8, 18, 2, 35));
  });

  // What rests on a row is money the books counted or a person's decision;
  // either keeps the guess's account and amount. One pin of each kind.
  for (const [pin, rest] of [
    ['a person rejected it', (tx: string) => db.prepare(`UPDATE transaction_candidates SET status = 'REJECTED' WHERE id = ?1`).bind(tx).run()],
    [
      'the fresh start opened on it',
      (tx: string) =>
        db
          .prepare(`INSERT INTO account_opening_balances (financial_account_id, balance_irr, as_of, transaction_candidate_id, created_by, created_at) VALUES (?1, 4006, ?2, ?3, 'test', ?2)`)
          .bind(MOM, NOW, tx)
          .run(),
    ],
  ] as const) {
    it(`will not rewrite a guessed row into a different movement when ${pin}`, async () => {
      const at = NOW - 3_600_000;
      const guessed = await raw('KESHAVARZI', KESHAVARZI, 'generic-credit', 'BANK_CREDIT', at);
      const tx = await genericRow(guessed, MOM, 'CREDIT', 999_999, 4006, at);
      await rest(tx);
      const dr = await dryRunReparse(db, SINCE);
      expect(dr.candidates.find((c) => c.eventId === guessed)).toBeUndefined();
      const a = await applyReparse(db, [guessed]);
      expect(a.upgraded).toEqual([]);
      expect(a.reread).toEqual([]);
      expect(a.skipped).toEqual([{ eventId: guessed, why: 'no_longer_readable' }]);
      const row = await db.prepare(`SELECT id, amount_irr, balance_irr, parser_id FROM transaction_candidates WHERE raw_sms_event_id = ?1`).bind(guessed).first<Record<string, unknown>>();
      expect(row).toMatchObject({ id: tx, amount_irr: 999_999, balance_irr: 4006, parser_id: 'generic-credit' });
    });
  }

  it('reads again a guessed row nothing rests on — the year that was taken for an account, 2026-09-24', async () => {
    // Production: generic-debit read «1405» — the year — as the account of a
    // Saman transfer and of a Resalat SMS fee (the fee as 10 IRR, the «10» of
    // the account number). An account «1405» was minted and declined, and the
    // two withdrawals left the books of the accounts they belonged to.
    const at = NOW - 3 * 3_600_000;
    const saman = await raw('+989999920000', SAMAN_TRANSFER, 'generic-debit', 'BANK_DEBIT', at);
    const samanGuess = await genericRow(saman, YEAR, 'DEBIT', 20_000_000, 61_645_420, at);
    const fee = await raw('ResalatBank', RESALAT_FEE, 'generic-debit', 'BANK_DEBIT', at + 60_000);
    const feeGuess = await genericRow(fee, YEAR, 'DEBIT', 10, 9_308_000, at + 60_000);

    const dr = await dryRunReparse(db, SINCE);
    expect(dr.candidates.find((c) => c.eventId === saman)).toMatchObject({
      upgrades: null,
      rereads: { transactionId: samanGuess, accountId: YEAR, amountIrr: 20_000_000 },
      now: { parserId: 'saman-credit-v1', direction: 'DEBIT', amountIrr: 20_000_000 },
    });
    expect(dr.candidates.find((c) => c.eventId === fee)).toMatchObject({
      rereads: { transactionId: feeGuess, accountId: YEAR, amountIrr: 10 },
      now: { parserId: 'compact-signed-v1', direction: 'DEBIT', amountIrr: 39_000 },
    });

    const a = await applyReparse(db, [saman, fee]);
    expect(a.failed).toEqual([]);
    expect(a.upgraded).toEqual([]);
    expect(a.reread.map((x) => [x.eventId, x.replaced])).toEqual([
      [saman, samanGuess],
      [fee, feeGuess],
    ]);
    const rows = await db
      .prepare(
        `SELECT t.raw_sms_event_id AS ev, t.financial_account_id, t.amount_irr, t.balance_irr, t.parser_id, t.processing_disposition
           FROM transaction_candidates t WHERE t.raw_sms_event_id IN (?1, ?2) ORDER BY t.bank_timestamp`,
      )
      .bind(saman, fee)
      .all<Record<string, unknown>>();
    expect(rows.results).toEqual([
      { ev: saman, financial_account_id: SAMAN, amount_irr: 20_000_000, balance_irr: 61_645_420, parser_id: 'saman-credit-v1', processing_disposition: 'OUTGOING_IGNORED' },
      { ev: fee, financial_account_id: RESALAT, amount_irr: 39_000, balance_irr: 9_308_000, parser_id: 'compact-signed-v1', processing_disposition: 'OUTGOING_IGNORED' },
    ]);
    const onYear = await db.prepare(`SELECT COUNT(*)::int AS n FROM transaction_candidates WHERE financial_account_id = ?1`).bind(YEAR).first<{ n: number }>();
    expect(onYear?.n).toBe(0);

    const again = await applyReparse(db, [saman, fee]);
    expect(again.reread).toEqual([]);
    expect(again.skipped).toEqual([
      { eventId: saman, why: 'already_has_row' },
      { eventId: fee, why: 'already_has_row' },
    ]);
  });
});
