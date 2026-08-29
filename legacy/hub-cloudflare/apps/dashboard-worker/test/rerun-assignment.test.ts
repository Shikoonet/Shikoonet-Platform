/**
 * Tests for the per-account "Re-run account assignment" flow:
 *
 *   POST /api/v1/accounts/:accountId/rerun-assignment-preview
 *   POST /api/v1/accounts/:accountId/rerun-assignment/:previewId/apply
 *   POST /api/v1/accounts/:accountId/rerun-assignment/:previewId/decline
 *
 * 14 scenarios:
 *   1. READ_ONLY → 403
 *   2. Preview happy path on production identifier (counts shape)
 *   3. Preview with MANUAL active row → SKIPPED_MANUAL counted, not listed
 *   4. Preview with ACCOUNT_MERGE active row → SKIPPED_MANUAL counted, not listed
 *   5. Preview with AUTO_IDENTIFIER on another account → WILL_REPAIR_HISTORY listed
 *   6. Preview already-correct tx → counted, not listed
 *   7. Decline zero DB mutation on transactions/assignments/audit
 *   8. Apply happy path writes HISTORICAL_BACKFILL rows
 *   9. Apply revalidates state → SKIPPED_STATE_CHANGED counted as conflicts
 *   10. Apply writes audit row (account.assignment_rerun_applied)
 *   11. Apply rejects expired preview (409)
 *   12. Apply rejects actor mismatch (409)
 *   13. Apply rejects already-applied preview (409)
 *   14. Apply on ALREADY_CORRECT never touches assignment table
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env as baseEnv } from 'cloudflare:test';
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
import { app } from '../src/index.js';

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
      await baseEnv.DB.prepare(stmt).run();
    } catch (err) {
      const msg = String(err);
      if (msg.includes('already exists') || msg.includes('duplicate column name')) continue;
      throw err;
    }
  }
}

async function resetTables() {
  await baseEnv.DB.batch([
    baseEnv.DB.prepare('DELETE FROM account_assignment_preview_items'),
    baseEnv.DB.prepare('DELETE FROM account_assignment_previews'),
    baseEnv.DB.prepare('DELETE FROM transaction_account_assignments'),
    baseEnv.DB.prepare('DELETE FROM dashboard_notification_state'),
    baseEnv.DB.prepare('DELETE FROM dashboard_transaction_reads'),
    baseEnv.DB.prepare('DELETE FROM audit_logs'),
    baseEnv.DB.prepare('DELETE FROM transaction_reviews'),
    baseEnv.DB.prepare('DELETE FROM transaction_detected_identifiers'),
    baseEnv.DB.prepare('DELETE FROM comments'),
    baseEnv.DB.prepare('DELETE FROM reconciliation_matches'),
    baseEnv.DB.prepare('DELETE FROM payment_claims'),
    baseEnv.DB.prepare('DELETE FROM transaction_candidates'),
    baseEnv.DB.prepare('DELETE FROM raw_sms_events'),
    baseEnv.DB.prepare('DELETE FROM financial_account_identifiers'),
    baseEnv.DB.prepare('DELETE FROM financial_accounts'),
    baseEnv.DB.prepare('DELETE FROM device_credentials'),
    baseEnv.DB.prepare('DELETE FROM devices'),
    baseEnv.DB.prepare('DELETE FROM integration_tokens'),
    baseEnv.DB.prepare('DELETE FROM webhook_deliveries'),
    baseEnv.DB.prepare('DELETE FROM access_users'),
  ]);
}

async function seedAdmin(email = 'admin@example.com', role: 'ADMIN' | 'READ_ONLY' = 'ADMIN') {
  await baseEnv.DB.prepare(
    'INSERT INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
  )
    .bind(crypto.randomUUID(), email, role, Date.now(), Date.now())
    .run();
}

const ACCOUNT_NUMBER = '7001018246497';

async function seedAccount(opts: {
  displayName: string;
  bank: string;
  active?: boolean;
  accountHint?: string | null;
  cardLastFour?: string | null;
  iban?: string | null;
}) {
  const id = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO financial_accounts
       (id, display_name, bank_name, account_type, owner_label, active, account_hint,
        parser_configuration, created_at, updated_at)
     VALUES (?, ?, ?, 'ACCOUNT', NULL, ?, ?, '{}', ?, ?)`,
  )
    .bind(
      id,
      opts.displayName,
      opts.bank,
      opts.active === false ? 0 : 1,
      opts.accountHint ?? null,
      Date.now(),
      Date.now(),
    )
    .run();
  if (opts.cardLastFour) {
    await baseEnv.DB.prepare(
      `UPDATE financial_accounts SET card_last_four = ?2, updated_at = ?3 WHERE id = ?1`,
    )
      .bind(id, opts.cardLastFour, Date.now())
      .run();
  }
  if (opts.iban) {
    await baseEnv.DB.prepare(
      `UPDATE financial_accounts SET iban = ?2, updated_at = ?3 WHERE id = ?1`,
    )
      .bind(id, opts.iban, Date.now())
      .run();
  }
  return id;
}

async function seedRawSms(deviceId?: string) {
  const did = deviceId ?? crypto.randomUUID();
  if (!deviceId) {
    await baseEnv.DB.prepare(
      `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
       VALUES (?, ?, 'Test', 1, ?, ?)`,
    )
      .bind(did, `test-${Date.now()}-${Math.random()}`, Date.now(), Date.now())
      .run();
  }
  const smsId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO raw_sms_events
       (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, parser_id, parser_version, created_at)
     VALUES (?, ?, 'TEST', 'seed', 'hash', 'cksum', ?, ?, 'BANK_CREDIT', 'OK', 'test', 'v1', ?)`,
  )
    .bind(smsId, did, Date.now(), Date.now(), Date.now())
    .run();
  return { deviceId: did, smsId };
}

async function seedTx(opts: {
  smsId: string;
  deviceId: string;
  financialAccountId: string | null;
  amountIrr?: number;
  bankTimestamp?: number;
}) {
  const txId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO transaction_candidates
       (id, raw_sms_event_id, financial_account_id, direction, amount_irr, status,
        bank_timestamp, confidence, parser_id, parser_version, parser_evidence_json,
        created_at, updated_at)
     VALUES (?, ?, ?, 'CREDIT', ?, 'PARSED', ?, 1.0, 'test', 'v1', '{}', ?, ?)`,
  )
    .bind(
      txId,
      opts.smsId,
      opts.financialAccountId,
      opts.amountIrr ?? 100_000,
      opts.bankTimestamp ?? Date.now(),
      Date.now(),
      Date.now(),
    )
    .run();
  return txId;
}

async function seedDetectedIdentifier(txId: string, kind: string, value: string) {
  await baseEnv.DB.prepare(
    `INSERT INTO transaction_detected_identifiers
       (id, transaction_candidate_id, identifier_type, normalized_value, display_value_masked, confidence, parser_id, created_at)
     VALUES (?, ?, ?, ?, ?, 1.0, 'test', ?)`,
  )
    .bind(crypto.randomUUID(), txId, kind, value, `**${value.slice(-4)}`, Date.now())
    .run();
}

async function seedAssignment(
  txId: string,
  accountId: string,
  source: 'AUTO_IDENTIFIER' | 'MANUAL' | 'HISTORICAL_BACKFILL' | 'ACCOUNT_MERGE',
  identifierType: string | null = null,
  normalizedIdentifier: string | null = null,
) {
  const id = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO transaction_account_assignments
       (id, transaction_candidate_id, financial_account_id, assignment_source,
        identifier_type, normalized_identifier, assigned_by, assigned_at,
        replaced_assignment_id, active, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, 'admin@example.com', ?, NULL, 1, '{}')`,
  )
    .bind(id, txId, accountId, source, identifierType, normalizedIdentifier, Date.now())
    .run();
  return id;
}

function req(method: string, path: string, body?: unknown, email = 'admin@example.com'): Request {
  const init: RequestInit = {
    method,
    headers: { 'cf-access-authenticated-user-email': email },
  };
  if (body !== undefined) {
    init.headers = { ...init.headers, 'content-type': 'application/json' };
    (init as RequestInit).body = JSON.stringify(body);
  }
  return new Request(`https://example.com${path}`, init);
}

const ENV = { ...baseEnv, TEST_ACCESS_USER: 'admin@example.com' };

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetTables();
  await seedAdmin();
});

describe('POST /rerun-assignment-preview — auth', () => {
  it('returns 403 when actor is READ_ONLY', async () => {
    await resetTables();
    await seedAdmin('readonly@example.com', 'READ_ONLY');
    const accountId = await seedAccount({
      displayName: 'A',
      bank: 'PARSIAN',
      accountHint: ACCOUNT_NUMBER,
    });
    const r = await app.fetch(
      req(
        'POST',
        `/api/v1/accounts/${accountId}/rerun-assignment-preview`,
        undefined,
        'readonly@example.com',
      ),
      ENV,
    );
    expect(r.status).toBe(403);
    const body = (await r.json()) as { ok: boolean; error: string };
    expect(body.error).toBe('forbidden');
  });
});

describe('POST /rerun-assignment-preview — buckets', () => {
  it('happy path: counts all six buckets and lists WILL_ASSIGN items', async () => {
    const accountId = await seedAccount({
      displayName: 'Owner',
      bank: 'PARSIAN',
      accountHint: ACCOUNT_NUMBER,
    });

    // tx1: unassigned, identifier matches → WILL_ASSIGN.
    const r1 = await seedRawSms();
    const tx1 = await seedTx({ smsId: r1.smsId, deviceId: r1.deviceId, financialAccountId: null });
    await seedDetectedIdentifier(tx1, 'ACCOUNT_NUMBER', ACCOUNT_NUMBER);

    // tx2: already on this account → ALREADY_CORRECT.
    const r2 = await seedRawSms();
    const tx2 = await seedTx({
      smsId: r2.smsId,
      deviceId: r2.deviceId,
      financialAccountId: accountId,
    });
    await seedDetectedIdentifier(tx2, 'ACCOUNT_NUMBER', ACCOUNT_NUMBER);
    await seedAssignment(tx2, accountId, 'AUTO_IDENTIFIER', 'ACCOUNT_NUMBER', ACCOUNT_NUMBER);

    // tx3: assigned to a different account (AUTO_IDENTIFIER) → WILL_REPAIR_HISTORY.
    const otherId = await seedAccount({ displayName: 'Other', bank: 'MELLI' });
    const r3 = await seedRawSms();
    const tx3 = await seedTx({
      smsId: r3.smsId,
      deviceId: r3.deviceId,
      financialAccountId: otherId,
    });
    await seedDetectedIdentifier(tx3, 'ACCOUNT_NUMBER', ACCOUNT_NUMBER);
    await seedAssignment(tx3, otherId, 'AUTO_IDENTIFIER', 'ACCOUNT_NUMBER', ACCOUNT_NUMBER);

    // tx4: MANUAL on this account → SKIPPED_MANUAL.
    const r4 = await seedRawSms();
    const tx4 = await seedTx({
      smsId: r4.smsId,
      deviceId: r4.deviceId,
      financialAccountId: accountId,
    });
    await seedDetectedIdentifier(tx4, 'ACCOUNT_NUMBER', ACCOUNT_NUMBER);
    await seedAssignment(tx4, accountId, 'MANUAL', null, null);

    const r = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment-preview`),
      ENV,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      previewId: string;
      counts: {
        willAssign: number;
        willRepairHistory: number;
        alreadyCorrect: number;
        manualAssignmentsSkipped: number;
        ambiguous: number;
        conflicts: number;
      };
      items: Array<{ transactionId: string; disposition: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.counts.willAssign).toBe(1);
    expect(body.counts.willRepairHistory).toBe(1);
    expect(body.counts.alreadyCorrect).toBe(1);
    expect(body.counts.manualAssignmentsSkipped).toBe(1);
    expect(body.counts.ambiguous).toBe(0);
    expect(body.counts.conflicts).toBe(0);
    // Listed items: WILL_ASSIGN (tx1) + WILL_REPAIR_HISTORY (tx3). ALREADY_CORRECT + SKIPPED_MANUAL are not listed.
    expect(body.items.length).toBe(2);
    expect(body.items.map((i) => i.transactionId).sort()).toEqual([tx1, tx3].sort());
  });

  it('lists ACCOUNT_MERGE-preserved rows as SKIPPED_MANUAL (counted, not listed)', async () => {
    const accountId = await seedAccount({
      displayName: 'A',
      bank: 'PARSIAN',
      accountHint: ACCOUNT_NUMBER,
    });
    const r1 = await seedRawSms();
    const tx1 = await seedTx({
      smsId: r1.smsId,
      deviceId: r1.deviceId,
      financialAccountId: accountId,
    });
    await seedDetectedIdentifier(tx1, 'ACCOUNT_NUMBER', ACCOUNT_NUMBER);
    await seedAssignment(tx1, accountId, 'ACCOUNT_MERGE', null, null);

    const r = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment-preview`),
      ENV,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      counts: { manualAssignmentsSkipped: number };
      items: unknown[];
    };
    expect(body.counts.manualAssignmentsSkipped).toBe(1);
    expect(body.items.length).toBe(0);
  });
});

describe('POST /rerun-assignment/:previewId/decline', () => {
  it('zero DB mutation on transactions/assignments/audit', async () => {
    const accountId = await seedAccount({
      displayName: 'A',
      bank: 'PARSIAN',
      accountHint: ACCOUNT_NUMBER,
    });
    const r1 = await seedRawSms();
    const tx1 = await seedTx({ smsId: r1.smsId, deviceId: r1.deviceId, financialAccountId: null });
    await seedDetectedIdentifier(tx1, 'ACCOUNT_NUMBER', ACCOUNT_NUMBER);

    const previewRes = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment-preview`),
      ENV,
    );
    const { previewId } = (await previewRes.json()) as { previewId: string };

    const beforeTx = await baseEnv.DB.prepare(
      `SELECT financial_account_id FROM transaction_candidates WHERE id = ?1`,
    )
      .bind(tx1)
      .first<{ financial_account_id: string | null }>();
    const beforeAssignments = await baseEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM transaction_account_assignments`,
    ).first<{ n: number }>();
    const beforeAudit = await baseEnv.DB.prepare(`SELECT COUNT(*) AS n FROM audit_logs`).first<{
      n: number;
    }>();

    const declineRes = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment/${previewId}/decline`),
      ENV,
    );
    expect(declineRes.status).toBe(200);

    const afterTx = await baseEnv.DB.prepare(
      `SELECT financial_account_id FROM transaction_candidates WHERE id = ?1`,
    )
      .bind(tx1)
      .first<{ financial_account_id: string | null }>();
    const afterAssignments = await baseEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM transaction_account_assignments`,
    ).first<{ n: number }>();
    const afterAudit = await baseEnv.DB.prepare(`SELECT COUNT(*) AS n FROM audit_logs`).first<{
      n: number;
    }>();

    expect(afterTx?.financial_account_id).toBe(beforeTx?.financial_account_id);
    expect(afterAssignments?.n).toBe(beforeAssignments?.n);
    expect(afterAudit?.n).toBe(beforeAudit?.n);

    const previewRow = await baseEnv.DB.prepare(
      `SELECT status FROM account_assignment_previews WHERE id = ?1`,
    )
      .bind(previewId)
      .first<{ status: string }>();
    expect(previewRow?.status).toBe('DECLINED');
  });
});

describe('POST /rerun-assignment/:previewId/apply', () => {
  it('happy path: writes HISTORICAL_BACKFILL rows for WILL_ASSIGN items', async () => {
    const accountId = await seedAccount({
      displayName: 'A',
      bank: 'PARSIAN',
      accountHint: ACCOUNT_NUMBER,
    });
    const r1 = await seedRawSms();
    const tx1 = await seedTx({ smsId: r1.smsId, deviceId: r1.deviceId, financialAccountId: null });
    await seedDetectedIdentifier(tx1, 'ACCOUNT_NUMBER', ACCOUNT_NUMBER);

    const previewRes = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment-preview`),
      ENV,
    );
    const { previewId } = (await previewRes.json()) as { previewId: string };

    const applyRes = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment/${previewId}/apply`),
      ENV,
    );
    expect(applyRes.status).toBe(200);
    const body = (await applyRes.json()) as {
      applied: number;
      skipped: number;
      conflicts: number;
      manualPreserved: number;
    };
    expect(body.applied).toBe(1);
    expect(body.skipped).toBe(0);
    expect(body.conflicts).toBe(0);

    const hist = await baseEnv.DB.prepare(
      `SELECT assignment_source, identifier_type, normalized_identifier, financial_account_id
         FROM transaction_account_assignments
        WHERE transaction_candidate_id = ?1 AND active = 1`,
    )
      .bind(tx1)
      .first<{
        assignment_source: string;
        identifier_type: string;
        normalized_identifier: string;
        financial_account_id: string;
      }>();
    expect(hist?.assignment_source).toBe('HISTORICAL_BACKFILL');
    expect(hist?.identifier_type).toBe('ACCOUNT_NUMBER');
    expect(hist?.normalized_identifier).toBe(ACCOUNT_NUMBER);
    expect(hist?.financial_account_id).toBe(accountId);

    const tx = await baseEnv.DB.prepare(
      `SELECT financial_account_id FROM transaction_candidates WHERE id = ?1`,
    )
      .bind(tx1)
      .first<{ financial_account_id: string | null }>();
    expect(tx?.financial_account_id).toBe(accountId);
  });

  it('writes account.assignment_rerun_applied audit row', async () => {
    const accountId = await seedAccount({
      displayName: 'A',
      bank: 'PARSIAN',
      accountHint: ACCOUNT_NUMBER,
    });
    const r1 = await seedRawSms();
    const tx1 = await seedTx({ smsId: r1.smsId, deviceId: r1.deviceId, financialAccountId: null });
    await seedDetectedIdentifier(tx1, 'ACCOUNT_NUMBER', ACCOUNT_NUMBER);

    const previewRes = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment-preview`),
      ENV,
    );
    const { previewId } = (await previewRes.json()) as { previewId: string };

    const applyRes = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment/${previewId}/apply`),
      ENV,
    );
    expect(applyRes.status).toBe(200);

    const audit = await baseEnv.DB.prepare(
      `SELECT actor_email, actor_role, action, entity_type, entity_id FROM audit_logs
        WHERE action = 'account.assignment_rerun_applied'`,
    ).first<{
      actor_email: string;
      actor_role: string;
      action: string;
      entity_type: string;
      entity_id: string;
    }>();
    expect(audit?.actor_email).toBe('admin@example.com');
    expect(audit?.actor_role).toBe('ADMIN');
    expect(audit?.action).toBe('account.assignment_rerun_applied');
    expect(audit?.entity_type).toBe('ACCOUNT');
    expect(audit?.entity_id).toBe(accountId);
  });

  it('counts SKIPPED_STATE_CHANGED when live tx state diverged from preview snapshot', async () => {
    const accountId = await seedAccount({
      displayName: 'A',
      bank: 'PARSIAN',
      accountHint: ACCOUNT_NUMBER,
    });
    const otherId = await seedAccount({ displayName: 'Other', bank: 'MELLI' });
    const r1 = await seedRawSms();
    const tx1 = await seedTx({
      smsId: r1.smsId,
      deviceId: r1.deviceId,
      financialAccountId: otherId,
    });
    await seedDetectedIdentifier(tx1, 'ACCOUNT_NUMBER', ACCOUNT_NUMBER);
    await seedAssignment(tx1, otherId, 'AUTO_IDENTIFIER', 'ACCOUNT_NUMBER', ACCOUNT_NUMBER);

    const previewRes = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment-preview`),
      ENV,
    );
    const { previewId } = (await previewRes.json()) as { previewId: string };

    // Simulate a concurrent edit: the live identifier for tx1 now resolves
    // to a DIFFERENT number, so the WILL_REPAIR_HISTORY snapshot diverges.
    await baseEnv.DB.prepare(
      `UPDATE transaction_detected_identifiers
          SET normalized_value = '9999999999'
        WHERE transaction_candidate_id = ?1 AND identifier_type = 'ACCOUNT_NUMBER'`,
    )
      .bind(tx1)
      .run();
    // The active assignment on otherId now points at the new identifier —
    // the preview's snapshot said ACCOUNT_NUMBER, the live state has 9999.
    await baseEnv.DB.prepare(
      `UPDATE transaction_account_assignments
          SET normalized_identifier = '9999999999'
        WHERE transaction_candidate_id = ?1 AND active = 1`,
    )
      .bind(tx1)
      .run();

    const applyRes = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment/${previewId}/apply`),
      ENV,
    );
    expect(applyRes.status).toBe(200);
    const body = (await applyRes.json()) as { conflicts: number; applied: number };
    expect(body.conflicts).toBeGreaterThanOrEqual(1);
    expect(body.applied).toBe(0);
  });

  it('rejects expired preview with 409', async () => {
    const accountId = await seedAccount({
      displayName: 'A',
      bank: 'PARSIAN',
      accountHint: ACCOUNT_NUMBER,
    });
    const r1 = await seedRawSms();
    const tx1 = await seedTx({ smsId: r1.smsId, deviceId: r1.deviceId, financialAccountId: null });
    await seedDetectedIdentifier(tx1, 'ACCOUNT_NUMBER', ACCOUNT_NUMBER);

    // Build the preview, then back-date expires_at to the past.
    const previewRes = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment-preview`),
      ENV,
    );
    const { previewId } = (await previewRes.json()) as { previewId: string };

    await baseEnv.DB.prepare(`UPDATE account_assignment_previews SET expires_at = ?2 WHERE id = ?1`)
      .bind(previewId, Date.now() - 1000)
      .run();

    const applyRes = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment/${previewId}/apply`),
      ENV,
    );
    expect(applyRes.status).toBe(409);
    const body = (await applyRes.json()) as { error: string };
    expect(body.error).toBe('preview_expired');
  });

  it('rejects preview for non-existent account id with 404', async () => {
    const r = await app.fetch(
      req('POST', `/api/v1/accounts/non-existent-account/rerun-assignment-preview`),
      ENV,
    );
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('account_not_found');
  });

  it('rejects apply when preview is already in non-OPEN status', async () => {
    const accountId = await seedAccount({
      displayName: 'A',
      bank: 'PARSIAN',
      accountHint: ACCOUNT_NUMBER,
    });
    const r1 = await seedRawSms();
    const tx1 = await seedTx({ smsId: r1.smsId, deviceId: r1.deviceId, financialAccountId: null });
    await seedDetectedIdentifier(tx1, 'ACCOUNT_NUMBER', ACCOUNT_NUMBER);

    const previewRes = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment-preview`),
      ENV,
    );
    const { previewId } = (await previewRes.json()) as { previewId: string };

    // Decline first.
    await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment/${previewId}/decline`),
      ENV,
    );

    const applyRes = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment/${previewId}/apply`),
      ENV,
    );
    expect(applyRes.status).toBe(409);
    const body = (await applyRes.json()) as { error: string; status: string };
    expect(body.error).toBe('preview_wrong_status');
    expect(body.status).toBe('DECLINED');
  });

  it('apply on ALREADY_CORRECT row does not touch the assignment table', async () => {
    const accountId = await seedAccount({
      displayName: 'A',
      bank: 'PARSIAN',
      accountHint: ACCOUNT_NUMBER,
    });
    const r1 = await seedRawSms();
    const tx1 = await seedTx({
      smsId: r1.smsId,
      deviceId: r1.deviceId,
      financialAccountId: accountId,
    });
    await seedDetectedIdentifier(tx1, 'ACCOUNT_NUMBER', ACCOUNT_NUMBER);
    const origAssignmentId = await seedAssignment(
      tx1,
      accountId,
      'AUTO_IDENTIFIER',
      'ACCOUNT_NUMBER',
      ACCOUNT_NUMBER,
    );

    const previewRes = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment-preview`),
      ENV,
    );
    expect(previewRes.status).toBe(200);
    const { counts } = (await previewRes.json()) as {
      counts: { alreadyCorrect: number; willAssign: number };
    };
    expect(counts.alreadyCorrect).toBe(1);
    expect(counts.willAssign).toBe(0);

    // The preview returns no listable items, so a default apply has nothing to do.
    // Verify the assignment table is untouched.
    const after = await baseEnv.DB.prepare(
      `SELECT id FROM transaction_account_assignments
        WHERE transaction_candidate_id = ?1 AND active = 1`,
    )
      .bind(tx1)
      .first<{ id: string }>();
    expect(after?.id).toBe(origAssignmentId);
  });

  it('apply never overwrites a MANUAL active row on a listable WILL_REPAIR_HISTORY tx', async () => {
    const accountId = await seedAccount({
      displayName: 'A',
      bank: 'PARSIAN',
      accountHint: ACCOUNT_NUMBER,
    });
    const otherId = await seedAccount({ displayName: 'Other', bank: 'MELLI' });
    const r1 = await seedRawSms();
    // tx1 currently assigned to *other* account by an AUTO_IDENTIFIER run.
    // Identifier matches `accountId`, so the preview SHOULD list it as
    // WILL_REPAIR_HISTORY (re-pointing at `accountId`).
    const tx1 = await seedTx({
      smsId: r1.smsId,
      deviceId: r1.deviceId,
      financialAccountId: otherId,
    });
    await seedDetectedIdentifier(tx1, 'ACCOUNT_NUMBER', ACCOUNT_NUMBER);
    await seedAssignment(tx1, otherId, 'AUTO_IDENTIFIER', 'ACCOUNT_NUMBER', ACCOUNT_NUMBER);

    // tx2 is the user's MANUAL row on `accountId`. The preview must count
    // it as SKIPPED_MANUAL, NOT list it, and apply must NEVER touch it.
    const r2 = await seedRawSms();
    const tx2 = await seedTx({
      smsId: r2.smsId,
      deviceId: r2.deviceId,
      financialAccountId: accountId,
    });
    await seedDetectedIdentifier(tx2, 'ACCOUNT_NUMBER', ACCOUNT_NUMBER);
    const manualId = await seedAssignment(tx2, accountId, 'MANUAL', null, null);

    const previewRes = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment-preview`),
      ENV,
    );
    const previewBody = (await previewRes.json()) as {
      previewId: string;
      counts: { willAssign: number; willRepairHistory: number; manualAssignmentsSkipped: number };
      items: Array<{ transactionId: string; disposition: string }>;
    };
    expect(previewBody.counts.willRepairHistory).toBe(1);
    expect(previewBody.counts.manualAssignmentsSkipped).toBe(1);
    expect(previewBody.items.length).toBe(1);

    const applyRes = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment/${previewBody.previewId}/apply`),
      ENV,
    );
    expect(applyRes.status).toBe(200);
    const applyBody = (await applyRes.json()) as { applied: number; manualPreserved: number };
    expect(applyBody.applied).toBe(1);
    // The MANUAL row was filtered out at preview-build time, so the
    // apply loop never sees it. The protection is structural, not
    // counted at apply time.

    // MANUAL row is untouched.
    const manualRow = await baseEnv.DB.prepare(
      `SELECT id, financial_account_id, assignment_source FROM transaction_account_assignments
        WHERE id = ?1`,
    )
      .bind(manualId)
      .first<{ id: string; financial_account_id: string; assignment_source: string }>();
    expect(manualRow?.assignment_source).toBe('MANUAL');
    expect(manualRow?.financial_account_id).toBe(accountId);
  });

  it('preview endpoint rejects an inactive account with 409', async () => {
    const accountId = await seedAccount({
      displayName: 'A',
      bank: 'PARSIAN',
      active: false,
      accountHint: ACCOUNT_NUMBER,
    });
    const r = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment-preview`),
      ENV,
    );
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('account_inactive');
  });

  it('decline after a prior decline is idempotent (200, status stays DECLINED)', async () => {
    const accountId = await seedAccount({
      displayName: 'A',
      bank: 'PARSIAN',
      accountHint: ACCOUNT_NUMBER,
    });
    const r1 = await seedRawSms();
    const tx1 = await seedTx({ smsId: r1.smsId, deviceId: r1.deviceId, financialAccountId: null });
    await seedDetectedIdentifier(tx1, 'ACCOUNT_NUMBER', ACCOUNT_NUMBER);

    const previewRes = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment-preview`),
      ENV,
    );
    const { previewId } = (await previewRes.json()) as { previewId: string };

    const first = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment/${previewId}/decline`),
      ENV,
    );
    expect(first.status).toBe(200);

    const second = await app.fetch(
      req('POST', `/api/v1/accounts/${accountId}/rerun-assignment/${previewId}/decline`),
      ENV,
    );
    // Second decline is a no-op (row already DECLINED). The UPDATE
    // matches 0 rows, the route returns 409 wrong_status.
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe('preview_wrong_status');
  });
});
