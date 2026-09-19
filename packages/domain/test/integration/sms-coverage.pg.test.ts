/**
 * The two views over `raw_sms_events` that show which texts the parsers read.
 * The test plays the phone and the parsers: it writes each raw row with the
 * parser and classification a real one would carry, and a transaction row
 * where a real one would exist. Buckets are then read back and must agree
 * with what was written — never with a figure the code computed.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresD1 } from '@shikoo/db';
import { senderCoverage, unparsedShapes } from '../../src/smsCoverage.js';

const { db, pool } = createPostgresD1();
const P = 'zz-cov-';
const DEVICE = `${P}device`;
const NOW = Date.now();
const SINCE = NOW - 14 * 86_400_000;

let seq = 0;
async function raw(args: {
  sender: string;
  body: string | null;
  classification: string;
  parserId: string | null;
  at?: number;
  row?: { direction: 'CREDIT' | 'DEBIT'; balanceIrr: number | null };
}): Promise<string> {
  const id = `${P}sms-${++seq}`;
  const at = args.at ?? NOW - seq * 60_000;
  await db
    .prepare(
      `INSERT INTO raw_sms_events
         (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp,
          received_at, classification, parser_status, parser_id, parser_version, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'c', ?6, ?6, ?7, 'OK', ?8, 'v1', ?6)`,
    )
    .bind(id, DEVICE, args.sender, args.body, `${P}hash-${seq}`, at, args.classification, args.parserId)
    .run();
  if (args.row) {
    await db
      .prepare(
        `INSERT INTO transaction_candidates
           (id, raw_sms_event_id, direction, amount_irr, balance_irr, status, bank_timestamp,
            confidence, parser_id, parser_version, parser_evidence_json, processing_disposition, created_at, updated_at)
         VALUES (?1, ?2, ?3, 1000, ?4, 'PARSED', ?5, 1.0, ?6, 'v1', '{}', 'ACTIONABLE', ?5, ?5)`,
      )
      .bind(`${P}tx-${seq}`, id, args.row.direction, args.row.balanceIrr, at, args.parserId ?? 'test')
      .run();
  }
  return id;
}

async function purge(): Promise<void> {
  await db.prepare(`DELETE FROM transaction_candidates WHERE id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM raw_sms_events WHERE id LIKE ?1`).bind(`${P}%`).run();
}

beforeEach(async () => {
  await purge();
  await db
    .prepare(
      `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
       VALUES (?1, ?1, 'Coverage Phone', 1, 0, 0) ON CONFLICT (id) DO NOTHING`,
    )
    .bind(DEVICE)
    .run();
});

afterAll(async () => {
  await purge();
  await pool.end();
});

describe('senderCoverage', () => {
  it('buckets each sender: named, generic, unread, filtered — and says which parsers it saw', async () => {
    await raw({ sender: 'Bank Mellat', body: 'حساب1\nواریز1,000\nمانده5,000\n05/06/26-10:00', classification: 'BANK_TRANSACTION', parserId: 'mellat-credit-v1', row: { direction: 'CREDIT', balanceIrr: 5000 } });
    await raw({ sender: 'Bank Mellat', body: 'حساب1\nبرداشت1,000\nمانده4,000\n05/06/26-11:00', classification: 'BANK_DEBIT', parserId: 'generic-debit' });
    await raw({ sender: 'KESHAVARZI', body: 'واریز1,000\nمانده5,000\n050627-10:00\nکارت4006*\nbki. ir', classification: 'BANK_CREDIT', parserId: 'generic-credit', row: { direction: 'CREDIT', balanceIrr: 4006 } });
    await raw({ sender: 'B.QMEHRIRAN', body: null, classification: 'OTP', parserId: 'generic-otp' });
    // A transfer request whose code the scrub of 09-18 redacted, labelled UNKNOWN before #342: an OTP text all the same.
    await raw({ sender: 'B.QMEHRIRAN', body: 'انتقال وجه آنی\nاز: 300433163497\nبه: IR710570077700001508137801\nمبلغ 70,000,000 ریال\nرمز [otp-redacted]', classification: 'UNKNOWN', parserId: 'fallback-unknown' });
    await raw({ sender: 'old', body: 'x', classification: 'UNKNOWN', parserId: 'fallback-unknown', at: SINCE - 86_400_000 });

    const items = await senderCoverage(db, SINCE);
    const by = new Map(items.map((i) => [i.sender, i]));
    expect(by.get('Bank Mellat')).toMatchObject({ total: 2, named: 1, generic: 0, unread: 1, filtered: 0 });
    expect(by.get('Bank Mellat')!.parsers).toEqual(expect.arrayContaining([{ parserId: 'mellat-credit-v1', n: 1 }, { parserId: 'generic-debit', n: 1 }]));
    expect(by.get('KESHAVARZI')).toMatchObject({ total: 1, named: 0, generic: 1, unread: 0 });
    expect(by.get('B.QMEHRIRAN')).toMatchObject({ total: 2, filtered: 2, unread: 0 });
    expect(by.has('old')).toBe(false);
    // The sender with something to look at comes first.
    expect(items[0]!.sender).toBe('Bank Mellat');
  });
});

describe('unparsedShapes', () => {
  it('groups by shape with digits masked, counts, keeps the latest body as the sample, and skips what was read or filtered', async () => {
    await raw({ sender: 'Bank Maskan', body: 'انتقال: -114,750,000\nحساب:310057795083\nمانده:146,107\n0626-01:38', classification: 'BALANCE', parserId: 'generic-balance', at: NOW - 3_600_000 });
    const later = await raw({ sender: 'Bank Maskan', body: 'انتقال: -107,000,000\nحساب:310057795083\nمانده:169,524\n0626-17:54', classification: 'BALANCE', parserId: 'generic-balance', at: NOW - 60_000 });
    await raw({ sender: 'KESHAVARZI', body: 'واریز1,000\nمانده5,000\n050627-10:00\nکارت4006*\nbki. ir', classification: 'BANK_CREDIT', parserId: 'generic-credit', row: { direction: 'CREDIT', balanceIrr: 4006 } });
    await raw({ sender: 'Bank Mellat', body: 'حساب1\nواریز1,000\nمانده5,000\n05/06/26-10:00', classification: 'BANK_TRANSACTION', parserId: 'mellat-credit-v1', row: { direction: 'CREDIT', balanceIrr: 5000 } });
    await raw({ sender: 'B.QMEHRIRAN', body: null, classification: 'OTP', parserId: 'generic-otp' });
    await raw({ sender: 'B.QMEHRIRAN', body: 'انتقال وجه آنی\nمبلغ 70,000,000 ریال\nرمز [otp-redacted]', classification: 'UNKNOWN', parserId: 'fallback-unknown' });

    // Other suites leave rows on this database; look only at the senders written here.
    const ours = new Set(['Bank Maskan', 'KESHAVARZI', 'Bank Mellat', 'B.QMEHRIRAN']);
    const items = (await unparsedShapes(db, SINCE)).filter((i) => ours.has(i.sender));
    expect(items).toHaveLength(2);
    const maskan = items.find((i) => i.sender === 'Bank Maskan')!;
    expect(maskan).toMatchObject({
      count: 2,
      reason: 'unread',
      parserId: 'generic-balance',
      shape: 'انتقال: -999,999,999 | حساب:999999999999 | مانده:999,999 | 9999-99:99',
      sampleEventId: later,
    });
    expect(maskan.sampleBody).toContain('107,000,000');
    expect(items.find((i) => i.sender === 'KESHAVARZI')).toMatchObject({ count: 1, reason: 'generic', parserId: 'generic-credit' });
    // Unread before generic: what made no row is the more urgent.
    expect(items[0]!.reason).toBe('unread');
  });
});
