/**
 * «این شماره مال کدام حساب ماست؟» — the balance-chain rule, at the domain
 * seam. Every balance here is the bank's, written by the test; the rule must
 * point at the one account it chains from, and at nothing when two could.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresD1 } from '@shikoo/db';
import { recordOwnerSuggestion, suggestOwnerByBalance } from '../../src/suggestOwnerByBalance.js';

const { db, pool } = createPostgresD1();
const P = 'zz-own-';
const DEVICE = `${P}device`;
const MOM = `${P}mom`;
const OTHER = `${P}other`;
const PENDING = `${P}pending`;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 18, 9, 34, 0); // 13:04 Tehran, the Pol transfer

let seq = 0;
async function balanceText(account: string, balanceIrr: number, at: number, status = 'APPROVED'): Promise<void> {
  const id = `${P}tx-${++seq}`;
  await db
    .prepare(
      `INSERT INTO raw_sms_events (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, parser_id, parser_version, created_at)
       VALUES (?1, ?2, 'KESHAVARZI', 'seed', ?3, 'c', ?4, ?4, 'BANK_TRANSACTION', 'OK', 'keshavarzi-v1', 'v1', ?4)`,
    )
    .bind(`${P}sms-${seq}`, DEVICE, `${P}hash-${seq}`, at)
    .run();
  await db
    .prepare(
      `INSERT INTO transaction_candidates (id, raw_sms_event_id, financial_account_id, direction, amount_irr, balance_irr, status, bank_timestamp, confidence, parser_id, parser_version, parser_evidence_json, processing_disposition, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'CREDIT', 1, ?4, ?5, ?6, 1.0, 'keshavarzi-v1', 'v1', '{}', 'ACTIONABLE', ?6, ?6)`,
    )
    .bind(id, `${P}sms-${seq}`, account, balanceIrr, status, at)
    .run();
}

async function clearTexts(): Promise<void> {
  await db.prepare(`DELETE FROM transaction_candidates WHERE id LIKE ?1`).bind(`${P}%`).run();
  await db.prepare(`DELETE FROM raw_sms_events WHERE id LIKE ?1`).bind(`${P}%`).run();
}

async function purge(): Promise<void> {
  await clearTexts();
  await db.prepare(`DELETE FROM financial_accounts WHERE id LIKE ?1`).bind(`${P}%`).run();
}

beforeEach(async () => {
  await purge();
  await db
    .prepare(`INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at) VALUES (?1, ?1, 'Owner Phone', 1, 0, 0) ON CONFLICT (id) DO NOTHING`)
    .bind(DEVICE)
    .run();
  for (const [id, name, status] of [
    [MOM, 'کشاورزی-مامان', 'ACTIVE'],
    [OTHER, 'حساب دیگر', 'ACTIVE'],
    [PENDING, 'Auto: ****5299', 'PENDING'],
  ]) {
    await db
      .prepare(
        `INSERT INTO financial_accounts (id, bank_name, display_name, account_type, active, status, parser_configuration, created_at, updated_at)
         VALUES (?1, 'Keshavarzi', ?2, 'ACCOUNT', 1, ?3, '{}', 0, 0)`,
      )
      .bind(id, name, status)
      .run();
  }
});

afterAll(async () => {
  await purge();
  await pool.end();
});

// The real night: mom's last balance 2,854,098 at 06:05; the Pol transfer of
// 5,500,000 at 13:04 says balance 8,354,098.
const clue = { direction: 'CREDIT' as const, amountIrr: 5_500_000, balanceIrr: 8_354_098, at: NOW, excludeAccountId: PENDING };

describe('suggestOwnerByBalance', () => {
  it('names the one account whose last balance plus this movement is this balance', async () => {
    await balanceText(MOM, 2_854_098, NOW - 7 * HOUR);
    await balanceText(OTHER, 99_000_000, NOW - 2 * HOUR);
    expect(await suggestOwnerByBalance(db, clue)).toBe(MOM);
    await recordOwnerSuggestion(db, PENDING, MOM);
    const row = await db.prepare(`SELECT suggested_owner_id, suggested_reason FROM financial_accounts WHERE id = ?1`).bind(PENDING).first<{ suggested_owner_id: string; suggested_reason: string }>();
    expect(row).toEqual({ suggested_owner_id: MOM, suggested_reason: 'balance_chain' });
  });

  it('a withdrawal chains the other way', async () => {
    await balanceText(MOM, 8_354_098, NOW - HOUR);
    expect(await suggestOwnerByBalance(db, { ...clue, direction: 'DEBIT', amountIrr: 1_000_000, balanceIrr: 7_354_098 })).toBe(MOM);
  });

  it('says nothing when two accounts would fit, when the figure is off by one rial, or when the chain is older than three days', async () => {
    await balanceText(MOM, 2_854_098, NOW - 7 * HOUR);
    await balanceText(OTHER, 2_854_098, NOW - 3 * HOUR);
    expect(await suggestOwnerByBalance(db, clue)).toBeNull();
    await clearTexts();
    await balanceText(MOM, 2_854_099, NOW - 7 * HOUR);
    expect(await suggestOwnerByBalance(db, clue)).toBeNull();
    await clearTexts();
    await balanceText(MOM, 2_854_098, NOW - 4 * 24 * HOUR);
    expect(await suggestOwnerByBalance(db, clue)).toBeNull();
  });

  it('uses the LAST balance of each account, ignores rejected texts, and never names the pending account itself', async () => {
    await balanceText(MOM, 2_854_098, NOW - 7 * HOUR);
    await balanceText(MOM, 3_000_000, NOW - 6 * HOUR); // later, so the chain from 2,854,098 is stale
    expect(await suggestOwnerByBalance(db, clue)).toBeNull();
    await clearTexts();
    await balanceText(MOM, 2_854_098, NOW - 7 * HOUR, 'REJECTED');
    expect(await suggestOwnerByBalance(db, clue)).toBeNull();
    await clearTexts();
    await balanceText(PENDING, 2_854_098, NOW - 7 * HOUR);
    expect(await suggestOwnerByBalance(db, clue)).toBeNull();
  });
});
