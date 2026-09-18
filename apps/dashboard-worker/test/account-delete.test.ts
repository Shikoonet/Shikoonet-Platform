/**
 * Account permanent-delete tests.
 *
 * Covers:
 *  - /accounts/:id/delete-preview returns {ok, account, references, canDelete, blockingReasons}
 *  - DELETE /accounts/:id requires ADMIN (returns 403 to OPERATOR/READ_ONLY)
 *  - DELETE /accounts/:id returns 409 account_must_be_inactive when active
 *  - DELETE /accounts/:id returns 409 account_in_use when transactions/claims exist
 *  - DELETE /accounts/:id succeeds when inactive + no refs, cascades identifiers
 *  - Audit log contains account.deleted with NO tokens/auth/secrets
 *  - Cache-Control: private, no-store on the delete-preview
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

// Schema now comes from migrations/000*.sql, applied to the test database.

async function resetTables() {
  // Wipe everything we touch, in FK-safe order (children first).
  await baseEnv.DB.batch([
    baseEnv.DB.prepare('DELETE FROM dashboard_transaction_reads'),
    baseEnv.DB.prepare('DELETE FROM dashboard_notification_state'),
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

async function seedOperator(email: string) {
  await baseEnv.DB.prepare(
    'INSERT INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
  )
    .bind(crypto.randomUUID(), email, 'REVIEWER', Date.now(), Date.now())
    .run();
}

async function seedReadOnly(email: string) {
  await baseEnv.DB.prepare(
    'INSERT INTO access_users (id, email, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
  )
    .bind(crypto.randomUUID(), email, 'READ_ONLY', Date.now(), Date.now())
    .run();
}

async function seedAccount(opts: { displayName: string; bank: string; active: boolean }) {
  const id = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO financial_accounts
     (id, display_name, bank_name, account_type, owner_label, active, parser_configuration, created_at, updated_at)
     VALUES (?, ?, ?, 'ACCOUNT', NULL, ?, '{}', ?, ?)`,
  )
    .bind(id, opts.displayName, opts.bank, opts.active ? 1 : 0, Date.now(), Date.now())
    .run();
  return id;
}

async function seedIdentifier(accountId: string, value: string) {
  await baseEnv.DB.prepare(
    `INSERT INTO financial_account_identifiers
     (id, financial_account_id, kind, value, label, created_at)
     VALUES (?, ?, 'OTHER', ?, NULL, ?)`,
  )
    .bind(crypto.randomUUID(), accountId, value, Date.now())
    .run();
}

async function seedTransaction(accountId: string, amountIrr = 100000): Promise<string> {
  // Need a device row + raw_sms_event row first due to NOT NULL FK.
  const deviceId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES (?, ?, 'Test', 1, ?, ?)`,
  )
    .bind(deviceId, `test-${Date.now()}`, Date.now(), Date.now())
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
     VALUES (?, ?, ?, 'CREDIT', ?, 'NEEDS_REVIEW', ?, 1.0, 'test', 'v1', '{}', ?, ?)`,
  )
    .bind(txId, smsId, accountId, amountIrr, Date.now(), Date.now(), Date.now())
    .run();
  return txId;
}

/** A transaction some claim already consumed — money the books have counted. */
async function consumeTransaction(txId: string) {
  const claimId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO payment_claims
     (id, external_order_id, expected_amount_irr, target_financial_account_id, submitted_at, source_system, status, created_at, updated_at)
     VALUES (?, ?, 100000, NULL, ?, 'test', 'VERIFIED', ?, ?)`,
  )
    .bind(claimId, `order-${claimId}`, Date.now(), Date.now(), Date.now())
    .run();
  await baseEnv.DB.prepare(
    `INSERT INTO reconciliation_matches
     (id, transaction_candidate_id, payment_claim_id, score, status, created_at, updated_at)
     VALUES (?, ?, ?, 1.0, 'CONFIRMED', ?, ?)`,
  )
    .bind(crypto.randomUUID(), txId, claimId, Date.now(), Date.now())
    .run();
}

async function seedPaymentClaim(accountId: string) {
  await baseEnv.DB.prepare(
    `INSERT INTO payment_claims
     (id, external_order_id, expected_amount_irr, target_financial_account_id, submitted_at, source_system, status, created_at, updated_at)
     VALUES (?, ?, 50000, ?, ?, 'test', 'PENDING', ?, ?)`,
  )
    .bind(crypto.randomUUID(), `order-${Date.now()}`, accountId, Date.now(), Date.now(), Date.now())
    .run();
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

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetTables();
  await seedAdmin('admin@example.com');
  await seedOperator('op@example.com');
  await seedReadOnly('viewer@example.com');
});

describe('DELETE /api/v1/accounts/:id', () => {
  it('rejects unauthenticated caller with 401', async () => {
    const r = await app.fetch(
      new Request('https://example.com/api/v1/accounts/abc/delete-preview'),
      { ...baseEnv, TEST_ACCESS_USER: '' },
    );
    expect(r.status).toBe(401);
  });

  it('rejects READ_ONLY with 403 on delete-preview', async () => {
    const envLocked = { ...baseEnv, TEST_ACCESS_USER: 'viewer@example.com' };
    const r = await app.fetch(req('GET', '/api/v1/accounts/abc/delete-preview'), envLocked);
    expect(r.status).toBe(403);
  });

  it('rejects OPERATOR with 403 on DELETE', async () => {
    const envLocked = { ...baseEnv, TEST_ACCESS_USER: 'op@example.com' };
    const id = await seedAccount({ displayName: 'X', bank: 'PARSIAN', active: false });
    const r = await app.fetch(req('DELETE', `/api/v1/accounts/${id}`), envLocked);
    expect(r.status).toBe(403);
  });

  it('returns delete-preview with references and canDelete=false for active account', async () => {
    const id = await seedAccount({ displayName: 'Active', bank: 'MELLI', active: true });
    const r = await app.fetch(req('GET', `/api/v1/accounts/${id}/delete-preview`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await r.json()) as {
      ok: boolean;
      account: { displayName: string; active: boolean };
      references: { transactions: number; paymentClaims: number; identifiers: number };
      canDelete: boolean;
      blockingReasons: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.account.active).toBe(true);
    expect(body.canDelete).toBe(false);
    expect(body.blockingReasons).toContain('account_must_be_inactive');
  });

  it('reports linked transactions in delete-preview', async () => {
    const id = await seedAccount({ displayName: 'InUse', bank: 'PARSIAN', active: false });
    await seedTransaction(id);
    const r = await app.fetch(req('GET', `/api/v1/accounts/${id}/delete-preview`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    const body = (await r.json()) as {
      references: { transactions: number };
      canDelete: boolean;
      blockingReasons: string[];
    };
    expect(body.references.transactions).toBe(1);
    expect(body.canDelete).toBe(false);
    expect(body.blockingReasons).toContain('account_in_use');
  });

  it('reports linked payment claims in delete-preview', async () => {
    const id = await seedAccount({ displayName: 'ClaimUse', bank: 'PARSIAN', active: false });
    await seedPaymentClaim(id);
    const r = await app.fetch(req('GET', `/api/v1/accounts/${id}/delete-preview`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    const body = (await r.json()) as {
      references: { paymentClaims: number };
      canDelete: boolean;
      blockingReasons: string[];
    };
    expect(body.references.paymentClaims).toBe(1);
    expect(body.canDelete).toBe(false);
    expect(body.blockingReasons).toContain('account_in_use');
  });

  it('returns 409 account_must_be_inactive when DELETE called on active account', async () => {
    const id = await seedAccount({ displayName: 'Active', bank: 'PARSIAN', active: true });
    const r = await app.fetch(req('DELETE', `/api/v1/accounts/${id}`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('account_must_be_inactive');
  });

  it('returns 409 account_in_use when DELETE on account with transactions', async () => {
    const id = await seedAccount({ displayName: 'InUse', bank: 'PARSIAN', active: false });
    await seedTransaction(id);
    const r = await app.fetch(req('DELETE', `/api/v1/accounts/${id}`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('account_in_use');
    // Account should NOT have been deleted
    const stillThere = await baseEnv.DB.prepare('SELECT id FROM financial_accounts WHERE id = ?')
      .bind(id)
      .first();
    expect(stillThere).not.toBeNull();
  });

  it('successfully deletes an inactive account with no references', async () => {
    const id = await seedAccount({ displayName: 'Ghost', bank: 'PARSIAN', active: false });
    const r = await app.fetch(req('DELETE', `/api/v1/accounts/${id}`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      deleted: string;
      references: { identifiers: number };
    };
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(id);
    expect(body.references.identifiers).toBe(0);

    const stillThere = await baseEnv.DB.prepare('SELECT id FROM financial_accounts WHERE id = ?')
      .bind(id)
      .first();
    expect(stillThere).toBeNull();
  });

  it('cascades identifiers when deleting account', async () => {
    const id = await seedAccount({ displayName: 'Cascade', bank: 'PARSIAN', active: false });
    await seedIdentifier(id, '310057795083');
    await seedIdentifier(id, '9999');
    const r = await app.fetch(req('DELETE', `/api/v1/accounts/${id}`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    const body = (await r.json()) as { references: { identifiers: number } };
    expect(body.references.identifiers).toBe(2);

    const remaining = await baseEnv.DB.prepare(
      'SELECT COUNT(*) AS c FROM financial_account_identifiers WHERE financial_account_id = ?',
    )
      .bind(id)
      .first<{ c: number }>();
    expect(remaining!.c).toBe(0);
  });

  it('writes an account.deleted audit log with identifier count and no secrets', async () => {
    const id = await seedAccount({ displayName: 'AuditDel', bank: 'MELLI', active: false });
    await seedIdentifier(id, '17000');
    await app.fetch(req('DELETE', `/api/v1/accounts/${id}`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    const log = await baseEnv.DB.prepare(
      `SELECT action, entity_type, entity_id, before_json, after_json, actor_email
       FROM audit_logs
       WHERE entity_type = 'ACCOUNT' AND action = 'account.deleted'
       ORDER BY created_at DESC
       LIMIT 1`,
    ).first<{
      action: string;
      entity_type: string;
      entity_id: string;
      before_json: string | null;
      after_json: string | null;
      actor_email: string | null;
    }>();
    expect(log).not.toBeNull();
    expect(log!.action).toBe('account.deleted');
    expect(log!.entity_type).toBe('ACCOUNT');
    expect(log!.entity_id).toBe(id);
    expect(log!.actor_email).toBe('admin@example.com');
    const before = JSON.parse(log!.before_json ?? '{}');
    expect(before.displayName).toBe('AuditDel');
    expect(before.bank).toBe('MELLI');
    expect(before.deletedIdentifierCount).toBe(1);
    // Hard guarantee: no token-shaped strings anywhere in the log row.
    const blob = JSON.stringify(log);
    expect(blob).not.toMatch(/api[_-]?key/i);
    expect(blob).not.toMatch(/token/i);
    expect(blob).not.toMatch(/authorization/i);
    expect(blob).not.toMatch(/cf[_-]?authorization/i);
  });

  it('returns 404 for unknown account id', async () => {
    const r = await app.fetch(req('GET', `/api/v1/accounts/nope/delete-preview`), {
      ...baseEnv,
      TEST_ACCESS_USER: 'admin@example.com',
    });
    expect(r.status).toBe(404);
  });
});

/**
 * Purging: the account AND its transactions go, in one statement batch.
 *
 * Sam, 2026-09-19, about an auto-discovered account that was a mistake and
 * held two credits: «کلا میخوام خودش و تراکنش‌هاش رو پاک کنم». The dashboard
 * had no way to say that — an account with history was a dead end unless its
 * rows were moved to another account. The only line that must never cross:
 * a transaction some claim already consumed is money the books have counted,
 * and no purge may take it.
 */
describe('DELETE /api/v1/accounts/:id with purgeTransactions', () => {
  const admin = { ...baseEnv, TEST_ACCESS_USER: 'admin@example.com' };
  const countOf = async (table: string) =>
    (await baseEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;

  it('previews what a purge would take: count, sum, and what pins it', async () => {
    const id = await seedAccount({ displayName: 'Auto: ****04.1', bank: 'UNKNOWN', active: false });
    await seedTransaction(id, 70_000_000);
    await seedTransaction(id, 113_000_000);
    const r = await app.fetch(req('GET', `/api/v1/accounts/${id}/delete-preview`), admin);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      canDelete: boolean;
      purge: { transactions: number; amountIrr: number; pinnedTransactions: number; canPurge: boolean };
    };
    expect(body.canDelete).toBe(false);
    expect(body.purge).toEqual({
      transactions: 2,
      amountIrr: 183_000_000,
      pinnedTransactions: 0,
      canPurge: true,
    });
  });

  it('deletes the account, its transactions and their cascades; keeps the raw SMS; audits the sum', async () => {
    const id = await seedAccount({ displayName: 'Auto: ****04.1', bank: 'UNKNOWN', active: false });
    await seedIdentifier(id, '777.888.21654304.1');
    const tx1 = await seedTransaction(id, 70_000_000);
    await seedTransaction(id, 113_000_000);
    await baseEnv.DB.prepare(
      `INSERT INTO transaction_detected_identifiers
       (id, transaction_candidate_id, identifier_type, normalized_value, display_value_masked, parser_id, confidence, created_at)
       VALUES (?, ?, 'ACCOUNT_HINT', '777.888.21654304.1', '****04.1', 'test', 1.0, ?)`,
    )
      .bind(crypto.randomUUID(), tx1, Date.now())
      .run();

    const r = await app.fetch(
      req('DELETE', `/api/v1/accounts/${id}`, { purgeTransactions: true, reason: 'حساب اشتباهی' }),
      admin,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      purged: { transactions: number; amountIrr: number };
    };
    expect(body.ok).toBe(true);
    expect(body.purged).toEqual({ transactions: 2, amountIrr: 183_000_000 });

    expect(await countOf('financial_accounts')).toBe(0);
    expect(await countOf('financial_account_identifiers')).toBe(0);
    expect(await countOf('transaction_candidates')).toBe(0);
    expect(await countOf('transaction_detected_identifiers')).toBe(0);
    // The bank's own words stay: evidence of what arrived, owned by nobody.
    expect(await countOf('raw_sms_events')).toBe(2);

    const audit = await baseEnv.DB.prepare(
      `SELECT entity_id, before_json, reason FROM audit_logs WHERE action = 'account.purged'`,
    ).first<{ entity_id: string; before_json: string; reason: string }>();
    expect(audit?.entity_id).toBe(id);
    expect(audit?.reason).toBe('حساب اشتباهی');
    expect(JSON.parse(audit!.before_json)).toMatchObject({
      displayName: 'Auto: ****04.1',
      purgedTransactionCount: 2,
      purgedAmountIrr: 183_000_000,
    });
  });

  it('refuses when one transaction is already consumed by a claim, and deletes nothing', async () => {
    const id = await seedAccount({ displayName: 'Counted', bank: 'PARSIAN', active: false });
    const pinned = await seedTransaction(id, 100000);
    await consumeTransaction(pinned);
    await seedTransaction(id, 100000);

    const preview = (await (
      await app.fetch(req('GET', `/api/v1/accounts/${id}/delete-preview`), admin)
    ).json()) as { purge: { pinnedTransactions: number; canPurge: boolean } };
    expect(preview.purge).toMatchObject({ pinnedTransactions: 1, canPurge: false });

    const r = await app.fetch(
      req('DELETE', `/api/v1/accounts/${id}`, { purgeTransactions: true }),
      admin,
    );
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe('transactions_in_use');
    expect(await countOf('transaction_candidates')).toBe(2);
    expect(await countOf('financial_accounts')).toBe(1);
  });

  it('still refuses an active account, and an account with payment claims', async () => {
    const active = await seedAccount({ displayName: 'Live', bank: 'PARSIAN', active: true });
    await seedTransaction(active);
    const r1 = await app.fetch(
      req('DELETE', `/api/v1/accounts/${active}`, { purgeTransactions: true }),
      admin,
    );
    expect(r1.status).toBe(409);
    expect(((await r1.json()) as { error: string }).error).toBe('account_must_be_inactive');

    const claimed = await seedAccount({ displayName: 'Claimed', bank: 'PARSIAN', active: false });
    await seedTransaction(claimed);
    await seedPaymentClaim(claimed);
    const r2 = await app.fetch(
      req('DELETE', `/api/v1/accounts/${claimed}`, { purgeTransactions: true }),
      admin,
    );
    expect(r2.status).toBe(409);
    expect(((await r2.json()) as { error: string }).error).toBe('account_in_use');
    expect(await countOf('transaction_candidates')).toBe(2);
  });
});
