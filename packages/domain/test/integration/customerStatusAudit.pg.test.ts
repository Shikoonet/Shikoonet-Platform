/**
 * Blocking a customer, and the trail it has to leave — against a real Postgres.
 *
 * ## The bug this exists for
 *
 * `setCustomerStatus` has always been shared by two callers, and the comment
 * above it said so: «the same helper the admin panel and the dashboard block
 * with, so there is one statement in the codebase that can put a customer in
 * this state». They shared the UPDATE and nothing else. The dashboard route
 * wrote `customer.blocked` into `audit_logs` after calling it; `blockForSpam`
 * did not — and the flood guard is precisely the thing that blocks people with
 * nobody watching.
 *
 * So the blocks least likely to be remembered were the ones with no record:
 * `users.blocked_reason` held a constant string and there was no actor and no
 * timestamp anywhere. «چرا این مشتری مسدود است و کِی؟» had no answer.
 *
 * That is CLAUDE.md rule 6 turned on our own code: a comment claiming two
 * surfaces cannot drift is not evidence that they have not.
 *
 * ## Why Postgres and not a fake
 *
 * The audit row is written from the UPDATE's own `RETURNING` in one statement,
 * so «the row moved» and «the row was recorded» are the same fact and cannot
 * come apart. A fake would assert the SQL string; only the database can assert
 * that the CTE actually inserts, that the no-op case inserts nothing, and that
 * the append-only trigger has no objection.
 *
 * Needs DATABASE_URL with the schema applied.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresD1 } from '@shikoo/db';
import { setCustomerStatus } from '../../src/customerAdmin.js';

const { db, pool } = createPostgresD1();

afterAll(async () => {
  await pool.end();
});

const TG = 99_100_200;
let userId = 0;

async function auditRows() {
  const r = await db
    .prepare(
      `SELECT action, actor_email, actor_role, actor_telegram_id, before_json, after_json, reason
         FROM audit_logs
        WHERE entity_type = 'CUSTOMER' AND entity_id = ?1
        ORDER BY created_at ASC`,
    )
    .bind(String(userId))
    .all<{
      action: string;
      actor_email: string | null;
      actor_role: string;
      actor_telegram_id: number | null;
      before_json: string;
      after_json: string;
      reason: string | null;
    }>();
  return r.results ?? [];
}

beforeEach(async () => {
  // `audit_logs` is append-only — the trigger refuses DELETE — so a fresh
  // customer per test is how these stay isolated. TRUNCATE would be refused
  // too, and rightly.
  const row = await db
    .prepare(
      `INSERT INTO users (telegram_id, username, registered_at, status)
       VALUES (?1, 'zz-audit', now(), 'ACTIVE')
       ON CONFLICT (telegram_id) DO UPDATE SET status = 'ACTIVE', blocked_reason = NULL
       RETURNING id`,
    )
    .bind(TG + Math.floor(Math.random() * 1_000_000))
    .first<{ id: number }>();
  userId = Number(row!.id);
});

describe('an operator blocking from the panel', () => {
  it('moves the row and records who, what and why in one statement', async () => {
    const out = await setCustomerStatus(db, {
      userId,
      status: 'BLOCKED',
      reason: 'رسید جعلی',
      actor: { kind: 'OPERATOR', email: 'op@example.com', role: 'ADMIN' },
      note: 'رسید جعلی',
    });
    expect(out?.changed).toBe(true);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('customer.blocked');
    expect(rows[0]!.actor_email).toBe('op@example.com');
    expect(rows[0]!.actor_role).toBe('ADMIN');
    // The state it came FROM, so the row explains a change and not just an end.
    expect(JSON.parse(rows[0]!.before_json).status).toBe('ACTIVE');
    expect(JSON.parse(rows[0]!.after_json).status).toBe('BLOCKED');
    expect(JSON.parse(rows[0]!.after_json).blocked_reason).toBe('رسید جعلی');
  });

  it('records the unblock too, and clears the stale reason', async () => {
    await setCustomerStatus(db, {
      userId,
      status: 'BLOCKED',
      reason: 'رسید جعلی',
      actor: { kind: 'OPERATOR', email: 'op@example.com', role: 'ADMIN' },
    });
    await setCustomerStatus(db, {
      userId,
      status: 'ACTIVE',
      reason: null,
      actor: { kind: 'OPERATOR', email: 'op2@example.com', role: 'ADMIN' },
    });

    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual(['customer.blocked', 'customer.unblocked']);
    // A stale «چرا مسدود شد» on an active account is a sentence an operator
    // reads as current.
    const after = await db
      .prepare(`SELECT status, blocked_reason FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ status: string; blocked_reason: string | null }>();
    expect(after).toEqual({ status: 'ACTIVE', blocked_reason: null });
  });
});

describe('the flood guard, which nobody watches', () => {
  it('leaves a SYSTEM row — the block that used to leave none', async () => {
    await setCustomerStatus(db, {
      userId,
      status: 'BLOCKED',
      reason: 'auto-blocked for flooding the bot',
      actor: { kind: 'SYSTEM' },
      note: 'flood guard, update 4242',
    });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_role).toBe('SYSTEM');
    // Not an invented address. 0013 gave Telegram admins their own column
    // rather than writing a fake email into the table whose purpose is being
    // believed later; the same rule applies to a caller that is not a person.
    expect(rows[0]!.actor_email).toBeNull();
    expect(rows[0]!.actor_telegram_id).toBeNull();
    expect(rows[0]!.reason).toBe('flood guard, update 4242');
  });

  it('names a Telegram admin in its own column when the bot panel is the actor', async () => {
    await setCustomerStatus(db, {
      userId,
      status: 'BLOCKED',
      reason: 'از پنل ربات',
      actor: { kind: 'TELEGRAM', telegramId: 12_345 },
    });
    const rows = await auditRows();
    expect(rows[0]!.actor_telegram_id).toBe(12_345);
    expect(rows[0]!.actor_email).toBeNull();
    expect(rows[0]!.actor_role).toBe('SYSTEM');
  });
});

describe('a change that is not a change', () => {
  it('writes no audit row when the status already matches', async () => {
    await setCustomerStatus(db, {
      userId,
      status: 'BLOCKED',
      reason: 'first',
      actor: { kind: 'OPERATOR', email: 'op@example.com', role: 'ADMIN' },
    });
    const out = await setCustomerStatus(db, {
      userId,
      status: 'BLOCKED',
      reason: 'second',
      actor: { kind: 'OPERATOR', email: 'op@example.com', role: 'ADMIN' },
    });

    expect(out?.changed).toBe(false);
    // One, not two. `audit_logs` full of «BLOCKED → BLOCKED» is a log nobody
    // reads, and the reason on the row must not be quietly rewritten either.
    expect(await auditRows()).toHaveLength(1);
    const row = await db
      .prepare(`SELECT blocked_reason FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ blocked_reason: string }>();
    expect(row!.blocked_reason).toBe('first');
  });

  it('tells the loser of a race «nothing changed», so it does not announce a block it did not make', async () => {
    // Both callers read ACTIVE, both then run the guarded UPDATE. Sequential
    // here rather than truly concurrent, because that is the state the race
    // ends in and it is the state the flag has to describe: the second
    // statement matches no row.
    const first = await setCustomerStatus(db, {
      userId,
      status: 'BLOCKED',
      reason: 'flood',
      actor: { kind: 'SYSTEM' },
      note: 'flood guard, update 1',
    });
    expect(first?.changed).toBe(true);

    // The same call again — as the loser's statement behaves.
    const second = await setCustomerStatus(db, {
      userId,
      status: 'BLOCKED',
      reason: 'flood',
      actor: { kind: 'SYSTEM' },
      note: 'flood guard, update 2',
    });
    expect(second?.changed).toBe(false);

    // One row moved, one trail written, one caller told yes. `blockForSpam`
    // announces to the shop's channel off this flag.
    expect(await auditRows()).toHaveLength(1);
  });

  it('answers null for a customer that does not exist, and writes nothing', async () => {
    const out = await setCustomerStatus(db, {
      userId: 2_147_000_000,
      status: 'BLOCKED',
      reason: 'ghost',
      actor: { kind: 'OPERATOR', email: 'op@example.com', role: 'ADMIN' },
    });
    expect(out).toBeNull();
  });
});
