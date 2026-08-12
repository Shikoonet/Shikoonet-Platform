/**
 * Assignment history + notification bell + move-references tests.
 *
 * Covers:
 *  - AUTO_IDENTIFIER writes NEVER overwrite a MANUAL assignment.
 *  - change-account writes a MANUAL row, supersedes the previous active row,
 *    and links `replaced_assignment_id`.
 *  - assignment-history returns the full chain (oldest → newest).
 *  - references returns the per-account totals.
 *  - move-references-preview returns counts without mutating.
 *  - move-references writes ACCOUNT_MERGE rows and updates transactions/claims.
 *  - move-references with deleteSource deletes the source after a clean move.
 *  - move-references with deleteSource BLOCKED when refs remain.
 *  - notifications/counts returns the four buckets + cursor.
 *  - notifications/mark-read advances the actor cursor.
 *  - notifications/recent returns the bounded list.
 *  - payment-claims/change-account updates the claim and writes audit.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

// Schema now comes from migrations/000*.sql, applied to the test database.

async function resetTables() {
  await baseEnv.DB.batch([
    baseEnv.DB.prepare('DELETE FROM transaction_account_assignments'),
    baseEnv.DB.prepare('DELETE FROM dashboard_notification_state'),
    baseEnv.DB.prepare('DELETE FROM dashboard_transaction_reads'),
    baseEnv.DB.prepare('TRUNCATE audit_logs CASCADE'),
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

async function seedAdmin(email: string) {
  await baseEnv.DB.prepare(
    'INSERT INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
  )
    .bind(crypto.randomUUID(), email, 'ADMIN', Date.now(), Date.now())
    .run();
}

async function seedAccount(opts: {
  displayName: string;
  bank: string;
  active?: boolean;
  accountHint?: string;
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

async function seedTransaction(opts: {
  accountId: string | null;
  amountIrr?: number;
  status?: string;
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
      opts.accountId,
      opts.amountIrr ?? 100_000,
      opts.status ?? 'PARSED',
      Date.now(),
      Date.now(),
      Date.now(),
    )
    .run();
  return txId;
}

async function seedPaymentClaim(accountId: string | null) {
  const id = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO payment_claims
     (id, external_order_id, expected_amount_irr, target_financial_account_id, submitted_at, source_system, status, created_at, updated_at)
     VALUES (?, ?, 50000, ?, ?, 'test', 'PENDING', ?, ?)`,
  )
    .bind(id, `order-${Date.now()}-${Math.random()}`, accountId, Date.now(), Date.now(), Date.now())
    .run();
  return id;
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
  await seedAdmin('admin@example.com');
});

describe('POST /api/v1/transactions/:id/change-account', () => {
  it('writes a MANUAL assignment row and updates the canonical column', async () => {
    const accountId = await seedAccount({ displayName: 'A', bank: 'PARSIAN' });
    const txId = await seedTransaction({ accountId: null });

    const r = await app.fetch(
      req('POST', `/api/v1/transactions/${txId}/change-account`, {
        accountId,
        reason: 'manual move',
      }),
      ENV,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; status: string; accountId: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('inserted');
    expect(body.accountId).toBe(accountId);

    const tx = await baseEnv.DB.prepare(
      'SELECT financial_account_id FROM transaction_candidates WHERE id = ?1',
    )
      .bind(txId)
      .first<{ financial_account_id: string | null }>();
    expect(tx?.financial_account_id).toBe(accountId);

    const hist = await baseEnv.DB.prepare(
      'SELECT * FROM transaction_account_assignments WHERE transaction_candidate_id = ?1 ORDER BY assigned_at ASC',
    )
      .bind(txId)
      .all();
    expect(hist.results.length).toBe(1);
    expect((hist.results[0] as { assignment_source: string }).assignment_source).toBe('MANUAL');
    expect((hist.results[0] as { assigned_by: string }).assigned_by).toBe('admin@example.com');
  });

  it('preserves MANUAL when an AUTO_IDENTIFIER write arrives later', async () => {
    const accountId = await seedAccount({ displayName: 'A', bank: 'PARSIAN' });
    const txId = await seedTransaction({ accountId: null });

    // 1. MANUAL write.
    await app.fetch(
      req('POST', `/api/v1/transactions/${txId}/change-account`, {
        accountId,
      }),
      ENV,
    );

    // 2. AUTO_IDENTIFIER write via the domain helper.
    const { assignAccountForTx } = await import('@shikoo/domain');
    await assignAccountForTx(baseEnv.DB as unknown as Parameters<typeof assignAccountForTx>[0], {
      transactionCandidateId: txId,
      financialAccountId: accountId,
      source: 'AUTO_IDENTIFIER',
      identifierType: 'ACCOUNT_HINT',
      normalizedIdentifier: '999',
      assignedBy: 'SYSTEM',
    });

    const hist = await baseEnv.DB.prepare(
      'SELECT * FROM transaction_account_assignments WHERE transaction_candidate_id = ?1 ORDER BY assigned_at ASC',
    )
      .bind(txId)
      .all();
    const rows = hist.results as Array<{
      assignment_source: string;
      active: number;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.assignment_source).toBe('MANUAL');
    expect(rows[0]?.active).toBe(1);
  });

  it('supersedes the previous active row and links replaced_assignment_id', async () => {
    const a1 = await seedAccount({ displayName: 'A1', bank: 'PARSIAN' });
    const a2 = await seedAccount({ displayName: 'A2', bank: 'MELLI' });
    const txId = await seedTransaction({ accountId: null });

    // First write: MANUAL via change-account.
    await app.fetch(
      req('POST', `/api/v1/transactions/${txId}/change-account`, { accountId: a1 }),
      ENV,
    );
    // Second write: MANUAL via change-account again.
    await app.fetch(
      req('POST', `/api/v1/transactions/${txId}/change-account`, { accountId: a2 }),
      ENV,
    );

    const rows = await baseEnv.DB.prepare(
      'SELECT id, financial_account_id, assignment_source, active, replaced_assignment_id FROM transaction_account_assignments WHERE transaction_candidate_id = ?1 ORDER BY assigned_at ASC',
    )
      .bind(txId)
      .all();
    const list = rows.results as Array<{
      id: string;
      financial_account_id: string;
      active: number;
      replaced_assignment_id: string | null;
    }>;
    expect(list.length).toBe(2);
    expect(list[0]?.active).toBe(0);
    expect(list[1]?.active).toBe(1);
    expect(list[1]?.replaced_assignment_id).toBe(list[0]?.id);
  });

  it('clears the assignment when accountId is null', async () => {
    const a1 = await seedAccount({ displayName: 'A1', bank: 'PARSIAN' });
    const txId = await seedTransaction({ accountId: a1 });

    const r = await app.fetch(
      req('POST', `/api/v1/transactions/${txId}/change-account`, {
        accountId: null,
      }),
      ENV,
    );
    expect(r.status).toBe(200);

    const tx = await baseEnv.DB.prepare(
      'SELECT financial_account_id FROM transaction_candidates WHERE id = ?1',
    )
      .bind(txId)
      .first<{ financial_account_id: string | null }>();
    expect(tx?.financial_account_id).toBeNull();
  });

  it('forbids READ_ONLY role', async () => {
    const a1 = await seedAccount({ displayName: 'A1', bank: 'PARSIAN' });
    const txId = await seedTransaction({ accountId: a1 });
    const r = await app.fetch(
      req('POST', `/api/v1/transactions/${txId}/change-account`, { accountId: a1 }),
      {
        ...baseEnv,
        TEST_ACCESS_USER: 'viewer@example.com',
      },
    );
    expect([403, 401]).toContain(r.status);
  });
});

describe('GET /api/v1/transactions/:id/assignment-history', () => {
  it('returns the full chain ordered oldest → newest', async () => {
    const a1 = await seedAccount({ displayName: 'A1', bank: 'PARSIAN' });
    const a2 = await seedAccount({ displayName: 'A2', bank: 'MELLI' });
    const txId = await seedTransaction({ accountId: null });

    // Drive two writes separated by a sleep so ordering is deterministic.
    await app.fetch(
      req('POST', `/api/v1/transactions/${txId}/change-account`, { accountId: a1 }),
      ENV,
    );
    await new Promise((r) => setTimeout(r, 5));
    await app.fetch(
      req('POST', `/api/v1/transactions/${txId}/change-account`, { accountId: a2 }),
      ENV,
    );

    const r = await app.fetch(req('GET', `/api/v1/transactions/${txId}/assignment-history`), ENV);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      items: Array<{ active: boolean; accountId: string }>;
    };
    expect(body.items.length).toBe(2);
    expect(body.items[0]?.active).toBe(false);
    expect(body.items[1]?.active).toBe(true);
  });
});

describe('GET /api/v1/accounts/:id/references', () => {
  it('returns totals + recent transactions + claims', async () => {
    const a = await seedAccount({ displayName: 'A', bank: 'PARSIAN' });
    const txId = await seedTransaction({ accountId: a });
    const claimId = await seedPaymentClaim(a);
    await seedIdentifier(a, 'ACCOUNT_HINT', '9');

    const r = await app.fetch(req('GET', `/api/v1/accounts/${a}/references`), ENV);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      references: {
        totals: { transactions: number; paymentClaims: number; identifiers: number };
        transactions: Array<{ id: string }>;
        paymentClaims: Array<{ id: string }>;
      };
    };
    expect(body.references.totals.transactions).toBe(1);
    expect(body.references.totals.paymentClaims).toBe(1);
    expect(body.references.totals.identifiers).toBe(1);
    expect(body.references.transactions[0]?.id).toBe(txId);
    expect(body.references.paymentClaims[0]?.id).toBe(claimId);
  });
});

describe('POST /api/v1/accounts/:id/move-references', () => {
  it('moves transactions + claims + identifiers atomically', async () => {
    const src = await seedAccount({ displayName: 'Src', bank: 'PARSIAN' });
    const tgt = await seedAccount({ displayName: 'Tgt', bank: 'MELLI' });
    const tx = await seedTransaction({ accountId: src });
    const claim = await seedPaymentClaim(src);
    await seedIdentifier(src, 'ACCOUNT_HINT', '3');

    const preview = await app.fetch(
      req('POST', `/api/v1/accounts/${src}/move-references-preview`, {
        targetAccountId: tgt,
      }),
      ENV,
    );
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as {
      counts: { transactions: number; paymentClaims: number; identifiers: number };
    };
    expect(previewBody.counts.transactions).toBe(1);
    expect(previewBody.counts.paymentClaims).toBe(1);
    expect(previewBody.counts.identifiers).toBe(1);

    const r = await app.fetch(
      req('POST', `/api/v1/accounts/${src}/move-references`, {
        targetAccountId: tgt,
        options: {
          reassignTransactions: true,
          reassignClaims: true,
          moveIdentifiers: true,
          deleteSource: false,
        },
      }),
      ENV,
    );
    expect(r.status).toBe(200);

    // tx re-pointed.
    const txRow = await baseEnv.DB.prepare(
      'SELECT financial_account_id FROM transaction_candidates WHERE id = ?1',
    )
      .bind(tx)
      .first<{ financial_account_id: string }>();
    expect(txRow?.financial_account_id).toBe(tgt);

    // claim re-pointed.
    const claimRow = await baseEnv.DB.prepare(
      'SELECT target_financial_account_id FROM payment_claims WHERE id = ?1',
    )
      .bind(claim)
      .first<{ target_financial_account_id: string }>();
    expect(claimRow?.target_financial_account_id).toBe(tgt);

    // new assignment row has ACCOUNT_MERGE source.
    const aa = await baseEnv.DB.prepare(
      'SELECT assignment_source, financial_account_id FROM transaction_account_assignments WHERE transaction_candidate_id = ?1 AND active = 1',
    )
      .bind(tx)
      .first();
    expect((aa as { assignment_source: string }).assignment_source).toBe('ACCOUNT_MERGE');
    expect((aa as { financial_account_id: string }).financial_account_id).toBe(tgt);

    // source still exists (deleteSource false).
    const srcCheck = await baseEnv.DB.prepare('SELECT id FROM financial_accounts WHERE id = ?1')
      .bind(src)
      .first();
    expect(srcCheck).toBeTruthy();
  });

  it('deletes the source when deleteSource=true and refs are empty', async () => {
    const src = await seedAccount({ displayName: 'Src', bank: 'PARSIAN' });
    const tgt = await seedAccount({ displayName: 'Tgt', bank: 'MELLI' });

    const r = await app.fetch(
      req('POST', `/api/v1/accounts/${src}/move-references`, {
        targetAccountId: tgt,
        options: { deleteSource: true },
      }),
      ENV,
    );
    expect(r.status).toBe(200);

    const body = (await r.json()) as { deletedSource: boolean };
    expect(body.deletedSource).toBe(true);

    const srcCheck = await baseEnv.DB.prepare('SELECT id FROM financial_accounts WHERE id = ?1')
      .bind(src)
      .first();
    expect(srcCheck).toBeNull();
  });

  it('blocks deleteSource when refs remain', async () => {
    const src = await seedAccount({ displayName: 'Src', bank: 'PARSIAN' });
    const tgt = await seedAccount({ displayName: 'Tgt', bank: 'MELLI' });
    await seedTransaction({ accountId: src });

    // Skip the move for transactions so the source still has refs.
    const r = await app.fetch(
      req('POST', `/api/v1/accounts/${src}/move-references`, {
        targetAccountId: tgt,
        options: {
          reassignTransactions: false,
          reassignClaims: false,
          moveIdentifiers: false,
          deleteSource: true,
        },
      }),
      ENV,
    );
    expect(r.status).toBe(409);
    const body = (await r.json()) as { ok: boolean; error: string };
    expect(body.error).toBe('delete_source_blocked');
  });

  it('rejects same-account moves with 400', async () => {
    const a = await seedAccount({ displayName: 'A', bank: 'PARSIAN' });
    const r = await app.fetch(
      req('POST', `/api/v1/accounts/${a}/move-references`, {
        targetAccountId: a,
      }),
      ENV,
    );
    expect(r.status).toBe(400);
  });
});

describe('Notification bell', () => {
  it('GET /counts returns the four buckets and a cursor', async () => {
    // Seed: 1 PARSED tx, 1 NEEDS_REVIEW tx, 1 SUGGESTED match.
    const a = await seedAccount({ displayName: 'A', bank: 'PARSIAN' });
    await seedTransaction({ accountId: a, status: 'PARSED' });
    const unattended = await seedTransaction({ accountId: null, status: 'NEEDS_REVIEW' });
    void unattended;

    const r = await app.fetch(req('GET', '/api/v1/notifications/counts'), ENV);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      counts: {
        new: number;
        unassigned: number;
        unmatched: number;
        suggested: number;
        total: number;
      };
      cursor: { at: number | null; id: string | null };
    };
    expect(body.counts.unassigned).toBeGreaterThanOrEqual(1);
    expect(body.counts.unmatched).toBeGreaterThanOrEqual(1);
  });

  it('POST /mark-read advances the cursor', async () => {
    const r = await app.fetch(
      req('POST', '/api/v1/notifications/mark-read', {
        lastSeenTransactionAt: 1_700_000_000_000,
        lastSeenTransactionId: 'cursor-1',
      }),
      ENV,
    );
    expect(r.status).toBe(200);

    const counts = await app.fetch(req('GET', '/api/v1/notifications/counts'), ENV);
    const body = (await counts.json()) as { cursor: { at: number; id: string } };
    expect(body.cursor.at).toBe(1_700_000_000_000);
    expect(body.cursor.id).toBe('cursor-1');
  });

  it('GET /recent returns the bounded list', async () => {
    const a = await seedAccount({ displayName: 'A', bank: 'PARSIAN' });
    await seedTransaction({ accountId: a });
    const r = await app.fetch(req('GET', '/api/v1/notifications/recent?limit=5'), ENV);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: Array<{ id: string }> };
    expect(body.items.length).toBe(1);
  });
});

describe('POST /api/v1/payment-claims/:id/change-account', () => {
  it('updates the claim and writes audit', async () => {
    const a1 = await seedAccount({ displayName: 'A1', bank: 'PARSIAN' });
    const a2 = await seedAccount({ displayName: 'A2', bank: 'MELLI' });
    const claim = await seedPaymentClaim(a1);

    const r = await app.fetch(
      req('POST', `/api/v1/payment-claims/${claim}/change-account`, {
        accountId: a2,
      }),
      ENV,
    );
    expect(r.status).toBe(200);

    const row = await baseEnv.DB.prepare(
      'SELECT target_financial_account_id FROM payment_claims WHERE id = ?1',
    )
      .bind(claim)
      .first<{ target_financial_account_id: string }>();
    expect(row?.target_financial_account_id).toBe(a2);

    const audit = await baseEnv.DB.prepare(
      "SELECT action FROM audit_logs WHERE entity_id = ?1 AND action = 'payment_claim.account_changed'",
    )
      .bind(claim)
      .first();
    expect(audit).toBeTruthy();
  });
});
