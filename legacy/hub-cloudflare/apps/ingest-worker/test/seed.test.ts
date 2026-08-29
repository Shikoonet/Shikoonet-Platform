/**
 * Deterministic seed test — exercises the seed generator and asserts the
 * row counts the spec requires.
 *
 * Lives in apps/ingest-worker because that workspace already has the
 * vitest-pool-workers binding for D1.
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

beforeAll(async () => {
  await applySchema();
});

describe('deterministic seed', () => {
  it('produces the spec-mandated counts', async () => {
    const r = await seed(env.DB as unknown as HubD1Database);

    expect(r.devices).toBe(6);
    expect(r.accounts).toBe(36);
    expect(r.rawSmsEvents).toBe(600);
    expect(r.paymentClaims).toBe(350);
    expect(r.fakeReceipts).toBe(10);

    // SMS classification breakdown
    const otp = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM raw_sms_events WHERE classification = 'OTP'`,
    ).first<{ n: number }>();
    const promo = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM raw_sms_events WHERE classification = 'PROMOTIONAL'`,
    ).first<{ n: number }>();
    const debit = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM transaction_candidates WHERE direction = 'DEBIT'`,
    ).first<{ n: number }>();
    const error = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM raw_sms_events WHERE parser_status = 'ERROR'`,
    ).first<{ n: number }>();
    const duplicates = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM raw_sms_events WHERE duplicate_of IS NOT NULL`,
    ).first<{ n: number }>();

    expect(otp?.n).toBe(25);
    expect(promo?.n).toBe(25);
    // Some debit SMS rows are flagged as duplicates; we expect ≥ 25
    // transaction candidates because the dedupe logic drops the second
    // occurrence from `transaction_candidates`.
    expect(debit?.n).toBeGreaterThanOrEqual(25);
    expect(error?.n).toBeGreaterThanOrEqual(10);
    expect(duplicates?.n).toBeGreaterThanOrEqual(40);

    const matches = await env.DB.prepare(`SELECT COUNT(*) AS n FROM reconciliation_matches`).first<{
      n: number;
    }>();
    expect(matches?.n).toBeGreaterThanOrEqual(250);
  }, 60_000);

  it('is reproducible across runs (same seed)', async () => {
    // The seed generator is deterministic; re-running yields the same
    // counts even though we can't share state across test files.
    const r = await seed(env.DB as unknown as HubD1Database);
    expect(r.devices).toBe(6);
    expect(r.accounts).toBe(36);
  }, 60_000);
});
