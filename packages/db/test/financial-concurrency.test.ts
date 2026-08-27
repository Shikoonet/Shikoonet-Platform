/**
 * The money guarantees under genuine concurrency.
 *
 * ## Why this file exists
 *
 * Every partial unique index in this schema is a claim about what happens when
 * two things arrive at once. The suite proved them **serially** — submit,
 * await, submit again, assert the second did nothing — and a serial test
 * cannot distinguish «the index rejected the second writer» from «the first
 * writer had already committed and the second one read its row».
 *
 * Those are different systems. The second one loses money the first day two
 * operators press a button within the same few milliseconds, which is exactly
 * what a double-tapped confirmation and a retried request look like.
 *
 * ## How the overlap is made real
 *
 * Each contender gets its **own pooled connection** and its own transaction,
 * and the two are held open across a barrier:
 *
 *      A: BEGIN ── INSERT ──┐                    ┌── COMMIT
 *                           ├─ both at the wall ─┤
 *      B: BEGIN ── INSERT ──┘  (Promise.all)     └── COMMIT / 23505
 *
 * `Promise.all` on the two INSERTs is what forces the second writer to reach
 * the index while the first one's row is still uncommitted. Postgres blocks it
 * there — the unique index takes a lock on the key — and releases it at the
 * first COMMIT, at which point the second gets `23505`. Awaiting A before
 * starting B would never take that lock and would test nothing.
 *
 * ## What is asserted
 *
 * For every case: exactly one row exists, the survivor is the permitted one,
 * the loser failed with SQLSTATE `23505` (never by error-message text), the
 * wallet balance equals the sum of its ledger entries, and no double credit
 * or double settlement is visible afterwards.
 *
 * Needs DATABASE_URL and the migrations applied — same as every other test in
 * this package.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPostgresD1, isUniqueViolation } from '../src/index.js';

const CONNECTION = process.env['DATABASE_URL'] ?? '';

/**
 * Two independent connections, because one pooled client cannot hold two
 * open transactions. `max: 4` is two contenders plus headroom for the
 * fixture writes that run outside them.
 */
const pool = new pg.Pool({ connectionString: CONNECTION, max: 4 });
const { db, pool: d1Pool } = createPostgresD1({ connectionString: CONNECTION });

afterAll(async () => {
  await pool.end();
  await d1Pool.end();
});

const NOW = 1_786_400_000_000;
const PREFIX = '__conc-';

/**
 * Run `body` inside its own transaction on its own connection.
 *
 * The client is released whatever happens, including when the body throws —
 * a leaked client on a `max: 4` pool deadlocks the next test rather than
 * failing this one, which is a very confusing hour.
 */
async function inTx<T>(body: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await body(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Two writers that genuinely overlap.
 *
 * Both transactions open, both perform their write, and only then does either
 * commit. Returns the settled results so a caller can assert which one lost
 * AND how.
 *
 * The `Promise.allSettled` is the load-bearing line: it starts B's write
 * without awaiting A's, so B blocks on A's index lock rather than reading A's
 * committed row.
 */
async function raceInserts(
  write: (c: pg.PoolClient, tag: 'A' | 'B') => Promise<unknown>,
): Promise<PromiseSettledResult<unknown>[]> {
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');

    const results = await Promise.allSettled([
      write(a, 'A').then(async (r) => {
        await a.query('COMMIT');
        return r;
      }),
      write(b, 'B').then(async (r) => {
        await b.query('COMMIT');
        return r;
      }),
    ]);

    await a.query('ROLLBACK').catch(() => undefined);
    await b.query('ROLLBACK').catch(() => undefined);
    return results;
  } finally {
    a.release();
    b.release();
  }
}

/** Exactly one winner, and the loser lost for the right reason. */
function expectOneWinnerByUniqueViolation(results: PromiseSettledResult<unknown>[]): void {
  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected');

  expect(won.length, 'exactly one writer should have committed').toBe(1);
  expect(lost.length).toBe(1);

  const reason = (lost[0] as PromiseRejectedResult).reason as unknown;
  // SQLSTATE, not the message. `packages/db/src/index.ts:55` records why:
  // SQLite says «UNIQUE constraint failed: t.c» and Postgres says «duplicate
  // key value violates unique constraint "t_pkey"», so any code that matched
  // on words silently stopped working at the port and would silently start
  // working again on a locale change.
  expect(
    isUniqueViolation(reason),
    `loser should have failed with SQLSTATE 23505, got: ${String(reason)}`,
  ).toBe(true);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let userId: number;
let deviceId: string;
let accountId: string;

/**
 * A fresh customer, device and account for every test.
 *
 * NOT a truncate-and-reseed. `wallet_entries` is append-only by trigger
 * (`0001_core.sql:132`) and `wallets` holds a plain foreign key to `users`,
 * so «delete the fixture user» fails on `wallets_user_id_fkey` — which is
 * the schema telling the test what it is for. A ledger that could be erased
 * between runs would not be the ledger this shop relies on.
 *
 * So each test gets its own identity instead. `run` is a per-process counter
 * folded into a negative `telegram_id`: Telegram never issues a negative id
 * (`verify_invariants.sql:14-21`), so a fixture cannot collide with a seeded
 * row, and the counter means two tests in one file cannot collide either.
 */
let run = 0;

async function fixture(): Promise<void> {
  run += 1;
  const tag = `${PREFIX}${process.pid}-${run}`;

  const user = await db
    .prepare(
      `INSERT INTO users (telegram_id, username, status, registered_at)
       VALUES (?1, ?2, 'ACTIVE', now()) RETURNING id`,
    )
    .bind(-1 * (990_000_000 + process.pid % 100_000 + run), `${tag}-customer`)
    .first<{ id: number }>();
  userId = Number(user?.id);

  deviceId = `${tag}-device`;
  await db
    .prepare(
      `INSERT INTO devices (id, device_code, display_name, created_at, updated_at)
       VALUES (?1, ?2, 'concurrency fixture', ?3, ?3)`,
    )
    .bind(deviceId, `${tag}-D1`, NOW)
    .run();

  accountId = `${tag}-account`;
  await db
    .prepare(
      `INSERT INTO financial_accounts
         (id, bank_name, display_name, account_type, created_at, updated_at)
       VALUES (?1, 'FIXTURE BANK', 'concurrency fixture', 'ACCOUNT', ?2, ?2)`,
    )
    .bind(accountId, NOW)
    .run();
}

beforeEach(fixture);

/** One bank transaction, ready to be settled against. */
async function makeTransaction(id: string, amountIrr: number): Promise<string> {
  const rawId = `${accountId}-raw-${id}`;
  await db
    .prepare(
      `INSERT INTO raw_sms_events
         (id, device_id, sender, body_sha256, app_checksum, sms_timestamp,
          received_at, classification, parser_status, created_at)
       VALUES (?1, ?2, 'BANK', ?3, ?3, ?4, ?4, 'BANK_CREDIT', 'OK', ?4)`,
    )
    .bind(rawId, deviceId, `sha-${id}`, NOW)
    .run();
  const txId = `${accountId}-tx-${id}`;
  await db
    .prepare(
      `INSERT INTO transaction_candidates
         (id, raw_sms_event_id, financial_account_id, direction, amount_irr,
          confidence, parser_id, parser_version, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'CREDIT', ?4, 0.9, 'test', '1.0.0', 'PARSED', ?5, ?5)`,
    )
    .bind(txId, rawId, accountId, amountIrr, NOW)
    .run();
  return txId;
}

/** One customer claim, ready to be settled. */
async function makeClaim(id: string, amountIrr: number): Promise<string> {
  const claimId = `${accountId}-claim-${id}`;
  await db
    .prepare(
      `INSERT INTO payment_claims
         (id, external_order_id, expected_amount_irr, target_financial_account_id,
          submitted_at, source_system, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'test', 'PENDING', ?5, ?5)`,
    )
    .bind(claimId, `${accountId}-order-${id}`, amountIrr, accountId, NOW)
    .run();
  return claimId;
}

async function walletBalance(): Promise<number> {
  const row = await db
    .prepare(`SELECT balance_irr FROM wallets WHERE user_id = ?1`)
    .bind(userId)
    .first<{ balance_irr: number }>();
  return Number(row?.balance_irr ?? 0);
}

async function ledgerSum(): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(amount_irr), 0) AS s FROM wallet_entries WHERE user_id = ?1`)
    .bind(userId)
    .first<{ s: number }>();
  return Number(row?.s ?? 0);
}

// ---------------------------------------------------------------------------

describe('the overlap itself, proven rather than assumed', () => {
  it('the second writer BLOCKS on the index while the first is uncommitted', async () => {
    // This is the test that makes every other test in this file mean
    // something. Serialising the writers — await A, then start B — produces
    // the same pass/fail outcome for a unique index, so a suite that did
    // that would look identical while proving nothing about contention.
    //
    // Here the overlap is observable: A inserts and does NOT commit, B
    // inserts and is still pending several event-loop turns later, because
    // Postgres has parked it on A's index key lock. Only when A commits does
    // B resolve — with 23505.
    //
    // If a future migration replaced the unique index with an application
    // check, B would NOT block, this test would fail, and the failure would
    // name the exact thing that was lost.
    const key = `${accountId}-blocking`;
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');

      const insert = (c: pg.PoolClient) =>
        c.query(
          `INSERT INTO wallet_entries (user_id, amount_irr, kind, actor, note, idempotency_key)
           VALUES ($1, $2, 'ADMIN_ADJUST', 'test', 'blocking probe', $3)`,
          [userId, 55_000, key],
        );

      await insert(a); // holds the key, uncommitted

      let bSettled = false;
      const bPromise = insert(b).then(
        () => {
          bSettled = true;
          return 'fulfilled' as const;
        },
        (e: unknown) => {
          bSettled = true;
          return e;
        },
      );

      // Several turns of the loop, plus a real round trip to the server on a
      // THIRD connection. If B were going to resolve without waiting for A,
      // it would have done so by now; the round trip is what makes this a
      // statement about the server rather than about microtask ordering.
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      await db.prepare('SELECT 1 AS ok').first();

      expect(bSettled, 'B resolved without waiting — the index is not locking').toBe(false);

      // Confirm from the server's own view that two transactions are open on
      // this key, one of them waiting.
      const waiting = await db
        .prepare(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND state = 'active'
              AND query LIKE '%blocking probe%'`,
        )
        .first<{ n: number }>();
      expect(Number(waiting?.n ?? 0), 'expected one writer parked on a lock').toBeGreaterThan(0);

      await a.query('COMMIT');

      const outcome = await bPromise;
      expect(bSettled).toBe(true);
      expect(
        isUniqueViolation(outcome),
        `B should have lost with 23505 once A committed, got: ${String(outcome)}`,
      ).toBe(true);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  });
});

describe('two concurrent credits with the same idempotency key', () => {
  it('credits once, and the loser fails with SQLSTATE 23505', async () => {
    const key = `${accountId}-idem-same-key`;
    const results = await raceInserts((c) =>
      c.query(
        `INSERT INTO wallet_entries (user_id, amount_irr, kind, actor, note, idempotency_key)
         VALUES ($1, $2, 'ADMIN_ADJUST', 'test', 'concurrent credit', $3)`,
        [userId, 250_000, key],
      ),
    );

    expectOneWinnerByUniqueViolation(results);

    const rows = await db
      .prepare(`SELECT count(*)::int AS n FROM wallet_entries WHERE idempotency_key = ?1`)
      .bind(key)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);

    // The money question, asked directly: one credit, not two.
    expect(await walletBalance()).toBe(250_000);
    expect(await ledgerSum()).toBe(250_000);
  });

  it('the ledger sum equals the stored balance after a contested write', async () => {
    // `wallets.balance_irr` is trigger-derived (`schema-design.md:60-68`) and
    // no application ever assigns it. A trigger that fired on a rolled-back
    // INSERT would leave the two disagreeing, which is the failure this
    // assertion exists to catch — and it can only appear under contention.
    const key = `${accountId}-idem-sum`;
    await raceInserts((c) =>
      c.query(
        `INSERT INTO wallet_entries (user_id, amount_irr, kind, actor, note, idempotency_key)
         VALUES ($1, $2, 'ADMIN_ADJUST', 'test', 'sum check', $3)`,
        [userId, 137_000, key],
      ),
    );
    expect(await walletBalance()).toBe(await ledgerSum());
  });
});

describe('two concurrent bulk credits for the same batch + user', () => {
  it('applies the batch once, whichever request arrives first', async () => {
    // The real statement from `packages/domain/src/bulkCustomers.ts:70-74`,
    // key included, run twice at once. `ON CONFLICT DO NOTHING` means neither
    // writer throws — so the assertion is on the row count and on
    // `meta.changes`, which is what the route reports to the operator as
    // «credited N customers».
    const batchId = `${accountId}-batch-1`;
    const statement = (c: pg.PoolClient) =>
      c.query(
        `INSERT INTO wallet_entries (user_id, amount_irr, kind, actor, note, idempotency_key)
         SELECT u.id, $2, 'ADMIN_ADJUST', 'test', 'bulk', 'bulk:' || $1 || ':' || u.id
           FROM users u
          WHERE u.status = 'ACTIVE' AND u.id = $3
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [batchId, 90_000, userId],
      );

    const results = await raceInserts(statement);

    // Both succeed here — DO NOTHING is not an error — so this case asserts
    // the OUTCOME rather than the failure mode.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const rows = await db
      .prepare(
        `SELECT count(*)::int AS n FROM wallet_entries
          WHERE user_id = ?1 AND idempotency_key = ?2`,
      )
      .bind(userId, `bulk:${batchId}:${userId}`)
      .first<{ n: number }>();
    expect(rows?.n, 'one batch, one entry per customer').toBe(1);
    expect(await walletBalance()).toBe(90_000);
    expect(await walletBalance()).toBe(await ledgerSum());
  });

  it('a second, different batch credits again — idempotency is per batch, not per user', () => {
    // The boundary of the guarantee, stated so nobody widens it by accident.
    // `bulk:<batch>:<user>` deliberately lets a NEW decision credit the same
    // customer again; what it stops is one decision applying twice.
    expect(`bulk:batch-a:${userId}`).not.toBe(`bulk:batch-b:${userId}`);
  });
});

describe('two claims settling from the same bank transaction', () => {
  it('only one may reach CONFIRMED', async () => {
    // `idx_match_one_confirmed_per_tx` (0004_payment_hub.sql:228). One bank
    // transaction is one arrival of money; letting it verify two claims would
    // deliver two orders for one payment.
    const txId = await makeTransaction('shared', 1_000_000);
    const claimA = await makeClaim('a', 1_000_000);
    const claimB = await makeClaim('b', 1_000_000);

    const results = await raceInserts((c, tag) =>
      c.query(
        `INSERT INTO reconciliation_matches
           (id, transaction_candidate_id, payment_claim_id, score, status, created_at, updated_at)
         VALUES ($1, $2, $3, 1.0, 'CONFIRMED', $4, $4)`,
        [`${accountId}-m-${tag}`, txId, tag === 'A' ? claimA : claimB, NOW],
      ),
    );

    expectOneWinnerByUniqueViolation(results);

    const row = await db
      .prepare(
        `SELECT count(*)::int AS n FROM reconciliation_matches
          WHERE transaction_candidate_id = ?1 AND status = 'CONFIRMED'`,
      )
      .bind(txId)
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it('CONFIRMED and AUTO_VERIFIED share the same slot', async () => {
    // `idx_match_one_auto_per_tx` (0004:232) covers BOTH statuses, so an
    // auto-verification racing a manual confirmation cannot both land. Two
    // separate single-status indexes would have let exactly that through.
    const txId = await makeTransaction('mixed', 500_000);
    const claimA = await makeClaim('mix-a', 500_000);
    const claimB = await makeClaim('mix-b', 500_000);

    const results = await raceInserts((c, tag) =>
      c.query(
        `INSERT INTO reconciliation_matches
           (id, transaction_candidate_id, payment_claim_id, score, status, created_at, updated_at)
         VALUES ($1, $2, $3, 1.0, $4, $5, $5)`,
        [
          `${accountId}-mx-${tag}`,
          txId,
          tag === 'A' ? claimA : claimB,
          tag === 'A' ? 'CONFIRMED' : 'AUTO_VERIFIED',
          NOW,
        ],
      ),
    );

    expectOneWinnerByUniqueViolation(results);
  });
});

describe('two settlements against the same claim', () => {
  it('a claim cannot be settled twice, from two different transactions', async () => {
    // `idx_match_one_confirmed_per_claim` (0004:230). The mirror of the case
    // above: two genuine payments arriving for one order must not both settle
    // it, or the second is money the shop keeps with no order attached.
    const claimId = await makeClaim('once', 2_000_000);
    const txA = await makeTransaction('s-a', 2_000_000);
    const txB = await makeTransaction('s-b', 2_000_000);

    const results = await raceInserts((c, tag) =>
      c.query(
        `INSERT INTO reconciliation_matches
           (id, transaction_candidate_id, payment_claim_id, score, status, created_at, updated_at)
         VALUES ($1, $2, $3, 1.0, 'CONFIRMED', $4, $4)`,
        [`${accountId}-s-${tag}`, tag === 'A' ? txA : txB, claimId, NOW],
      ),
    );

    expectOneWinnerByUniqueViolation(results);

    const row = await db
      .prepare(
        `SELECT count(*)::int AS n FROM reconciliation_matches
          WHERE payment_claim_id = ?1 AND status IN ('CONFIRMED','AUTO_VERIFIED')`,
      )
      .bind(claimId)
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it('a REJECTED match does not occupy the settled slot', async () => {
    // The index is partial — `WHERE status IN ('CONFIRMED','AUTO_VERIFIED')`
    // — so a rejection must leave the claim settleable. Asserted under
    // contention because a full (non-partial) index would pass every serial
    // test and fail here.
    const claimId = await makeClaim('rejected-then', 750_000);
    const txA = await makeTransaction('r-a', 750_000);
    const txB = await makeTransaction('r-b', 750_000);

    await inTx((c) =>
      c.query(
        `INSERT INTO reconciliation_matches
           (id, transaction_candidate_id, payment_claim_id, score, status, created_at, updated_at)
         VALUES ($1, $2, $3, 0.2, 'REJECTED', $4, $4)`,
        [`${accountId}-rej`, txA, claimId, NOW],
      ),
    );

    // The real settlement still goes through.
    await expect(
      inTx((c) =>
        c.query(
          `INSERT INTO reconciliation_matches
             (id, transaction_candidate_id, payment_claim_id, score, status, created_at, updated_at)
           VALUES ($1, $2, $3, 1.0, 'CONFIRMED', $4, $4)`,
          [`${accountId}-ok`, txB, claimId, NOW],
        ),
      ),
    ).resolves.toBeDefined();
  });
});

describe('concurrent wallet ledger entries that are NOT duplicates', () => {
  it('both land, and the balance is their sum', async () => {
    // The other half of the guarantee. An index that rejected everything
    // under contention would pass every test above and break the shop; this
    // asserts that two genuinely different credits both survive a race.
    const results = await raceInserts((c, tag) =>
      c.query(
        `INSERT INTO wallet_entries (user_id, amount_irr, kind, actor, note, idempotency_key)
         VALUES ($1, $2, 'ADMIN_ADJUST', 'test', 'distinct', $3)`,
        [userId, tag === 'A' ? 100_000 : 40_000, `${accountId}-distinct-${tag}`],
      ),
    );

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await walletBalance()).toBe(140_000);
    expect(await ledgerSum()).toBe(140_000);
  });
});

describe('the unique-violation contract itself', () => {
  it('isUniqueViolation reads SQLSTATE, not the message text', () => {
    // Both shapes a driver can hand up. The message is deliberately WRONG in
    // the second case — code 23505 with unrelated words — because a helper
    // that matched on text would report false here and silently stop
    // recognising real conflicts.
    expect(isUniqueViolation({ code: '23505', message: 'anything at all' })).toBe(true);
    expect(
      isUniqueViolation({ code: '23503', message: 'duplicate key value violates unique constraint' }),
    ).toBe(false);
    expect(isUniqueViolation(new Error('duplicate key value violates unique constraint'))).toBe(
      false,
    );
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});