/**
 * Resetting the free-trial counter, against a real Postgres.
 *
 * The route test in `apps/dashboard-worker` walks the same two functions
 * through HTTP; this is the domain's own proof, and the one the coverage
 * floor reads. Two customers, one who used a trial and one who did not: the
 * count names the first, the reset zeroes exactly the first, a blocked
 * customer is «nobody» to both — the same `u.status = 'ACTIVE'` every bulk
 * action applies.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresD1 } from '@shikoo/db';
import { resetTrialQuota, trialQuotaUsedCount } from '../../src/bulkCustomers.js';

const { db, pool } = createPostgresD1();

const TG = 934_000_100;

async function customer(offset: number, used: number, status = 'ACTIVE'): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO users (telegram_id, username, registered_at, status, test_quota_used)
       VALUES (?1, 'zz-trial', now(), ?2, ?3)
       ON CONFLICT (telegram_id) DO UPDATE
         SET status = EXCLUDED.status, test_quota_used = EXCLUDED.test_quota_used
       RETURNING id`,
    )
    .bind(TG + offset, status, used)
    .first<{ id: number }>();
  return Number(row!.id);
}

async function usedOf(id: number): Promise<number> {
  const row = await db
    .prepare(`SELECT test_quota_used AS n FROM users WHERE id = ?1`)
    .bind(id)
    .first<{ n: number }>();
  return Number(row!.n);
}

beforeEach(async () => {
  await db.prepare(`DELETE FROM users WHERE username = 'zz-trial'`).run();
});

afterAll(async () => {
  await db.prepare(`DELETE FROM users WHERE username = 'zz-trial'`).run();
  await pool.end();
});

describe('the trial counter', () => {
  it('counts who used one and resets exactly them', async () => {
    const tried = await customer(1, 1);
    const fresh = await customer(2, 0);
    const blocked = await customer(3, 1, 'BLOCKED');

    expect(await trialQuotaUsedCount(db, { kind: 'customer', telegramId: TG + 1 })).toBe(1);
    expect(await trialQuotaUsedCount(db, { kind: 'customer', telegramId: TG + 2 })).toBe(0);
    expect(await trialQuotaUsedCount(db, { kind: 'customer', telegramId: TG + 3 })).toBe(0);

    expect(await resetTrialQuota(db, { kind: 'customer', telegramId: TG + 1 })).toBe(1);
    expect(await usedOf(tried)).toBe(0);
    expect(await usedOf(fresh)).toBe(0);
    // Not ACTIVE, not touched — a blocked customer is nobody to a bulk action.
    expect(await usedOf(blocked)).toBe(1);

    // A second press finds nothing to do and says so.
    expect(await resetTrialQuota(db, { kind: 'customer', telegramId: TG + 1 })).toBe(0);
  });

  it('reaches the whole audience when asked for everybody', async () => {
    const a = await customer(4, 2);
    const b = await customer(5, 1);
    const before = await trialQuotaUsedCount(db);
    expect(before).toBeGreaterThanOrEqual(2);
    expect(await resetTrialQuota(db)).toBe(before);
    expect(await usedOf(a)).toBe(0);
    expect(await usedOf(b)).toBe(0);
    expect(await trialQuotaUsedCount(db)).toBe(0);
  });
});
