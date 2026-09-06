/**
 * `reset.ts` — emptying a shop's data without breaking the installation.
 *
 * Against a real Postgres, for the same reason `undo.test.ts` is: every claim
 * this module makes is a claim about Postgres. `TRUNCATE … CASCADE` reaching
 * an unlisted table, `RESTART IDENTITY` moving the sequences, the row triggers
 * that do not fire, the foreign keys that do not veto — a stub would prove
 * that this file agrees with itself, which is the failure CLAUDE.md's rule 6
 * is written about.
 *
 * ## Why every case runs inside a transaction that rolls back
 *
 * `resetShopData` empties the whole database. It does not scope itself to a
 * telegram id range the way the rest of the suite does, and it cannot — that
 * is the feature. So the transaction is the containment, and it is also
 * exactly how the route uses it: BEGIN, lock, reset, COMMIT or ROLLBACK.
 *
 * The lesson is on the record already. On 2026-09-02 a guard in `undo.ts` was
 * proved by removal with DATABASE_URL still pointed at the simulation, and the
 * next test deleted 8,303 orders. The `beforeAll` below is that lesson, and it
 * asks the database rather than the connection string, because a string can be
 * forged by a tunnel and eleven thousand customers cannot.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { connectPostgres, loadConfig } from '../src/db.js';
import { previewReset, resetShopData, RESET_KEEP } from '../src/reset.js';
import { undoSchemaFor } from '../src/undo.js';

/** The same ceiling `@shikoo/seed` refuses to wipe past, asked the same way. */
const NOT_A_SIMULATION = 1_000;

/** Outside the seed block and outside any real Mirzabot id. */
const CUSTOMER = 990_910_001;

let pgc: pg.Client;

beforeAll(async () => {
  const c = await connectPostgres(loadConfig());
  try {
    const { rows } = await c.query<{ n: string }>('SELECT count(*) AS n FROM users');
    const users = Number(rows[0]?.n ?? 0);
    if (users >= NOT_A_SIMULATION) {
      throw new Error(
        `refusing to run reset tests: this database holds ${users} users, which is ` +
          'not a scratch database. These tests truncate every table. Point ' +
          'DATABASE_URL at a disposable Postgres.',
      );
    }
  } finally {
    await c.end().catch(() => undefined);
  }
});

/** `report` narrates to stdout; these tests are about rows. */
const quiet = (): (() => void) => {
  const real = console.log;
  console.log = () => undefined;
  return () => {
    console.log = real;
  };
};

beforeEach(async () => {
  pgc = await connectPostgres(loadConfig());
  await pgc.query('BEGIN');
});

afterEach(async () => {
  // Always. A committed reset here would empty whichever database this ran
  // against, and no test in this file has any reason to keep its work.
  await pgc.query('ROLLBACK').catch(() => undefined);
  await pgc.end().catch(() => undefined);
});

async function count(table: string): Promise<number> {
  const { rows } = await pgc.query<{ n: string }>(`SELECT count(*) AS n FROM public."${table}"`);
  return Number(rows[0]?.n ?? 0);
}

/** A customer with an order and a wallet entry — the shop's data, in miniature. */
async function shopData(): Promise<number> {
  const { rows } = await pgc.query<{ id: string }>(
    `INSERT INTO users (telegram_id, status, registered_at)
          VALUES ($1, 'ACTIVE', now()) RETURNING id`,
    [CUSTOMER],
  );
  const userId = Number(rows[0]!.id);
  await pgc.query(
    `INSERT INTO orders (public_id, user_id, kind, quantity, unit_price_irr, discount_irr, total_irr)
          VALUES ('__reset-1', $1, 'NEW_PURCHASE', 1, 500000, 0, 500000)`,
    [userId],
  );
  await pgc.query(
    `INSERT INTO wallet_entries (user_id, kind, amount_irr, idempotency_key, note)
          VALUES ($1, 'TOPUP', 500000, '__reset-topup-1', 'reset fixture')`,
    [userId],
  );
  return userId;
}

/** An operator who must still be able to open the panel afterwards. */
async function operator(): Promise<void> {
  await pgc.query(
    `INSERT INTO access_users (id, email, display_name, role, active, created_at, updated_at)
          VALUES ('__reset-op', 'reset@samsos.org', 'reset fixture', 'ADMIN', 1, 0, 0)`,
  );
}

describe('resetShopData — the clean page an undo cannot give', () => {
  it('empties the shop and says what it removed', async () => {
    const done = quiet();
    try {
      await shopData();
      const before = await count('orders');
      expect(before).toBeGreaterThan(0);

      const result = await resetShopData(pgc);

      expect(await count('orders')).toBe(0);
      expect(await count('users')).toBe(0);
      expect(await count('wallet_entries')).toBe(0);
      // Reported per table rather than as one number, because the operator has
      // to be able to recognise their own shop in the list.
      expect(result.removed.some((r) => r.table === 'orders')).toBe(true);
      expect(result.total).toBeGreaterThanOrEqual(before);
    } finally {
      done();
    }
  });

  it('leaves every table in KEEP exactly as it found it', async () => {
    const done = quiet();
    try {
      await operator();
      await shopData();
      await pgc.query(
        `INSERT INTO admins (telegram_id, role, active) VALUES ($1, 'ADMIN', true)`,
        [CUSTOMER],
      );
      await pgc.query(
        `INSERT INTO devices (id, device_code, display_name, created_at, updated_at)
              VALUES ('__reset-dev', '__RESET-D1', 'phone', 0, 0)`,
      );

      const before = new Map<string, number>();
      for (const t of RESET_KEEP) before.set(t, await count(t));

      await resetShopData(pgc);

      for (const t of RESET_KEEP) {
        expect(await count(t), `${t} must survive a reset`).toBe(before.get(t));
      }
      // Named individually as well as counted, because these three are the
      // ones whose loss locks somebody out of their own installation.
      expect(await count('access_users')).toBeGreaterThan(0);
      expect(await count('admins')).toBeGreaterThan(0);
      expect(await count('devices')).toBeGreaterThan(0);
    } finally {
      done();
    }
  });

  it('succeeds in the exact case an undo answers 409 to', async () => {
    /**
     * Sam's requirement, as a test rather than a sentence: «نباید ارور بده».
     *
     * `applyUndo` DELETEs, and a foreign key from a row created after the
     * import holds a veto — that is the `undo_failed` wall this feature exists
     * to get past. The order below points at the user, `wallet_entries` is
     * append-only by trigger, and neither stops a TRUNCATE.
     */
    const done = quiet();
    try {
      const userId = await shopData();
      // A subscription too: `subscriptions.order_id` and
      // `orders.target_subscription_id` point at each other, which is the pair
      // that makes a delete order impossible to compute in the first place.
      await pgc.query(
        `INSERT INTO subscriptions
                (public_id, user_id, plan_name_at_sale, price_irr, status, purchased_at)
              VALUES ('__reset-sub-1', $1, 'reset fixture', 500000, 'ACTIVE', now())`,
        [userId],
      );

      await expect(resetShopData(pgc)).resolves.toBeDefined();
      expect(await count('subscriptions')).toBe(0);
      expect(await count('wallet_entries')).toBe(0);
    } finally {
      done();
    }
  });

  it('restarts the sequences, so the next import starts at 1', async () => {
    const done = quiet();
    try {
      await shopData();
      await resetShopData(pgc);

      const { rows } = await pgc.query<{ id: string }>(
        `INSERT INTO users (telegram_id, status, registered_at)
              VALUES ($1, 'ACTIVE', now()) RETURNING id`,
        [CUSTOMER + 1],
      );
      expect(Number(rows[0]!.id)).toBe(1);
    } finally {
      done();
    }
  });

  it('drops every undo recording and clears the button that points at it', async () => {
    /**
     * The data-loss bug this would be without it.
     *
     * An undo recording holds primary keys only, and the sequences have just
     * been set back to 1. So the ids in an old recording are about to belong
     * to rows from a different dump entirely, and «بازگرداندن» on that old run
     * would delete them.
     */
    const done = quiet();
    try {
      const runId = '33333333-4444-5555-6666-777777777777';
      const schema = undoSchemaFor(runId);
      await pgc.query(`CREATE SCHEMA "${schema}"`);
      await pgc.query(`CREATE TABLE "${schema}".users (id bigint)`);
      await pgc.query(
        `INSERT INTO import_runs (id, mode, status, dump_path, started_by, finished_at, undo_schema)
              VALUES ($1, 'APPLY', 'SUCCEEDED', '/tmp/__reset.sql', 'reset@samsos.org', now(), $2)`,
        [runId, schema],
      );

      const result = await resetShopData(pgc);

      expect(result.undoSchemas).toContain(schema);
      const { rows: left } = await pgc.query(
        `SELECT nspname FROM pg_namespace WHERE nspname = $1`,
        [schema],
      );
      expect(left).toHaveLength(0);

      // The run itself survives — it is the log of what led here — but with no
      // recording to offer.
      const { rows: run } = await pgc.query<{ undo_schema: string | null }>(
        `SELECT undo_schema FROM import_runs WHERE id = $1`,
        [runId],
      );
      expect(run).toHaveLength(1);
      expect(run[0]!.undo_schema).toBeNull();
    } finally {
      done();
    }
  });
});

describe('the guard on the KEEP set', () => {
  it('aborts rather than let CASCADE empty a table that must survive', async () => {
    /**
     * The silent trap, reproduced.
     *
     * `TRUNCATE … CASCADE` empties every table that REFERENCES a listed one,
     * listed or not, and reports nothing. No KEEP table references a wiped one
     * today — which is a fact about today's schema, not a property of it. One
     * foreign key added next month flips it, and the first sign would be a
     * panel that 403s the person who pressed the button.
     *
     * So the key is added here, inside the transaction, and the test asks
     * whether the guard notices. Rolled back with everything else.
     */
    const done = quiet();
    try {
      await operator();
      await pgc.query(`ALTER TABLE access_users ADD COLUMN __tmp_ref bigint REFERENCES users(id)`);

      await expect(resetShopData(pgc)).rejects.toThrow(/access_users/);
    } finally {
      done();
    }
  });

  it('refuses a KEEP entry that names no table', async () => {
    // A typo in the list does not fail loudly on its own: it quietly moves a
    // table into the wipe set. Simulated by renaming one out from under it,
    // which is the same thing a migration would do.
    const done = quiet();
    try {
      await pgc.query(`ALTER TABLE bank_sms_patterns RENAME TO bank_sms_patterns__moved`);
      await expect(resetShopData(pgc)).rejects.toThrow(/bank_sms_patterns/);
    } finally {
      done();
    }
  });
});

describe('previewReset', () => {
  it('counts what a reset would remove, and removes nothing', async () => {
    const done = quiet();
    try {
      await shopData();
      const before = await count('orders');

      const preview = await previewReset(pgc);

      expect(await count('orders')).toBe(before);
      expect(preview.wipe.some((t) => t.table === 'orders')).toBe(true);
      expect(preview.total).toBeGreaterThan(0);
      // The preview's number is the promise the screen shows before arming the
      // button, so it has to be the number the reset then reports.
      const result = await resetShopData(pgc);
      expect(result.total).toBe(preview.total);
    } finally {
      done();
    }
  });

  it('lists the survivors too, so the screen can name them', async () => {
    const done = quiet();
    try {
      await operator();
      const preview = await previewReset(pgc);
      expect(preview.keep.map((t) => t.table).sort()).toEqual([...RESET_KEEP].sort());
      expect(preview.keep.find((t) => t.table === 'access_users')?.rows).toBeGreaterThan(0);
      // Nothing that survives may appear in the list of what goes.
      const wiped = new Set(preview.wipe.map((t) => t.table));
      for (const t of RESET_KEEP) expect(wiped.has(t)).toBe(false);
    } finally {
      done();
    }
  });
});
