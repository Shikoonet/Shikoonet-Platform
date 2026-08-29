/**
 * Cleanup tool tests — idempotent transition of ACTIONABLE+DEBIT rows
 * to OUTGOING_IGNORED or ADMIN_EXCLUDED.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import SHA from '../../migrations/0001_init.sql?raw';
import SHA2 from '../../migrations/0002_bank_transaction.sql?raw';
import SHA3 from '../../migrations/0003_unique_account_identifier.sql?raw';
import SHA4 from '../../migrations/0004_detected_identifiers.sql?raw';
import SHA5 from '../../migrations/0005_transaction_reviews.sql?raw';
import SHA6 from '../../migrations/0006_assignment_history_and_notifications.sql?raw';
import SHA7 from '../../migrations/0007_transaction_reads.sql?raw';
import SHA8 from '../../migrations/0008_account_assignment_previews.sql?raw';
import SHA9 from '../../migrations/0009_credit_only.sql?raw';
import SHA10 from '../../migrations/0010_account_status.sql?raw';
import SHA12CARD from '../../migrations/0012_claim_card_digits.sql?raw';

const SCHEMA = [SHA, SHA2, SHA3, SHA4, SHA5, SHA6, SHA7, SHA8, SHA9, SHA10, SHA12CARD]
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
  // Seed a device so FK to devices is satisfied.
  await env.DB.prepare(
    `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES ('d-1', 'TEST-DEVICE', 'Test', 1, 1, 1)`,
  ).run();
});

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM audit_logs`).run();
  await env.DB.prepare(`DELETE FROM transaction_detected_identifiers`).run();
  await env.DB.prepare(`DELETE FROM transaction_account_assignments`).run();
  await env.DB.prepare(`DELETE FROM reconciliation_matches`).run();
  await env.DB.prepare(`DELETE FROM transaction_candidates`).run();
  await env.DB.prepare(`DELETE FROM raw_sms_events`).run();
  await env.DB.prepare(`DELETE FROM payment_claims`).run();
});

async function seedDebitTx(
  id: string,
  disposition: 'ACTIONABLE' | 'OUTGOING_IGNORED' | 'ADMIN_EXCLUDED',
) {
  await env.DB.prepare(
    `INSERT INTO raw_sms_events (id, device_id, sender, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, created_at) VALUES (?1, 'd-1', 'S', ?2, ?3, 1, 1, 'BANK_DEBIT', 'OK', 1)`,
  )
    .bind(`ev-${id}`, `sha-${id}`, `cksum-${id}`)
    .run();
  await env.DB.prepare(
    `INSERT INTO transaction_candidates (id, raw_sms_event_id, direction, status, processing_disposition, created_at, updated_at, parser_id, parser_version, parser_evidence_json, confidence, bank_timestamp, amount_irr)
     VALUES (?1, ?2, 'DEBIT', 'PARSED', ?3, 1000, 1000, 'p', '1.0.0', '{}', 0.9, 1000, 100000)`,
  )
    .bind(id, `ev-${id}`, disposition)
    .run();
}

describe('cleanup tool', () => {
  it('dry-run reports ACTIONABLE+DEBIT rows', async () => {
    await seedDebitTx('tx-1', 'ACTIONABLE');
    await seedDebitTx('tx-2', 'OUTGOING_IGNORED');
    const { dryRunCleanupOutgoing } = await import('../src/admin/cleanup-debits.js');
    const report = await dryRunCleanupOutgoing(env.DB as never);
    expect(report.candidateDebits).toBe(1);
    expect(report.alreadyOutgoingIgnored).toBe(1);
    expect(report.rows.find((r) => r.txId === 'tx-1')).toBeTruthy();
  });

  it('apply transitions ACTIONABLE+DEBIT to OUTGOING_IGNORED', async () => {
    await seedDebitTx('tx-1', 'ACTIONABLE');
    const { dryRunCleanupOutgoing, applyCleanupOutgoing } = await import(
      '../src/admin/cleanup-debits.js'
    );
    const report = await dryRunCleanupOutgoing(env.DB as never);
    const result = await applyCleanupOutgoing(env.DB as never, report, 'admin@x', 'ADMIN');
    expect(result.applied).toBe(1);
    expect(result.conflicts).toBe(0);
    const row = await env.DB.prepare(
      `SELECT processing_disposition FROM transaction_candidates WHERE id = 'tx-1'`,
    ).first<{ processing_disposition: string }>();
    expect(row?.processing_disposition).toBe('OUTGOING_IGNORED');
  });

  it('apply is idempotent — second run applies 0', async () => {
    await seedDebitTx('tx-1', 'ACTIONABLE');
    const { dryRunCleanupOutgoing, applyCleanupOutgoing } = await import(
      '../src/admin/cleanup-debits.js'
    );
    const r1 = await dryRunCleanupOutgoing(env.DB as never);
    const a1 = await applyCleanupOutgoing(env.DB as never, r1, 'admin@x', 'ADMIN');
    expect(a1.applied).toBe(1);
    const r2 = await dryRunCleanupOutgoing(env.DB as never);
    const a2 = await applyCleanupOutgoing(env.DB as never, r2, 'admin@x', 'ADMIN');
    expect(a2.applied).toBe(0);
    expect(a2.conflicts).toBe(0);
  });

  it('raw_sms_events rows are never deleted', async () => {
    await seedDebitTx('tx-1', 'ACTIONABLE');
    const { dryRunCleanupOutgoing, applyCleanupOutgoing } = await import(
      '../src/admin/cleanup-debits.js'
    );
    const r = await dryRunCleanupOutgoing(env.DB as never);
    await applyCleanupOutgoing(env.DB as never, r, 'admin@x', 'ADMIN');
    const raw = await env.DB.prepare(`SELECT COUNT(*) AS n FROM raw_sms_events`).first<{
      n: number;
    }>();
    expect(raw?.n).toBe(1);
  });

  it('DEBIT with CONFIRMED match is set to ADMIN_EXCLUDED', async () => {
    await seedDebitTx('tx-conf', 'ACTIONABLE');
    await env.DB.prepare(
      `INSERT INTO payment_claims (id, external_order_id, expected_amount_irr, submitted_at, source_system, metadata_json, status, created_at, updated_at) VALUES ('cl-1', 'O1', 100000, 1, 'SRC', '{}', 'PENDING', 1, 1)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO reconciliation_matches (id, transaction_candidate_id, payment_claim_id, score, matching_reasons_json, mismatch_reasons_json, status, created_at, updated_at) VALUES ('m-1', 'tx-conf', 'cl-1', 0.9, '[]', '[]', 'CONFIRMED', 1, 1)`,
    ).run();
    const { dryRunCleanupOutgoing, applyCleanupOutgoing } = await import(
      '../src/admin/cleanup-debits.js'
    );
    const r = await dryRunCleanupOutgoing(env.DB as never);
    expect(r.confirmedOrVerifiedMatches).toBe(1);
    const result = await applyCleanupOutgoing(env.DB as never, r, 'admin@x', 'ADMIN');
    expect(result.conflicts).toBe(1);
    expect(result.applied).toBe(0);
    const row = await env.DB.prepare(
      `SELECT processing_disposition FROM transaction_candidates WHERE id = 'tx-conf'`,
    ).first<{ processing_disposition: string }>();
    expect(row?.processing_disposition).toBe('ADMIN_EXCLUDED');
  });
});
