/**
 * Adapter behaviour against a real Postgres.
 *
 * A fake would prove nothing here: the whole point of the adapter is that
 * Postgres behaves the way the hub's code expects D1 to behave. These tests
 * exercise the actual driver, the actual transaction semantics, and the actual
 * partial unique indexes.
 *
 * Needs DATABASE_URL and migrations 0001-0005 applied (`pnpm sim:up`).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresD1 } from '../src/index.js';
import type { D1Database } from '../src/types.js';

const { db, pool } = createPostgresD1();

afterAll(async () => {
  await pool.end();
});

const NOW = 1_786_000_000_000;

async function reset(d: D1Database): Promise<void> {
  await d
    .prepare(
      `TRUNCATE reconciliation_matches, payment_claims, transaction_candidates,
                raw_sms_events, financial_accounts, devices RESTART IDENTITY CASCADE`,
    )
    .run();
  await d
    .prepare(
      `INSERT INTO devices (id, device_code, display_name, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)`,
    )
    .bind('dev-1', 'D1', 'phone', NOW)
    .run();
}

beforeEach(async () => {
  await reset(db);
});

describe('prepare / bind / run', () => {
  it('reports rows changed through meta.changes', async () => {
    const res = await db
      .prepare(`UPDATE devices SET display_name = ?2 WHERE id = ?1`)
      .bind('dev-1', 'renamed')
      .run();
    expect(res.meta.changes).toBe(1);
    expect(res.success).toBe(true);
  });

  it('reports zero changes when nothing matched', async () => {
    // assignmentPreview.ts and index.ts both branch on exactly this.
    const res = await db
      .prepare(`UPDATE devices SET display_name = 'x' WHERE id = ?1`)
      .bind('missing')
      .run();
    expect(res.meta.changes).toBe(0);
  });

  it('rebinding produces an independent statement', async () => {
    const st = db.prepare(`SELECT device_code FROM devices WHERE id = ?1`);
    expect(await st.bind('dev-1').first<{ device_code: string }>()).toEqual({
      device_code: 'D1',
    });
    expect(await st.bind('nope').first()).toBeNull();
  });
});

describe('first()', () => {
  it('returns the whole row with no argument', async () => {
    const row = await db
      .prepare(`SELECT id, device_code FROM devices WHERE id = ?1`)
      .bind('dev-1')
      .first<{ id: string; device_code: string }>();
    expect(row).toEqual({ id: 'dev-1', device_code: 'D1' });
  });

  it('returns a single column when named', async () => {
    const code = await db
      .prepare(`SELECT device_code FROM devices WHERE id = ?1`)
      .bind('dev-1')
      .first<string>('device_code');
    expect(code).toBe('D1');
  });

  it('returns null rather than undefined when there is no row', async () => {
    expect(await db.prepare(`SELECT 1 WHERE false`).first()).toBeNull();
  });
});

describe('bigint columns', () => {
  it('come back as numbers, not strings', async () => {
    // The hub's row types declare every timestamp as `number`. If these arrived
    // as strings, every date comparison in the codebase would silently fail.
    const row = await db
      .prepare(`SELECT created_at FROM devices WHERE id = ?1`)
      .bind('dev-1')
      .first<{ created_at: number }>();
    expect(typeof row?.created_at).toBe('number');
    expect(row?.created_at).toBe(NOW);
  });

  it('keeps arithmetic working on them', async () => {
    const row = await db
      .prepare(`SELECT created_at FROM devices WHERE created_at > ?1`)
      .bind(NOW - 1000)
      .first<{ created_at: number }>();
    expect(row?.created_at).toBe(NOW);
  });
});

describe('batch()', () => {
  it('applies every statement', async () => {
    const res = await db.batch([
      db.prepare(`UPDATE devices SET display_name = ?2 WHERE id = ?1`).bind('dev-1', 'a'),
      db.prepare(`UPDATE devices SET description = ?2 WHERE id = ?1`).bind('dev-1', 'b'),
    ]);
    expect(res).toHaveLength(2);
    const row = await db
      .prepare(`SELECT display_name, description FROM devices WHERE id = ?1`)
      .bind('dev-1')
      .first<{ display_name: string; description: string }>();
    expect(row).toEqual({ display_name: 'a', description: 'b' });
  });

  it('rolls the whole batch back when one statement fails', async () => {
    // This is the guarantee mirzabotVerify depends on: it writes the match row
    // and both status updates together, and a partial apply would leave a claim
    // verified with no match behind it.
    await expect(
      db.batch([
        db.prepare(`UPDATE devices SET display_name = ?2 WHERE id = ?1`).bind('dev-1', 'z'),
        db.prepare(`INSERT INTO devices (id, device_code, display_name, created_at, updated_at)
                    VALUES (?1, ?2, ?3, ?4, ?4)`).bind('dev-1', 'DUP', 'x', NOW),
      ]),
    ).rejects.toThrow();

    const row = await db
      .prepare(`SELECT display_name FROM devices WHERE id = ?1`)
      .bind('dev-1')
      .first<{ display_name: string }>();
    expect(row?.display_name).toBe('phone');
  });

  it('is a no-op for an empty list', async () => {
    expect(await db.batch([])).toEqual([]);
  });
});

describe('the money invariant survives the adapter', () => {
  beforeEach(async () => {
    await db
      .prepare(`INSERT INTO financial_accounts (id, bank_name, display_name, account_type, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?5)`)
      .bind('acct-1', 'melli', 'Melli', 'CARD', NOW)
      .run();
    await db
      .prepare(`INSERT INTO raw_sms_events (id, device_id, sender, body_sha256, app_checksum,
                                            sms_timestamp, received_at, classification,
                                            parser_status, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?6)`)
      .bind('sms-1', 'dev-1', '710', 'h1', 'c1', NOW, 'BANK_CREDIT', 'OK')
      .run();
    await db
      .prepare(`INSERT INTO transaction_candidates (id, raw_sms_event_id, direction, amount_irr,
                                                    bank_timestamp, confidence, parser_id,
                                                    parser_version, status, created_at, updated_at)
                VALUES (?1, ?2, 'CREDIT', ?3, ?4, 1.0, 'p', 'v1', 'PARSED', ?4, ?4)`)
      .bind('tx-1', 'sms-1', 1_000_000, NOW)
      .run();
    for (const id of ['claim-1', 'claim-2']) {
      await db
        .prepare(`INSERT INTO payment_claims (id, external_order_id, expected_amount_irr,
                                              submitted_at, source_system, status,
                                              created_at, updated_at)
                  VALUES (?1, ?2, ?3, ?4, 'bot', 'PENDING', ?4, ?4)`)
        .bind(id, `order-${id}`, 1_000_000, NOW)
        .run();
    }
  });

  const insertMatch = (id: string, claim: string, status: string) =>
    db
      .prepare(`INSERT INTO reconciliation_matches (id, transaction_candidate_id, payment_claim_id,
                                                    score, status, created_at, updated_at)
                VALUES (?1, ?2, ?3, 1.0, ?4, ?5, ?5)`)
      .bind(id, 'tx-1', claim, status, NOW)
      .run();

  it('refuses a second settling match on the same transaction', async () => {
    await insertMatch('m-1', 'claim-1', 'CONFIRMED');
    await expect(insertMatch('m-2', 'claim-2', 'AUTO_VERIFIED')).rejects.toThrow();
  });

  it('surfaces the conflict as a thrown error, so callers can abort', async () => {
    // mirzabotVerify wraps its batch in try/catch and returns
    // TRANSACTION_ALREADY_CONSUMED. That only works if the driver throws.
    await insertMatch('m-1', 'claim-1', 'CONFIRMED');
    let threw = false;
    try {
      await db.batch([
        db
          .prepare(`INSERT INTO reconciliation_matches (id, transaction_candidate_id,
                                                        payment_claim_id, score, status,
                                                        created_at, updated_at)
                    VALUES (?1, ?2, ?3, 1.0, 'CONFIRMED', ?4, ?4)`)
          .bind('m-3', 'tx-1', 'claim-2', NOW),
      ]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('still allows a non-settling suggestion', async () => {
    await insertMatch('m-1', 'claim-1', 'CONFIRMED');
    const res = await insertMatch('m-4', 'claim-2', 'SUGGESTED');
    expect(res.meta.changes).toBe(1);
  });
});

describe('INSERT OR IGNORE translation end to end', () => {
  it('swallows a duplicate instead of throwing', async () => {
    const stmt = () =>
      db
        .prepare(`INSERT OR IGNORE INTO devices (id, device_code, display_name, created_at, updated_at)
                  VALUES (?1, ?2, ?3, ?4, ?4)`)
        .bind('dev-2', 'D2', 'second', NOW)
        .run();
    expect((await stmt()).meta.changes).toBe(1);
    expect((await stmt()).meta.changes).toBe(0);
  });

  it('does NOT swallow a CHECK violation, unlike SQLite', async () => {
    // SQLite's OR IGNORE hides every constraint failure. Narrowing it to
    // uniqueness means a genuinely invalid row is now loud.
    await expect(
      db
        .prepare(`INSERT OR IGNORE INTO devices (id, device_code, display_name, active,
                                                 created_at, updated_at)
                  VALUES (?1, ?2, ?3, ?4, ?5, ?5)`)
        .bind('dev-3', 'D3', 'third', 7, NOW)
        .run(),
    ).rejects.toThrow();
  });
});

describe('withSession()', () => {
  it('commits on success', async () => {
    await db.withSession(async (tx) => {
      await tx.prepare(`UPDATE devices SET display_name = ?2 WHERE id = ?1`)
        .bind('dev-1', 'session-ok').run();
    });
    const row = await db.prepare(`SELECT display_name FROM devices WHERE id = ?1`)
      .bind('dev-1').first<{ display_name: string }>();
    expect(row?.display_name).toBe('session-ok');
  });

  it('rolls back when the callback throws', async () => {
    await expect(
      db.withSession(async (tx) => {
        await tx.prepare(`UPDATE devices SET display_name = ?2 WHERE id = ?1`)
          .bind('dev-1', 'session-bad').run();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const row = await db.prepare(`SELECT display_name FROM devices WHERE id = ?1`)
      .bind('dev-1').first<{ display_name: string }>();
    expect(row?.display_name).toBe('phone');
  });
});
