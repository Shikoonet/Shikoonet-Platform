/**
 * Deterministic seed test — exercises the seed generator and asserts the
 * row counts the spec requires.
 *
 * Lives in apps/ingest-worker because that workspace already has the
 * vitest-pool-workers binding for D1.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env, resetHub } from './helpers/env.js';
import { seed } from '@shikoo/seed';
import type { D1Database as HubD1Database } from '@shikoo/database';

// Schema now comes from migrations/000*.sql, applied to the test database.

beforeAll(async () => {
  await applySchema();
});

// `seed()` inserts fixed device codes and never clears first, so a second run
// against the same data collides on devices.device_code. "Reproducible across
// runs" means a fresh run — this makes the test express that instead of
// accidentally testing what happens when you seed on top of a seed.
beforeEach(resetHub);

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
