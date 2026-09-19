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

async function purge(): Promise<void> {
  await db.prepare(`DELETE FROM reconciliation_matches WHERE id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM payment_claims WHERE id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM transaction_candidates WHERE id LIKE ?1 OR raw_sms_event_id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM raw_sms_events WHERE id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM financial_accounts WHERE id LIKE ?1`).bind(`${P}%`).run();
  // Other suites leave accounts on this database; the hints below must resolve
  // to ours, and the active-hint index must have room for them.
  await db.prepare(`UPDATE financial_accounts SET active = 0 WHERE account_hint IN ('06006', '4006') AND id NOT LIKE ?1`).bind(`${P}%`).run();
}

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  await purge();
  await db
    .prepare(`INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at) VALUES (?1, ?1, 'Reparse Phone', 1, 0, 0) ON CONFLICT (id) DO NOTHING`)
    .bind(DEVICE)
    .run();
  for (const [id, bank, name, hint] of [
    [MELLI, 'Meli', 'ملی', '06006'],
    [MOM, 'Keshavarzi', 'کشاورزی-مامان', '4006'],
  ]) {
    await db
      .prepare(
        `INSERT INTO financial_accounts (id, bank_name, display_name, account_type, account_hint, active, status, parser_configuration, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'ACCOUNT', ?4, 1, 'ACTIVE', '{}', 0, 0)`,
      )
      .bind(id, bank, name, hint)
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
const OTP_REDACTED = 'انتقال وجه آنی\nاز: 300433163497\nمبلغ 70,000,000 ریال\nرمز [otp-redacted]';

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

  it('offers to upgrade a row a generic parser guessed — same movement only', async () => {
    const at = NOW - 3_600_000;
    const guessed = await raw('KESHAVARZI', KESHAVARZI, 'generic-credit', 'BANK_CREDIT', at);
    const tx = await genericRow(guessed, MOM, 'CREDIT', 1_000_000, 4006, at);
    // Same text, but the guess recorded a different amount: not the same movement, not offered.
    const other = await raw('KESHAVARZI', KESHAVARZI, 'generic-credit', 'BANK_CREDIT', at + 1);
    await genericRow(other, MOM, 'CREDIT', 999_999, 4006, at + 1);

    const r = await dryRunReparse(db, SINCE);
    const c = r.candidates.find((x) => x.eventId === guessed);
    expect(c).toMatchObject({ upgrades: { transactionId: tx, balanceIrr: 4006, bankTimestamp: at }, now: { parserId: 'keshavarzi-v1', balanceIrr: 2_854_098 } });
    expect(r.candidates.find((x) => x.eventId === other)).toBeUndefined();
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

  it('will not rewrite a guessed row into a different movement', async () => {
    const at = NOW - 3_600_000;
    const guessed = await raw('KESHAVARZI', KESHAVARZI, 'generic-credit', 'BANK_CREDIT', at);
    await genericRow(guessed, MOM, 'CREDIT', 999_999, 4006, at);
    const a = await applyReparse(db, [guessed]);
    expect(a.upgraded).toEqual([]);
    expect(a.skipped).toEqual([{ eventId: guessed, why: 'no_longer_readable' }]);
    const row = await db.prepare(`SELECT amount_irr, balance_irr, parser_id FROM transaction_candidates WHERE raw_sms_event_id = ?1`).bind(guessed).first<Record<string, unknown>>();
    expect(row).toMatchObject({ amount_irr: 999_999, balance_irr: 4006, parser_id: 'generic-credit' });
  });
});
