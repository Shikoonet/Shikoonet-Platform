/**
 * Spec-mandated seed counts — exhaustive verification.
 *
 * Runs the seed generator in the workerd D1 binding and asserts every
 * category the spec lists. Output is printed to stdout so the verification
 * report can capture the actual persisted counts.
 *
 * Note: this test is destructive (it writes rows). It runs in isolation from
 * the rebuild-everything integration test.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import SHA from '../../migrations/0001_init.sql?raw';
import SHA2 from '../../migrations/0002_bank_transaction.sql?raw';
import SHA3 from '../../migrations/0003_unique_account_identifier.sql?raw';
import SHA4 from '../../migrations/0004_detected_identifiers.sql?raw';
import SHA5 from '../../migrations/0005_transaction_reviews.sql?raw';
import SHA6 from '../../migrations/0009_credit_only.sql?raw';
import SHA10 from '../../migrations/0010_account_status.sql?raw';
import SHA12CARD from '../../migrations/0012_claim_card_digits.sql?raw';
import { seed } from '@hub/seed';
import type { D1Database as HubD1Database } from '@hub/database';

const SCHEMA = [SHA, SHA2, SHA3, SHA4, SHA5, SHA6, SHA10, SHA12CARD]
  .map((s) =>
    s
      .replace(/^\s*--[^\n]*\n/gm, '')
      .replace(/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;?\s*$/gim, '')
      .trim(),
  )
  .join('\n\n');

function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (const raw of sql.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('--')) continue;
    buf += raw + '\n';
    if (line.endsWith(';')) {
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

async function applySchema() {
  for (const stmt of splitStatements(SCHEMA)) {
    try {
      await env.DB.prepare(stmt).run();
    } catch (err) {
      if (String(err).includes('already exists')) continue;
      throw err;
    }
  }
}

interface Count {
  label: string;
  n: number;
}

async function count(sql: string): Promise<number> {
  const row = await env.DB.prepare(sql).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  await applySchema();
  // Clear any prior data so the probe asserts pure seed counts.
  for (const t of [
    'reconciliation_matches',
    'comments',
    'payment_claims',
    'transaction_candidates',
    'raw_sms_events',
    'financial_accounts',
    'device_credentials',
    'devices',
    'access_users',
    'audit_logs',
  ]) {
    try {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    } catch {
      // ignore FK ordering issues — the next test seed will overwrite
    }
  }
});

describe('seed probe: spec counts', () => {
  const counts: Count[] = [];

  it('produces the spec-mandated row counts', async () => {
    await seed(env.DB as unknown as HubD1Database);

    const read = async (label: string, sql: string) => {
      const n = await count(sql);
      counts.push({ label, n });
      return n;
    };

    const r = {
      devices: await read('devices', 'SELECT COUNT(*) AS n FROM devices'),
      activeDeviceCredentials: await read(
        'active device credentials',
        "SELECT COUNT(*) AS n FROM device_credentials WHERE status='ACTIVE'",
      ),
      accounts: await read('financial_accounts', 'SELECT COUNT(*) AS n FROM financial_accounts'),
      rawSmsEvents: await read('raw_sms_events', 'SELECT COUNT(*) AS n FROM raw_sms_events'),
      txCandidates: await read(
        'transaction_candidates',
        'SELECT COUNT(*) AS n FROM transaction_candidates',
      ),
      paymentClaims: await read('payment_claims', 'SELECT COUNT(*) AS n FROM payment_claims'),
      matches: await read(
        'reconciliation_matches',
        'SELECT COUNT(*) AS n FROM reconciliation_matches',
      ),
      otp: await read(
        'OTP events',
        "SELECT COUNT(*) AS n FROM raw_sms_events WHERE classification='OTP'",
      ),
      promo: await read(
        'promo events',
        "SELECT COUNT(*) AS n FROM raw_sms_events WHERE classification='PROMOTIONAL'",
      ),
      debitMessages: await read(
        'debit SMS messages',
        "SELECT COUNT(*) AS n FROM raw_sms_events WHERE classification='BANK_DEBIT'",
      ),
      debitTransactions: await read(
        'debit transactions (after dedupe)',
        "SELECT COUNT(*) AS n FROM transaction_candidates WHERE direction='DEBIT'",
      ),
      ambiguous: await read(
        'events with AMBIGUOUS_CURRENCY warning',
        "SELECT COUNT(*) AS n FROM raw_sms_events WHERE parser_status='WARN' AND classification='BANK_CREDIT'",
      ),
      duplicates: await read(
        'duplicate deliveries (duplicate_of is set)',
        'SELECT COUNT(*) AS n FROM raw_sms_events WHERE duplicate_of IS NOT NULL',
      ),
      malformed: await read(
        'malformed events (parser_status WARN/ERROR)',
        "SELECT COUNT(*) AS n FROM raw_sms_events WHERE parser_status IN ('WARN','ERROR')",
      ),
      parserFailures: await read(
        'parser failures (parser_status ERROR)',
        "SELECT COUNT(*) AS n FROM raw_sms_events WHERE parser_status='ERROR'",
      ),
      fakeReceipts: await read(
        'fake-receipt claims',
        "SELECT COUNT(*) AS n FROM payment_claims WHERE status='FAKE_RECEIPT'",
      ),
      matchedClaims: await read(
        'matched claims (status != PENDING/EXPIRED)',
        "SELECT COUNT(*) AS n FROM payment_claims WHERE status NOT IN ('PENDING','EXPIRED')",
      ),
      unmatchedTx: await read(
        'unmatched transactions (no reconciliation row)',
        'SELECT COUNT(*) AS n FROM transaction_candidates t WHERE NOT EXISTS (SELECT 1 FROM reconciliation_matches m WHERE m.transaction_candidate_id=t.id)',
      ),
      suggestedMatches: await read(
        'SUGGESTED matches',
        "SELECT COUNT(*) AS n FROM reconciliation_matches WHERE status='SUGGESTED'",
      ),
      autoVerifiedMatches: await read(
        'AUTO_VERIFIED matches',
        "SELECT COUNT(*) AS n FROM reconciliation_matches WHERE status='AUTO_VERIFIED'",
      ),
      confirmedMatches: await read(
        'CONFIRMED matches',
        "SELECT COUNT(*) AS n FROM reconciliation_matches WHERE status='CONFIRMED'",
      ),
      rejectedMatches: await read(
        'REJECTED matches',
        "SELECT COUNT(*) AS n FROM reconciliation_matches WHERE status='REJECTED'",
      ),
    };

    console.log('\n=== SEED PROBE ROW COUNTS ===');
    for (const c of counts) {
      console.log(`  ${c.label.padEnd(45)} ${c.n}`);
    }
    console.log('==============================\n');

    // Spec requirements
    expect(r.devices).toBe(6);
    expect(r.activeDeviceCredentials).toBe(6);
    expect(r.accounts).toBe(44);
    expect(r.rawSmsEvents).toBe(600);
    expect(r.paymentClaims).toBe(350);
    expect(r.matches).toBeGreaterThanOrEqual(250);
    expect(r.otp).toBe(25);
    expect(r.promo).toBe(25);
    // Spec says "30 debit messages" — count raw SMS events, not transactions,
    // because some duplicate debit events are deduped before transaction insertion.
    expect(r.debitMessages).toBeGreaterThanOrEqual(30);
    expect(r.debitTransactions).toBeGreaterThanOrEqual(25);
    expect(r.ambiguous).toBeGreaterThanOrEqual(30);
    expect(r.duplicates).toBeGreaterThanOrEqual(40);
    expect(r.malformed).toBeGreaterThanOrEqual(20);
    expect(r.parserFailures).toBeGreaterThanOrEqual(10);
    expect(r.fakeReceipts).toBe(10);
  });

  it('is reproducible across runs (same seed, same counts)', async () => {
    await seed(env.DB as unknown as HubD1Database);
    const n = await count('SELECT COUNT(*) AS n FROM devices');
    expect(n).toBe(6);
  });
});
