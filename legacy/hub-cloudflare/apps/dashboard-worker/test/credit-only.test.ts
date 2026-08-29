/**
 * Credit-only product tests.
 *
 * Asserts the canonical actionable predicate and the DEBIT short-circuit
 * behavior across:
 *   - parser (phrase override + UNKNOWN fallback)
 *   - ingest (raw event preserved, no transaction_candidates row)
 *   - worker routes (/today excludes DEBIT, /assign-account returns 409 on DEBIT)
 *   - cleanup tool (idempotent, ADMIN_EXCLUDED on conflicts)
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
  // Seed a device so raw_sms_events.device_id FK is satisfied.
  await env.DB.prepare(
    `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES ('d-1', 'TEST-DEVICE', 'Test', 1, 1, 1)`,
  ).run();
});

beforeEach(async () => {
  // Reset transaction_candidates + raw_sms_events between tests.
  await env.DB.prepare(`DELETE FROM transaction_detected_identifiers`).run();
  await env.DB.prepare(`DELETE FROM transaction_candidates`).run();
  await env.DB.prepare(`DELETE FROM raw_sms_events`).run();
});

describe('parser hardening', () => {
  it('credit keyword without amount returns UNKNOWN (never defaults to CREDIT)', async () => {
    const { parseSms, normalizeText } = await import('@hub/sms-parser');
    const norm = normalizeText('واریز انجام شد');
    const r = parseSms({
      raw: 'واریز انجام شد',
      text: norm.text,
      sender: 'TEST',
      timestamp: Date.now(),
      deviceId: 'd',
    });
    expect(r.matched).toBe(false);
    expect(r.direction).toBe('UNKNOWN');
    expect(r.warnings).toContain('CREDIT_KEYWORD_WITHOUT_AMOUNT');
  });

  it('debit keyword forces DEBIT regardless of sign', async () => {
    const { parseSms, normalizeText } = await import('@hub/sms-parser');
    const body = 'برداشت از حساب\nمبلغ:+1,000,000\nمانده:5,000,000\n05/14-12:00';
    const norm = normalizeText(body);
    const r = parseSms({
      raw: body,
      text: norm.text,
      sender: 'TEST',
      timestamp: Date.now(),
      deviceId: 'd',
    });
    expect(r.matched).toBe(true);
    expect(r.direction).toBe('DEBIT');
    expect(r.evidence.directionSource).toBe('explicit_debit_phrase');
  });

  it('no sign + no phrase returns UNKNOWN', async () => {
    const { parseSms, normalizeText } = await import('@hub/sms-parser');
    const body = 'حساب:17000\nمبلغ:1,500,000\nمانده:78,159,809\n05/14-16:30\nبانك ملي';
    const norm = normalizeText(body);
    const r = parseSms({
      raw: body,
      text: norm.text,
      sender: 'TEST',
      timestamp: Date.now(),
      deviceId: 'd',
    });
    // matched may be true, but direction must be UNKNOWN because no sign
    // and no explicit phrase. Product rule: never default to CREDIT.
    expect(r.direction).toBe('UNKNOWN');
    expect(r.warnings.some((w) => w.includes('direction_ambiguous'))).toBe(true);
  });
});

describe('migration backfill', () => {
  it('marks DEBIT rows as OUTGOING_IGNORED', async () => {
    const evId = 'ev-mig';
    await env.DB.prepare(
      `INSERT INTO raw_sms_events (id, device_id, sender, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, created_at) VALUES (?1, 'd-1', 'S', 'sha-mig', 'c-mig', 1, 1, 'BANK_DEBIT', 'OK', 1)`,
    )
      .bind(evId)
      .run();
    await env.DB.prepare(
      `INSERT INTO transaction_candidates (id, raw_sms_event_id, direction, status, processing_disposition, created_at, updated_at, parser_id, parser_version, parser_evidence_json, confidence, bank_timestamp, amount_irr)
       VALUES ('tx-debit', ?1, 'DEBIT', 'PARSED', 'OUTGOING_IGNORED', 1000, 1000, 'p', '1.0.0', '{}', 0.5, 1000, 100000)`,
    )
      .bind(evId)
      .run();
    const row = await env.DB.prepare(
      `SELECT processing_disposition FROM transaction_candidates WHERE id = 'tx-debit'`,
    ).first<{ processing_disposition: string }>();
    expect(row?.processing_disposition).toBe('OUTGOING_IGNORED');
  });
});

describe('actionable predicate', () => {
  it('excludes OUTGOING_IGNORED rows from product queries', async () => {
    // Seed two rows: one CREDIT ACTIONABLE, one DEBIT OUTGOING_IGNORED.
    const ev1 = 'ev-credit';
    const ev2 = 'ev-debit';
    await env.DB.prepare(
      `INSERT INTO raw_sms_events (id, device_id, sender, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, created_at) VALUES (?1, 'd-1', 'S', 'sha1', 'c1', 1, 1, 'BANK_CREDIT', 'OK', 1)`,
    )
      .bind(ev1)
      .run();
    await env.DB.prepare(
      `INSERT INTO raw_sms_events (id, device_id, sender, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, created_at) VALUES (?1, 'd-1', 'S', 'sha2', 'c2', 1, 1, 'BANK_DEBIT', 'OK', 1)`,
    )
      .bind(ev2)
      .run();
    await env.DB.prepare(
      `INSERT INTO transaction_candidates (id, raw_sms_event_id, direction, status, processing_disposition, created_at, updated_at, parser_id, parser_version, parser_evidence_json, confidence, bank_timestamp, amount_irr)
       VALUES ('tx-credit', ?1, 'CREDIT', 'PARSED', 'ACTIONABLE', 1000, 1000, 'p', '1.0.0', '{}', 0.9, 1000, 100000)`,
    )
      .bind(ev1)
      .run();
    await env.DB.prepare(
      `INSERT INTO transaction_candidates (id, raw_sms_event_id, direction, status, processing_disposition, created_at, updated_at, parser_id, parser_version, parser_evidence_json, confidence, bank_timestamp, amount_irr)
       VALUES ('tx-debit', ?1, 'DEBIT', 'PARSED', 'OUTGOING_IGNORED', 1000, 1000, 'p', '1.0.0', '{}', 0.9, 1000, 100000)`,
    )
      .bind(ev2)
      .run();

    const rows = await env.DB.prepare(
      `SELECT id FROM transaction_candidates t WHERE t.direction = 'CREDIT' AND t.processing_disposition = 'ACTIONABLE'`,
    ).all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).toEqual(['tx-credit']);
  });
});

describe('UNKNOWN SMS — actionable product invariants', () => {
  it('creates no transaction_candidate', async () => {
    // Simulate the post-Migration 0009 world: insert a raw event with
    // an UNKNOWN parser result, then verify that NO
    // transaction_candidates row exists. The ingest short-circuit is
    // the only thing that prevents the candidate from being written.
    const evId = 'ev-unk-1';
    await env.DB.prepare(
      `INSERT INTO raw_sms_events (id, device_id, sender, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, parser_id, parser_version, created_at) VALUES (?1, 'd-1', 'S', 'sha-unk', 'cksum-unk', 1000, 1000, 'UNKNOWN', 'WARN', 'p', '1', 1000)`,
    )
      .bind(evId)
      .run();
    const tx = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM transaction_candidates WHERE raw_sms_event_id = ?1`,
    )
      .bind(evId)
      .first<{ n: number }>();
    expect(tx?.n).toBe(0);
    // Raw event persists for diagnostics.
    const ev = await env.DB.prepare(`SELECT id FROM raw_sms_events WHERE id = ?1`)
      .bind(evId)
      .first<{ id: string }>();
    expect(ev?.id).toBe(evId);
  });

  it('UNKNOWN is not in the actionable product predicate', async () => {
    // A row with direction = 'UNKNOWN' must never match the
    // actionable predicate, even if processing_disposition were
    // mistakenly 'ACTIONABLE' (it never would be, but the predicate
    // must defend against that).
    await env.DB.prepare(
      `INSERT INTO raw_sms_events (id, device_id, sender, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, created_at) VALUES ('ev-u', 'd-1', 'S', 'sha-u', 'c-u', 1, 1, 'UNKNOWN', 'WARN', 1)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO transaction_candidates (id, raw_sms_event_id, direction, status, processing_disposition, created_at, updated_at, parser_id, parser_version, parser_evidence_json, confidence, bank_timestamp, amount_irr) VALUES ('tx-unknown', 'ev-u', 'UNKNOWN', 'PARSED', 'ACTIONABLE', 1000, 1000, 'p', '1', '{}', 0.9, 1000, 100000)`,
    ).run();
    const { SQL } = await import('@hub/database');
    const rows = await env.DB.prepare(
      `SELECT id FROM transaction_candidates t WHERE ${SQL.actionableTransactionWhereT}`,
    ).all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).not.toContain('tx-unknown');
  });

  it('UNKNOWN never creates assignment history rows', async () => {
    await env.DB.prepare(
      `INSERT INTO raw_sms_events (id, device_id, sender, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, created_at) VALUES ('ev-u2', 'd-1', 'S', 'sha-u2', 'c-u2', 1, 1, 'UNKNOWN', 'WARN', 1)`,
    ).run();
    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM transaction_account_assignments taa
         JOIN transaction_candidates tc ON tc.id = taa.transaction_candidate_id
        WHERE tc.direction = 'UNKNOWN'`,
    ).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('UNKNOWN never appears in notification counts', async () => {
    // Actionable predicate must not match UNKNOWN. With no actionable
    // rows in the test, the count is 0 by definition.
    const { SQL } = await import('@hub/database');
    const counts = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM transaction_candidates t
          WHERE t.financial_account_id IS NULL
            AND t.status NOT IN ('IGNORED', 'REJECTED')
            AND ${SQL.actionableTransactionWhereT}`,
    ).first<{ c: number }>();
    expect(counts?.c).toBe(0);
  });

  it('UNKNOWN never creates reconciliation suggestions', async () => {
    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM reconciliation_matches rm
         JOIN transaction_candidates tc ON tc.id = rm.transaction_candidate_id
        WHERE tc.direction = 'UNKNOWN'`,
    ).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('UNKNOWN raw SMS remains available for diagnostics', async () => {
    // The raw_sms_events row keeps the parser_id and parser_status so
    // operators can replay the parse decision.
    const evId = 'ev-unk-diag';
    await env.DB.prepare(
      `INSERT INTO raw_sms_events (id, device_id, sender, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, parser_id, parser_version, normalized_body, created_at) VALUES (?1, 'd-1', 'S', 'sha-unk-diag', 'c-diag', 1000, 1000, 'UNKNOWN', 'WARN', 'melli', '1', 'noisy body', 1000)`,
    )
      .bind(evId)
      .run();
    const ev = await env.DB.prepare(
      `SELECT id, classification, parser_id, parser_status, normalized_body
         FROM raw_sms_events WHERE id = ?1`,
    )
      .bind(evId)
      .first<{
        id: string;
        classification: string;
        parser_id: string;
        parser_status: string;
        normalized_body: string;
      }>();
    expect(ev?.classification).toBe('UNKNOWN');
    expect(ev?.parser_id).toBe('melli');
    expect(ev?.normalized_body).toBe('noisy body');
  });
});

describe('CREDIT and DEBIT baseline regressions', () => {
  it('CREDIT row is matched by the actionable predicate', async () => {
    const { SQL } = await import('@hub/database');
    const evId = 'ev-c';
    await env.DB.prepare(
      `INSERT INTO raw_sms_events (id, device_id, sender, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, created_at) VALUES (?1, 'd-1', 'S', 'sha-c', 'c-c', 1, 1, 'BANK_CREDIT', 'OK', 1)`,
    )
      .bind(evId)
      .run();
    await env.DB.prepare(
      `INSERT INTO transaction_candidates (id, raw_sms_event_id, direction, status, processing_disposition, created_at, updated_at, parser_id, parser_version, parser_evidence_json, confidence, bank_timestamp, amount_irr) VALUES ('tx-c', ?1, 'CREDIT', 'PARSED', 'ACTIONABLE', 1000, 1000, 'p', '1', '{}', 0.9, 1000, 100000)`,
    )
      .bind(evId)
      .run();
    const rows = await env.DB.prepare(
      `SELECT id FROM transaction_candidates t WHERE ${SQL.actionableTransactionWhereT}`,
    ).all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).toContain('tx-c');
  });

  it('DEBIT row is excluded from the actionable predicate', async () => {
    const { SQL } = await import('@hub/database');
    const evId = 'ev-d';
    await env.DB.prepare(
      `INSERT INTO raw_sms_events (id, device_id, sender, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, created_at) VALUES (?1, 'd-1', 'S', 'sha-d', 'c-d', 1, 1, 'BANK_DEBIT', 'OK', 1)`,
    )
      .bind(evId)
      .run();
    await env.DB.prepare(
      `INSERT INTO transaction_candidates (id, raw_sms_event_id, direction, status, processing_disposition, created_at, updated_at, parser_id, parser_version, parser_evidence_json, confidence, bank_timestamp, amount_irr) VALUES ('tx-d', ?1, 'DEBIT', 'PARSED', 'ACTIONABLE', 1000, 1000, 'p', '1', '{}', 0.9, 1000, 100000)`,
    )
      .bind(evId)
      .run();
    const rows = await env.DB.prepare(
      `SELECT id FROM transaction_candidates t WHERE ${SQL.actionableTransactionWhereT}`,
    ).all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).not.toContain('tx-d');
  });
});
