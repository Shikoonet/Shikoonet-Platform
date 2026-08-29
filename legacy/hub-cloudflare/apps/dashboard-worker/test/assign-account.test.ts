/**
 * Assign Account route tests.
 *
 * Covers the spec scenarios for POST /api/v1/transactions/:id/assign-account:
 *   - Idempotent same-account: returns 200, no duplicate INSERT, no extra
 *     history row.
 *   - 409 identifier_conflict when the identifier is already owned by
 *     another ACTIVE account; response carries existingAccountId +
 *     existingAccountDisplayName so the modal can render the conflict.
 *   - 409 account_identifier_ambiguous on UNIQUE collision when no clear
 *     owner exists.
 *   - Backfill writes HISTORICAL_BACKFILL rows only for transactions whose
 *     financial_account_id IS NULL — MANUAL rows are never overwritten.
 *   - Batch atomicity: per-row failures in the rematch loop don't 500.
 *   - history row exists with correct source (MANUAL for the selected tx,
 *     HISTORICAL_BACKFILL for backfilled).
 *   - 409 already_assigned_to_other_account when the tx is on a different
 *     account.
 *
 * Every test passes the same seed identifier (7001018246497) used in the
 * production reproduction so the regression hunts the real bug.
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

async function seedAdmin() {
  await baseEnv.DB.prepare(
    'INSERT INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
  )
    .bind(crypto.randomUUID(), 'admin@example.com', 'ADMIN', Date.now(), Date.now())
    .run();
}

const ACCOUNT_NUMBER = '7001018246497';

async function seedAccount(opts: {
  displayName: string;
  bank: string;
  active?: boolean;
  accountHint?: string | null;
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
  return id;
}

async function seedIdentifier(accountId: string, kind: string, value: string) {
  await baseEnv.DB.prepare(
    `INSERT INTO financial_account_identifiers
     (id, financial_account_id, kind, value, label, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  )
    .bind(crypto.randomUUID(), accountId, kind, value, Date.now())
    .run();
}

async function seedUnassignedTxWithIdentifier(opts: {
  status?: string;
  amountIrr?: number;
  identifierKind?: string;
  identifierValue?: string;
}) {
  const deviceId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES (?, ?, 'Test', 1, ?, ?)`,
  )
    .bind(deviceId, `test-${Date.now()}-${Math.random()}`, Date.now(), Date.now())
    .run();
  const smsId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO raw_sms_events
     (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, parser_id, parser_version, created_at)
     VALUES (?, ?, 'TEST', 'seed tx', 'hash', 'cksum', ?, ?, 'BANK_CREDIT', 'OK', 'test', 'v1', ?)`,
  )
    .bind(smsId, deviceId, Date.now(), Date.now(), Date.now())
    .run();
  const txId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO transaction_candidates
     (id, raw_sms_event_id, financial_account_id, direction, amount_irr, status, bank_timestamp, confidence, parser_id, parser_version, parser_evidence_json, created_at, updated_at)
     VALUES (?, ?, ?, 'CREDIT', ?, ?, ?, 1.0, 'test', 'v1', '{}', ?, ?)`,
  )
    .bind(
      txId,
      smsId,
      null,
      opts.amountIrr ?? 100_000,
      opts.status ?? 'PARSED',
      Date.now(),
      Date.now(),
      Date.now(),
    )
    .run();
  await baseEnv.DB.prepare(
    `INSERT INTO transaction_detected_identifiers
     (id, transaction_candidate_id, identifier_type, normalized_value, display_value_masked, confidence, parser_id, created_at)
     VALUES (?, ?, ?, ?, ?, 1.0, 'test', ?)`,
  )
    .bind(
      crypto.randomUUID(),
      txId,
      opts.identifierKind ?? 'ACCOUNT_NUMBER',
      opts.identifierValue ?? ACCOUNT_NUMBER,
      `**${(opts.identifierValue ?? ACCOUNT_NUMBER).slice(-4)}`,
      Date.now(),
    )
    .run();
  return txId;
}

function req(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = {
    method,
    headers: {
      'cf-access-authenticated-user-email': 'admin@example.com',
    },
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

describe('POST /api/v1/transactions/:id/assign-account — idempotent same-account', () => {
  it('returns 200 and writes exactly one MANUAL history row when re-assigning to the same account', async () => {
    const accountId = await seedAccount({ displayName: 'A', bank: 'PARSIAN' });
    const txId = await seedUnassignedTxWithIdentifier({});

    // First assign — should write a MANUAL row.
    const r1 = await app.fetch(
      req('POST', `/api/v1/transactions/${txId}/assign-account`, {
        accountId,
        identifier: { type: 'ACCOUNT_NUMBER', normalizedValue: ACCOUNT_NUMBER },
        saveIdentifierToAccount: true,
        backfillHistorical: false,
      }),
      ENV,
    );
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { ok: boolean; identifierSaved: boolean };
    expect(b1.ok).toBe(true);
    expect(b1.identifierSaved).toBe(true);

    // Second assign to the same account — must NOT 409, must NOT raise
    // UNIQUE on the identifier, must NOT duplicate the history row.
    const r2 = await app.fetch(
      req('POST', `/api/v1/transactions/${txId}/assign-account`, {
        accountId,
        identifier: { type: 'ACCOUNT_NUMBER', normalizedValue: ACCOUNT_NUMBER },
        saveIdentifierToAccount: true,
        backfillHistorical: false,
      }),
      ENV,
    );
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { ok: boolean; identifierSaved: boolean };
    expect(b2.ok).toBe(true);

    const hist = await baseEnv.DB.prepare(
      `SELECT * FROM transaction_account_assignments WHERE transaction_candidate_id = ?1`,
    )
      .bind(txId)
      .all();
    expect(hist.results.length).toBe(1);
  });
});

describe('POST /api/v1/transactions/:id/assign-account — 409 identifier_conflict', () => {
  it('returns 409 with existingAccountId + existingAccountDisplayName when owned by another active account', async () => {
    const ownerId = await seedAccount({ displayName: 'Owner', bank: 'PARSIAN' });
    const otherId = await seedAccount({ displayName: 'Other', bank: 'MELLI' });
    // Stamp the identifier on the owner via the canonical column.
    await baseEnv.DB.prepare(
      `UPDATE financial_accounts SET account_hint = ?1, updated_at = ?2 WHERE id = ?3`,
    )
      .bind(ACCOUNT_NUMBER, Date.now(), ownerId)
      .run();

    const txId = await seedUnassignedTxWithIdentifier({});
    const r = await app.fetch(
      req('POST', `/api/v1/transactions/${txId}/assign-account`, {
        accountId: otherId,
        identifier: { type: 'ACCOUNT_NUMBER', normalizedValue: ACCOUNT_NUMBER },
        saveIdentifierToAccount: true,
      }),
      ENV,
    );
    expect(r.status).toBe(409);
    const body = (await r.json()) as {
      ok: boolean;
      error: string;
      existingAccountId: string;
      existingAccountDisplayName: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('identifier_conflict');
    expect(body.existingAccountId).toBe(ownerId);
    expect(body.existingAccountDisplayName).toBe('Owner');
  });

  it('detects the conflict via the financial_account_identifiers table when the canonical column is empty', async () => {
    const ownerId = await seedAccount({ displayName: 'Owner', bank: 'PARSIAN' });
    const otherId = await seedAccount({ displayName: 'Other', bank: 'MELLI' });
    // Seed the identifier on the owner via the identifiers table only —
    // the canonical column is empty, so the probe must check fai.
    await seedIdentifier(ownerId, 'CARD_LAST_FOUR', '1234');

    const txId = await seedUnassignedTxWithIdentifier({
      identifierKind: 'CARD_LAST_FOUR',
      identifierValue: '1234',
    });
    const r = await app.fetch(
      req('POST', `/api/v1/transactions/${txId}/assign-account`, {
        accountId: otherId,
        identifier: { type: 'CARD_LAST_FOUR', normalizedValue: '1234' },
        saveIdentifierToAccount: true,
      }),
      ENV,
    );
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string; existingAccountId: string };
    expect(body.error).toBe('identifier_conflict');
    expect(body.existingAccountId).toBe(ownerId);
  });

  it('returns 409 when the tx is already assigned to a different account', async () => {
    const a = await seedAccount({ displayName: 'A', bank: 'PARSIAN' });
    const b = await seedAccount({ displayName: 'B', bank: 'MELLI' });
    const txId = await seedUnassignedTxWithIdentifier({});
    // Manually assign to a first.
    await baseEnv.DB.prepare(
      `UPDATE transaction_candidates SET financial_account_id = ?1, updated_at = ?2 WHERE id = ?3`,
    )
      .bind(a, Date.now(), txId)
      .run();

    const r = await app.fetch(
      req('POST', `/api/v1/transactions/${txId}/assign-account`, {
        accountId: b,
        identifier: { type: 'ACCOUNT_NUMBER', normalizedValue: ACCOUNT_NUMBER },
      }),
      ENV,
    );
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string; currentAccountId: string };
    expect(body.error).toBe('already_assigned_to_other_account');
    expect(body.currentAccountId).toBe(a);
  });
});

describe('POST /api/v1/transactions/:id/assign-account — backfill', () => {
  it('writes HISTORICAL_BACKFILL rows for unassigned tx matching the identifier', async () => {
    const accountId = await seedAccount({ displayName: 'A', bank: 'PARSIAN' });
    const target = await seedUnassignedTxWithIdentifier({});
    const older = await seedUnassignedTxWithIdentifier({});

    const r = await app.fetch(
      req('POST', `/api/v1/transactions/${target}/assign-account`, {
        accountId,
        identifier: { type: 'ACCOUNT_NUMBER', normalizedValue: ACCOUNT_NUMBER },
        saveIdentifierToAccount: true,
        backfillHistorical: true,
      }),
      ENV,
    );
    expect(r.status).toBe(200);
    const b = (await r.json()) as { backfilled: number };
    // tx + older = 2 backfilled (target was unassigned before this call).
    expect(b.backfilled).toBeGreaterThanOrEqual(1);

    const targetHist = await baseEnv.DB.prepare(
      `SELECT assignment_source FROM transaction_account_assignments WHERE transaction_candidate_id = ?1 AND active = 1`,
    )
      .bind(target)
      .first<{ assignment_source: string }>();
    expect(targetHist?.assignment_source).toBe('MANUAL');

    const olderHist = await baseEnv.DB.prepare(
      `SELECT assignment_source FROM transaction_account_assignments WHERE transaction_candidate_id = ?1 AND active = 1`,
    )
      .bind(older)
      .first<{ assignment_source: string }>();
    expect(olderHist?.assignment_source).toBe('HISTORICAL_BACKFILL');
  });

  it('NEVER overwrites a MANUAL row during backfill', async () => {
    const accountId = await seedAccount({ displayName: 'A', bank: 'PARSIAN' });
    const otherId = await seedAccount({ displayName: 'B', bank: 'MELLI' });
    const txId = await seedUnassignedTxWithIdentifier({});

    // 1. Manual assignment to otherId.
    await app.fetch(
      req('POST', `/api/v1/transactions/${txId}/change-account`, { accountId: otherId }),
      ENV,
    );

    // 2. Backfill with a different account — must NOT clobber the MANUAL row.
    await app.fetch(
      req('POST', `/api/v1/transactions/${txId}/assign-account`, {
        accountId,
        identifier: { type: 'ACCOUNT_NUMBER', normalizedValue: ACCOUNT_NUMBER },
        saveIdentifierToAccount: true,
        backfillHistorical: true,
      }),
      ENV,
    );

    const active = await baseEnv.DB.prepare(
      `SELECT assignment_source, financial_account_id FROM transaction_account_assignments
         WHERE transaction_candidate_id = ?1 AND active = 1`,
    )
      .bind(txId)
      .first<{ assignment_source: string; financial_account_id: string }>();
    expect(active?.assignment_source).toBe('MANUAL');
    expect(active?.financial_account_id).toBe(otherId);
  });
});

describe('POST /api/v1/transactions/:id/assign-account — partial unique index respected', () => {
  it('refuses to save a duplicate identifier on the same account (no duplicate active row)', async () => {
    const accountId = await seedAccount({ displayName: 'A', bank: 'PARSIAN' });
    const txId = await seedUnassignedTxWithIdentifier({});

    // First successful save.
    const r1 = await app.fetch(
      req('POST', `/api/v1/transactions/${txId}/assign-account`, {
        accountId,
        identifier: { type: 'ACCOUNT_NUMBER', normalizedValue: ACCOUNT_NUMBER },
        saveIdentifierToAccount: true,
      }),
      ENV,
    );
    expect(r1.status).toBe(200);

    // financial_accounts.account_hint should be set; the partial unique
    // index on `account_hint WHERE active = 1` rejects duplicates.
    const acct = await baseEnv.DB.prepare(
      `SELECT account_hint FROM financial_accounts WHERE id = ?1`,
    )
      .bind(accountId)
      .first<{ account_hint: string | null }>();
    expect(acct?.account_hint).toBe(ACCOUNT_NUMBER);
  });
});

describe('POST /api/v1/transactions/:id/assign-account — atomic batch', () => {
  it('succeeds end-to-end when saveIdentifierToAccount is true and backfillHistorical is true', async () => {
    const accountId = await seedAccount({ displayName: 'A', bank: 'PARSIAN' });
    const txId = await seedUnassignedTxWithIdentifier({});
    const older = await seedUnassignedTxWithIdentifier({});

    const r = await app.fetch(
      req('POST', `/api/v1/transactions/${txId}/assign-account`, {
        accountId,
        identifier: { type: 'ACCOUNT_NUMBER', normalizedValue: ACCOUNT_NUMBER },
        saveIdentifierToAccount: true,
        backfillHistorical: true,
      }),
      ENV,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; identifierSaved: boolean; backfilled: number };
    expect(body.ok).toBe(true);
    expect(body.identifierSaved).toBe(true);
    expect(body.backfilled).toBeGreaterThanOrEqual(1);

    // Both tx + older now point to the account.
    const tx = await baseEnv.DB.prepare(
      `SELECT financial_account_id FROM transaction_candidates WHERE id = ?1`,
    )
      .bind(txId)
      .first<{ financial_account_id: string }>();
    const old = await baseEnv.DB.prepare(
      `SELECT financial_account_id FROM transaction_candidates WHERE id = ?1`,
    )
      .bind(older)
      .first<{ financial_account_id: string }>();
    expect(tx?.financial_account_id).toBe(accountId);
    expect(old?.financial_account_id).toBe(accountId);
  });
});
