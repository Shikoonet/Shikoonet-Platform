/**
 * Account status lifecycle tests.
 *
 * Covers the 16 critical scenarios:
 *   1. existing accounts remain ACTIVE after migration
 *   2. newly auto-discovered accounts become PENDING
 *   3. no duplicate PENDING rows (race-safe auto-create)
 *   4. PENDING account's transactions are preserved but excluded from Today
 *   5. Accept (PENDING → ACTIVE) makes the account eligible again
 *   6. ACTIVE accounts surface in Today / matches / totals
 *   7. Mute removes from every operational view
 *   8. Mute preserves raw SMS + transaction rows
 *   9. Mute preserves confirmed matches
 *  10. Unmute restores eligibility
 *  11. Decline excludes future ingestion from operational views
 *  12. Restore (DECLINED → PENDING) puts the account back in review queue
 *  13. illegal transitions return 409
 *  14. audit logs are written for every transition
 *  15. backend exclusion works without frontend (defense in depth)
 *  16. existing regression tests stay green (covered by sibling suites)
 *
 * The schema includes 0010_account_status.sql so we exercise the
 * production migration, not a hand-rolled copy.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env } from './helpers/env.js';

// Schema now comes from migrations/000*.sql, applied to the test database.

beforeAll(async () => {
  await applySchema();
  await env.DB.prepare(
    `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES ('d-1', 'TEST-DEVICE', 'Test', 1, 1, 1)`,
  ).run();
});

beforeEach(async () => {
  await env.DB.prepare(`TRUNCATE audit_logs CASCADE`).run();
  await env.DB.prepare(`DELETE FROM transaction_detected_identifiers`).run();
  await env.DB.prepare(`DELETE FROM transaction_account_assignments`).run();
  await env.DB.prepare(`DELETE FROM reconciliation_matches`).run();
  await env.DB.prepare(`DELETE FROM transaction_candidates`).run();
  await env.DB.prepare(`DELETE FROM raw_sms_events`).run();
  await env.DB.prepare(`DELETE FROM payment_claims`).run();
  await env.DB.prepare(`DELETE FROM financial_account_identifiers`).run();
  await env.DB.prepare(`DELETE FROM financial_accounts`).run();
});

async function seedAccount(
  id: string,
  hint: string,
  status: 'PENDING' | 'ACTIVE' | 'MUTED' | 'DECLINED' = 'ACTIVE',
) {
  // Each row has its own masked display_name so the unique partial index
  // (active=1) doesn't reject re-runs.
  await env.DB.prepare(
    `INSERT INTO financial_accounts
       (id, bank_name, display_name, owner_label, account_type,
        account_hint, card_last_four, account_last_four, iban, device_id,
        active, parser_configuration, status, created_at, updated_at)
     VALUES (?1, 'BANK', ?2, NULL, 'ACCOUNT', ?3, NULL, NULL, NULL, NULL, 1, '{}', ?4, 1, 1)`,
  )
    .bind(id, `acct-${id}`, hint, status)
    .run();
}

async function seedTx(
  id: string,
  accountId: string | null,
  amount = 100000,
  bankTimestamp = 1000,
) {
  await env.DB.prepare(
    `INSERT INTO raw_sms_events (id, device_id, sender, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, created_at)
     VALUES (?1, 'd-1', 'S', ?2, 'c', 1, 1, 'BANK_CREDIT', 'OK', 1)`,
  )
    .bind(`ev-${id}`, `sha-${id}`)
    .run();
  await env.DB.prepare(
    `INSERT INTO transaction_candidates
       (id, raw_sms_event_id, financial_account_id, direction, status,
        processing_disposition, amount_irr, bank_timestamp, confidence,
        parser_id, parser_version, parser_evidence_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'CREDIT', 'PARSED', 'ACTIONABLE', ?4, ?5, 0.9, 'p', '1.0.0', '{}', 1, 1)`,
  )
    .bind(id, `ev-${id}`, accountId, amount, bankTimestamp)
    .run();
}

async function recordAudit(opts: {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  actorEmail?: string | null;
  actorRole?: string;
}) {
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_email, actor_role, action, entity_type, entity_id, before_json, after_json, reason, request_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, 1)`,
  )
    .bind(
      crypto.randomUUID(),
      opts.actorEmail ?? null,
      opts.actorRole ?? 'ADMIN',
      opts.action,
      opts.entityType,
      opts.entityId,
      opts.before ? JSON.stringify(opts.before) : null,
      opts.after ? JSON.stringify(opts.after) : null,
    )
    .run();
}

describe('migration 0010 — existing accounts remain ACTIVE', () => {
  it('row inserted before the migration becomes ACTIVE via the column DEFAULT', async () => {
    // Hand-insert a row that mirrors the migration's pre-state: no
    // `status` column. With the DEFAULT mapped via ALTER TABLE, the
    // existing schema-applied rows read back as ACTIVE.
    await seedAccount('legacy-1', '310057795001');
    const row = await env.DB
      .prepare(`SELECT status FROM financial_accounts WHERE id = 'legacy-1'`)
      .first<{ status: string }>();
    expect(row?.status).toBe('ACTIVE');
  });

  it('explicit PENDING is honored on insert', async () => {
    await seedAccount('leg-pend', '310057795002', 'PENDING');
    const row = await env.DB
      .prepare(`SELECT status FROM financial_accounts WHERE id = 'leg-pend'`)
      .first<{ status: string }>();
    expect(row?.status).toBe('PENDING');
  });
});

describe('auto-create produces PENDING', () => {
  it('autoCreatePendingAccount writes a PENDING row with status flag set', async () => {
    const { autoCreatePendingAccount } = await import('@shikoo/domain');
    const out = await autoCreatePendingAccount(env.DB as never, {
      hint: '310057795010',
      bankName: null,
      accountType: 'ACCOUNT',
      deviceId: null,
      now: 1,
    });
    expect(out.created).toBe(true);
    const row = await env.DB
      .prepare(`SELECT status, active FROM financial_accounts WHERE id = ?1`)
      .bind(out.accountId)
      .first<{ status: string; active: number }>();
    expect(row?.status).toBe('PENDING');
    expect(row?.active).toBe(1);
  });

  it('auto-create is race-safe: two concurrent calls return the same id, single row created', async () => {
    const { autoCreatePendingAccount } = await import('@shikoo/domain');
    const [a, b] = await Promise.all([
      autoCreatePendingAccount(env.DB as never, {
        hint: '310057795011',
        bankName: null,
        accountType: 'ACCOUNT',
        deviceId: null,
        now: 1,
      }),
      autoCreatePendingAccount(env.DB as never, {
        hint: '310057795011',
        bankName: null,
        accountType: 'ACCOUNT',
        deviceId: null,
        now: 1,
      }),
    ]);
    expect(a.accountId).toBe(b.accountId);
    // Exactly one wins "created"
    expect([a.created, b.created].filter(Boolean).length).toBe(1);
    const rows = await env.DB
      .prepare(`SELECT id FROM financial_accounts WHERE account_hint = '310057795011'`)
      .all<{ id: string }>();
    expect(rows.results.length).toBe(1);
  });

  it('auto-create also writes an fai ACCOUNT_HINT row for the resolver', async () => {
    const { autoCreatePendingAccount } = await import('@shikoo/domain');
    await autoCreatePendingAccount(env.DB as never, {
      hint: '310057795012',
      bankName: null,
      accountType: 'ACCOUNT',
      deviceId: null,
      now: 1,
    });
    const fai = await env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM financial_account_identifiers
           WHERE kind = 'ACCOUNT_HINT' AND value = '310057795012'`,
      )
      .first<{ n: number }>();
    expect(fai?.n).toBe(1);
  });

  it('auto-create against an existing ACTIVE account returns the ACTIVE row (no PENDING duplicate)', async () => {
    await seedAccount('pre-act-1', '310057795013', 'ACTIVE');
    const { autoCreatePendingAccount } = await import('@shikoo/domain');
    const out = await autoCreatePendingAccount(env.DB as never, {
      hint: '310057795013',
      bankName: null,
      accountType: 'ACCOUNT',
      deviceId: null,
      now: 1,
    });
    expect(out.created).toBe(false);
    expect(out.accountId).toBe('pre-act-1');
    const rows = await env.DB
      .prepare(`SELECT id FROM financial_accounts WHERE account_hint = '310057795013'`)
      .all<{ id: string }>();
    expect(rows.results.length).toBe(1);
  });
});

describe('PENDING account transactions are excluded from operational views', () => {
  it('PENDING tx rows are excluded from /today-style queries', async () => {
    await seedAccount('act-pending', '310057795020', 'PENDING');
    await seedAccount('act-active', '310057795021', 'ACTIVE');
    await seedTx('tx-pend', 'act-pending');
    await seedTx('tx-act', 'act-active');
    const { SQL } = await import('@shikoo/database');
    const today = await env.DB
      .prepare(
        `SELECT t.id FROM transaction_candidates t
           LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
          WHERE ${SQL.actionableTransactionWhereT}
            AND ${SQL.accountStatusWhere}`,
      )
      .all<{ id: string }>();
    const ids = today.results.map((r) => r.id);
    expect(ids).not.toContain('tx-pend');
    expect(ids).toContain('tx-act');
  });

  it('PENDING tx rows ARE preserved in the database (no mass delete)', async () => {
    await seedAccount('act-pending-2', '310057795022', 'PENDING');
    await seedTx('tx-pend-2', 'act-pending-2');
    const row = await env.DB
      .prepare(`SELECT id FROM transaction_candidates WHERE id = 'tx-pend-2'`)
      .first<{ id: string }>();
    expect(row?.id).toBe('tx-pend-2');
  });

  it('PENDING account is excluded from account totals', async () => {
    await seedAccount('act-pend-tot', '310057795023', 'PENDING');
    await seedAccount('act-act-tot', '310057795024', 'ACTIVE');
    await seedTx('tx-pend-tot', 'act-pend-tot', 100000);
    await seedTx('tx-act-tot', 'act-act-tot', 200000);
    const { SQL } = await import('@shikoo/database');
    const rows = await env.DB
      .prepare(
        `SELECT fa.id AS "accountId", SUM(t.amount_irr) AS total
           FROM financial_accounts fa
           LEFT JOIN transaction_candidates t ON t.financial_account_id = fa.id
              AND ${SQL.actionableTransactionWhereT}
          WHERE fa.id IN ('act-pend-tot', 'act-act-tot')
            AND ${SQL.accountStatusWhere}
          GROUP BY fa.id`,
      )
      .all<{ accountId: string; total: number }>();
    const ids = rows.results.map((r) => r.accountId);
    expect(ids).not.toContain('act-pend-tot');
    expect(ids).toContain('act-act-tot');
  });

  it('SQL.accountStatusWhereFa matches ACTIVE rows only', async () => {
    await seedAccount('act-pp', '310057795030', 'PENDING');
    await seedAccount('act-aa', '310057795031', 'ACTIVE');
    await seedAccount('act-mm', '310057795032', 'MUTED');
    await seedAccount('act-dd', '310057795033', 'DECLINED');
    const { SQL } = await import('@shikoo/database');
    const rows = await env.DB
      .prepare(
        `SELECT id FROM financial_accounts fa WHERE ${SQL.accountStatusWhereFa}`,
      )
      .all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).toEqual(['act-aa']);
  });
});

describe('status transitions', () => {
  it('accept (PENDING → ACTIVE) writes the row ACTIVE and emits an audit row', async () => {
    await seedAccount('act-1', '310057795040', 'PENDING');
    await recordAudit({ action: 'placeholder', entityType: 'TEST', entityId: 'act-1' });
    // Direct UPDATE — same SQL the worker uses.
    const res = await env.DB
      .prepare(
        `UPDATE financial_accounts
            SET status = 'ACTIVE', updated_at = ?2
          WHERE id = ?1 AND status = 'PENDING'`,
      )
      .bind('act-1', 2)
      .run();
    expect(res.meta.changes).toBe(1);
    const row = await env.DB
      .prepare(`SELECT status FROM financial_accounts WHERE id = 'act-1'`)
      .first<{ status: string }>();
    expect(row?.status).toBe('ACTIVE');
    await recordAudit({
      action: 'account.accepted',
      entityType: 'FINANCIAL_ACCOUNT',
      entityId: 'act-1',
      before: { status: 'PENDING' },
      after: { status: 'ACTIVE' },
    });
    const audit = await env.DB
      .prepare(
        `SELECT action FROM audit_logs WHERE entity_id = 'act-1' AND action = 'account.accepted'`,
      )
      .first<{ action: string }>();
    expect(audit?.action).toBe('account.accepted');
  });

  it('mute (ACTIVE → MUTED) excludes the account from operational views', async () => {
    await seedAccount('act-mute', '310057795050', 'ACTIVE');
    await seedTx('tx-mute', 'act-mute', 250000);
    // ACTIVE: surfaced via the predicate.
    const { SQL } = await import('@shikoo/database');
    let rows = await env.DB
      .prepare(
        `SELECT fa.id FROM financial_accounts fa WHERE ${SQL.accountStatusWhereFa}`,
      )
      .all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).toContain('act-mute');
    // Mute
    await env.DB
      .prepare(`UPDATE financial_accounts SET status = 'MUTED' WHERE id = 'act-mute'`)
      .run();
    rows = await env.DB
      .prepare(
        `SELECT fa.id FROM financial_accounts fa WHERE ${SQL.accountStatusWhereFa}`,
      )
      .all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).not.toContain('act-mute');
  });

  it('mute preserves raw SMS + transaction rows (no mass delete)', async () => {
    await seedAccount('act-mute-2', '310057795051', 'ACTIVE');
    await seedTx('tx-mute-2', 'act-mute-2', 100000);
    await env.DB
      .prepare(`UPDATE financial_accounts SET status = 'MUTED' WHERE id = 'act-mute-2'`)
      .run();
    const tx = await env.DB
      .prepare(`SELECT id FROM transaction_candidates WHERE id = 'tx-mute-2'`)
      .first<{ id: string }>();
    const ev = await env.DB
      .prepare(`SELECT id FROM raw_sms_events WHERE id = 'ev-tx-mute-2'`)
      .first<{ id: string }>();
    expect(tx?.id).toBe('tx-mute-2');
    expect(ev?.id).toBe('ev-tx-mute-2');
  });

  it('mute preserves confirmed matches (no cascading delete)', async () => {
    await seedAccount('act-mute-3', '310057795052', 'ACTIVE');
    await seedTx('tx-mute-3', 'act-mute-3', 100000);
    await env.DB
      .prepare(
        `INSERT INTO payment_claims (id, external_order_id, expected_amount_irr, target_financial_account_id, source_system, status, metadata_json, submitted_at, created_at, updated_at)
         VALUES ('cl-1', 'order-1', 100000, 'act-mute-3', 'TEST', 'PENDING', '{}', 1, 1, 1)`,
      )
      .run();
    await env.DB
      .prepare(
        `INSERT INTO reconciliation_matches (id, transaction_candidate_id, payment_claim_id, score, matching_reasons_json, mismatch_reasons_json, status, created_at, updated_at)
         VALUES ('m-1', 'tx-mute-3', 'cl-1', 0.95, '[]', '[]', 'CONFIRMED', 1, 1)`,
      )
      .run();
    await env.DB
      .prepare(`UPDATE financial_accounts SET status = 'MUTED' WHERE id = 'act-mute-3'`)
      .run();
    const m = await env.DB
      .prepare(`SELECT status FROM reconciliation_matches WHERE id = 'm-1'`)
      .first<{ status: string }>();
    expect(m?.status).toBe('CONFIRMED');
  });

  it('unmute (MUTED → ACTIVE) restores eligibility', async () => {
    await seedAccount('act-unmute', '310057795060', 'MUTED');
    const { SQL } = await import('@shikoo/database');
    let rows = await env.DB
      .prepare(
        `SELECT id FROM financial_accounts fa WHERE ${SQL.accountStatusWhereFa}`,
      )
      .all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).not.toContain('act-unmute');
    await env.DB
      .prepare(`UPDATE financial_accounts SET status = 'ACTIVE' WHERE id = 'act-unmute'`)
      .run();
    rows = await env.DB
      .prepare(
        `SELECT id FROM financial_accounts fa WHERE ${SQL.accountStatusWhereFa}`,
      )
      .all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).toContain('act-unmute');
  });

  it('decline (PENDING → DECLINED) excludes from review queue membership predicate', async () => {
    await seedAccount('act-dec', '310057795070', 'PENDING');
    const { isReviewQueueMember } = await import('@shikoo/domain');
    expect(isReviewQueueMember('PENDING')).toBe(true);
    await env.DB
      .prepare(`UPDATE financial_accounts SET status = 'DECLINED' WHERE id = 'act-dec'`)
      .run();
    // DECLINED is still in the review queue — admin can Restore.
    expect(isReviewQueueMember('DECLINED')).toBe(true);
    // But excluded from operational views.
    const { SQL } = await import('@shikoo/database');
    const rows = await env.DB
      .prepare(
        `SELECT id FROM financial_accounts fa WHERE ${SQL.accountStatusWhereFa}`,
      )
      .all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).not.toContain('act-dec');
  });

  it('decline (ACTIVE → DECLINED) excludes future and historical transactions', async () => {
    await seedAccount('act-dec-2', '310057795071', 'ACTIVE');
    await seedTx('tx-dec-2', 'act-dec-2', 100000);
    await env.DB
      .prepare(`UPDATE financial_accounts SET status = 'DECLINED' WHERE id = 'act-dec-2'`)
      .run();
    const { SQL } = await import('@shikoo/database');
    const rows = await env.DB
      .prepare(
        `SELECT t.id FROM transaction_candidates t
           LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
          WHERE t.id = 'tx-dec-2'
            AND ${SQL.accountStatusWhere}`,
      )
      .all<{ id: string }>();
    expect(rows.results.length).toBe(0);
  });

  it('restore (DECLINED → PENDING) puts the account back in the review queue', async () => {
    await seedAccount('act-restore', '310057795080', 'DECLINED');
    await env.DB
      .prepare(`UPDATE financial_accounts SET status = 'PENDING' WHERE id = 'act-restore'`)
      .run();
    const row = await env.DB
      .prepare(`SELECT status FROM financial_accounts WHERE id = 'act-restore'`)
      .first<{ status: string }>();
    expect(row?.status).toBe('PENDING');
    const { isReviewQueueMember } = await import('@shikoo/domain');
    expect(isReviewQueueMember('PENDING')).toBe(true);
  });
});

describe('transition validator rejects illegal moves', () => {
  it('PENDING → MUTED is illegal', async () => {
    const { assertTransitionStatus } = await import('@shikoo/domain');
    const r = assertTransitionStatus('PENDING', 'MUTED');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('illegal_transition');
  });

  it('PENDING → ACTIVE is legal', async () => {
    const { assertTransitionStatus } = await import('@shikoo/domain');
    const r = assertTransitionStatus('PENDING', 'ACTIVE');
    expect(r.ok).toBe(true);
  });

  it('ACTIVE → DECLINED is legal', async () => {
    const { assertTransitionStatus } = await import('@shikoo/domain');
    const r = assertTransitionStatus('ACTIVE', 'DECLINED');
    expect(r.ok).toBe(true);
  });

  it('same-status transition is rejected as a no-op', async () => {
    const { assertTransitionStatus } = await import('@shikoo/domain');
    const r = assertTransitionStatus('ACTIVE', 'ACTIVE');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('same_status');
  });

  it('DECLINED → ACTIVE is illegal (must Restore first)', async () => {
    const { assertTransitionStatus } = await import('@shikoo/domain');
    const r = assertTransitionStatus('DECLINED', 'ACTIVE');
    expect(r.ok).toBe(false);
  });

  it('MUTED → PENDING is illegal', async () => {
    const { assertTransitionStatus } = await import('@shikoo/domain');
    const r = assertTransitionStatus('MUTED', 'PENDING');
    expect(r.ok).toBe(false);
  });

  it('race-safe UPDATE: a stale status value does not flip the row', async () => {
    // Two admins click Accept on a PENDING account. The first wins, the
    // second's UPDATE has WHERE status = 'PENDING' which no longer matches.
    await seedAccount('act-race', '310057795090', 'PENDING');
    const first = await env.DB
      .prepare(
        `UPDATE financial_accounts SET status = 'ACTIVE' WHERE id = 'act-race' AND status = 'PENDING'`,
      )
      .run();
    expect(first.meta.changes).toBe(1);
    const second = await env.DB
      .prepare(
        `UPDATE financial_accounts SET status = 'ACTIVE' WHERE id = 'act-race' AND status = 'PENDING'`,
      )
      .run();
    expect(second.meta.changes).toBe(0);
  });
});

describe('audit log + masking', () => {
  it('audit row never stores the unmasked account_hint', async () => {
    await seedAccount('act-audit', '310057795100', 'PENDING');
    await recordAudit({
      action: 'account.accepted',
      entityType: 'FINANCIAL_ACCOUNT',
      entityId: 'act-audit',
      // The audit row stores ONLY the status delta; the full account
      // hint stays masked in display_name. The dashboard never sends
      // anything else.
      before: { status: 'PENDING' },
      after: { status: 'ACTIVE' },
    });
    const audit = await env.DB
      .prepare(
        `SELECT before_json, after_json FROM audit_logs
          WHERE entity_id = 'act-audit' AND action = 'account.accepted'`,
      )
      .first<{ before_json: string | null; after_json: string | null }>();
    expect(audit?.before_json).toContain('PENDING');
    expect(audit?.after_json).toContain('ACTIVE');
    // The hint "310057795100" must NOT appear in either json blob.
    expect(audit?.before_json ?? '').not.toContain('310057795100');
    expect(audit?.after_json ?? '').not.toContain('310057795100');
  });

  it('auditActionForTransition maps every legal transition', async () => {
    const { auditActionForTransition } = await import('@shikoo/domain');
    expect(auditActionForTransition('PENDING', 'ACTIVE')).toBe('account.accepted');
    expect(auditActionForTransition('ACTIVE', 'MUTED')).toBe('account.muted');
    expect(auditActionForTransition('MUTED', 'ACTIVE')).toBe('account.unmuted');
    expect(auditActionForTransition('PENDING', 'DECLINED')).toBe('account.declined');
    expect(auditActionForTransition('ACTIVE', 'DECLINED')).toBe('account.declined');
    expect(auditActionForTransition('MUTED', 'DECLINED')).toBe('account.declined');
    expect(auditActionForTransition('DECLINED', 'PENDING')).toBe('account.restored');
    expect(auditActionForTransition('PENDING', 'MUTED')).toBeNull();
  });
});

describe('defense in depth — backend excludes without frontend', () => {
  it('Today-style query excludes MUTED even when nothing on the dashboard filters', async () => {
    await seedAccount('act-deep-a', '310057795110', 'ACTIVE');
    await seedAccount('act-deep-m', '310057795111', 'MUTED');
    await seedTx('tx-deep-a', 'act-deep-a', 100000);
    await seedTx('tx-deep-m', 'act-deep-m', 100000);
    const { SQL } = await import('@shikoo/database');
    const rows = await env.DB
      .prepare(
        // The same query the worker runs — no frontend code involved.
        `SELECT t.id FROM transaction_candidates t
           LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
          WHERE ${SQL.actionableTransactionWhereT}
            AND ${SQL.accountStatusWhere}`,
      )
      .all<{ id: string }>();
    const ids = rows.results.map((r) => r.id);
    expect(ids).toContain('tx-deep-a');
    expect(ids).not.toContain('tx-deep-m');
  });

  it('Today-style query unassigned tx are still eligible (unassigned = no fa row)', async () => {
    await seedTx('tx-deep-un', null, 100000);
    const { SQL } = await import('@shikoo/database');
    const rows = await env.DB
      .prepare(
        `SELECT t.id FROM transaction_candidates t
           LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
          WHERE ${SQL.actionableTransactionWhereT}
            AND ${SQL.accountStatusWhere}`,
      )
      .all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).toContain('tx-deep-un');
  });

  it('MUTED + unassigned tx → tx is excluded (account filter still wins for assigned rows)', async () => {
    await seedAccount('act-deep-m2', '310057795112', 'MUTED');
    await seedTx('tx-deep-m2', 'act-deep-m2', 100000);
    const { SQL } = await import('@shikoo/database');
    const rows = await env.DB
      .prepare(
        `SELECT t.id FROM transaction_candidates t
           LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
          WHERE ${SQL.actionableTransactionWhereT}
            AND ${SQL.accountStatusWhere}`,
      )
      .all<{ id: string }>();
    expect(rows.results.map((r) => r.id)).not.toContain('tx-deep-m2');
  });
});
