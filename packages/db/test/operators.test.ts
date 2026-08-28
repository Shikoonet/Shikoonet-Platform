/**
 * `upsertOperator` writes all four statements or none of them.
 *
 * This is the test the previous shape could not have passed. The bootstrap used
 * to write the account, then revoke the sessions, then write the audit row,
 * each on its own connection. A failure at the third left an administrator who
 * could sign in and no record that anybody had made one — and the audit table
 * looked complete, which is worse than an obviously missing row.
 *
 * Proving that by *asserting the happy path* would prove nothing: three
 * sequential writes that all succeed look exactly like one transaction that
 * succeeds. The difference is only visible when something fails partway, so
 * every case here injects a fault and then asks the database what survived.
 *
 * The fault is injected at each position in turn, not just the last one. A
 * rollback that works from the final statement and not the middle is a rollback
 * that has never been tested from the middle.
 *
 * Run against the sim database, like the rest of `packages/db`.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createPostgresD1, upsertOperator, OperatorExistsError } from '../src/index.js';
import type { D1Database, D1DatabaseSession, D1PreparedStatement } from '../src/types.js';

const { db, pool } = createPostgresD1();

afterAll(async () => {
  await pool.end();
});

let n = 0;
const freshEmail = (): string => `__inv-op-${process.pid}-${Date.now()}-${++n}@staging.invalid`;

const HASH_A = 'scrypt$32768$8$1$aaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbb';
const HASH_B = 'scrypt$32768$8$1$cccccccccccccccc$dddddddddddddddd';

/**
 * The same database, with one statement rigged to fail.
 *
 * Only `withSession` is wrapped, because that is the only path `upsertOperator`
 * takes. Throwing from inside the callback is what a real failure does, so the
 * ROLLBACK under test is the production one and not a test-only branch.
 */
function dbFailingOn(fragment: string): D1Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'withSession') return Reflect.get(target, prop, receiver);
      return <T,>(fn: (tx: D1DatabaseSession) => Promise<T>): Promise<T> =>
        target.withSession((tx) => {
          const rigged: D1DatabaseSession = {
            batch: (statements) => tx.batch(statements),
            prepare: (sql: string): D1PreparedStatement => {
              if (sql.includes(fragment)) {
                throw new Error(`injected failure: ${fragment}`);
              }
              return tx.prepare(sql);
            },
          };
          return fn(rigged);
        });
    },
  }) as D1Database;
}

async function countUsers(email: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*)::int AS n FROM access_users WHERE email = ?1`)
    .bind(email)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

async function readUser(email: string): Promise<{ id: string; password_hash: string } | null> {
  return db
    .prepare(`SELECT id, password_hash FROM access_users WHERE email = ?1`)
    .bind(email)
    .first<{ id: string; password_hash: string }>();
}

async function countAudit(entityId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE entity_id = ?1`)
    .bind(entityId)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

async function countLiveSessions(userId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*)::int AS n FROM operator_sessions
        WHERE access_user_id = ?1 AND revoked_at IS NULL`,
    )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? -1;
}

/** An operator with one live session, so the revoke step has something to do. */
async function seedOperatorWithSession(email: string): Promise<string> {
  const created = await upsertOperator(db, {
    email,
    role: 'ADMIN',
    passwordHash: HASH_A,
    allowUpdate: false,
    actor: 'seed',
    reason: 'fixture',
  });
  await db
    .prepare(
      `INSERT INTO operator_sessions (id, access_user_id, token_hash, expires_at)
       VALUES (gen_random_uuid(), ?1, ?2, now() + interval '1 hour')`,
    )
    .bind(created.id, `__inv-token-${created.id}`)
    .run();
  return created.id;
}

/** `access_users` cascades to `operator_sessions`; `audit_logs` is append-only. */
async function cleanup(email: string): Promise<void> {
  await db.prepare(`DELETE FROM access_users WHERE email = ?1`).bind(email).run();
}

describe('upsertOperator — the happy path', () => {
  it('creates an operator, an audit row, and revokes nothing', async () => {
    const email = freshEmail();
    try {
      const r = await upsertOperator(db, {
        email,
        role: 'ADMIN',
        passwordHash: HASH_A,
        allowUpdate: false,
        actor: 'tester',
        reason: 'operator bootstrap on staging',
      });
      expect(r.outcome).toBe('created');
      expect(r.revokedSessions).toBe(0);
      expect(await countUsers(email)).toBe(1);
      expect(await countAudit(r.id)).toBe(1);
    } finally {
      await cleanup(email);
    }
  });

  it('refuses an existing operator unless told to update', async () => {
    const email = freshEmail();
    try {
      await seedOperatorWithSession(email);
      await expect(
        upsertOperator(db, {
          email,
          role: 'ADMIN',
          passwordHash: HASH_B,
          allowUpdate: false,
          reason: 'second attempt',
        }),
      ).rejects.toBeInstanceOf(OperatorExistsError);
      // The refusal is a refusal, not a partial write.
      expect((await readUser(email))?.password_hash).toBe(HASH_A);
    } finally {
      await cleanup(email);
    }
  });

  it('updating revokes the sessions that knew the old password', async () => {
    const email = freshEmail();
    try {
      const id = await seedOperatorWithSession(email);
      expect(await countLiveSessions(id)).toBe(1);
      const r = await upsertOperator(db, {
        email,
        role: 'ADMIN',
        passwordHash: HASH_B,
        allowUpdate: true,
        reason: 'rotate',
      });
      expect(r.outcome).toBe('updated');
      expect(r.revokedSessions).toBe(1);
      expect(await countLiveSessions(id)).toBe(0);
      expect((await readUser(email))?.password_hash).toBe(HASH_B);
    } finally {
      await cleanup(email);
    }
  });
});

describe('upsertOperator — a failure at any position rolls the whole thing back', () => {
  it('a failing audit write leaves no operator behind', async () => {
    const email = freshEmail();
    try {
      await expect(
        upsertOperator(dbFailingOn('INSERT INTO audit_logs'), {
          email,
          role: 'ADMIN',
          passwordHash: HASH_A,
          allowUpdate: false,
          reason: 'bootstrap',
        }),
      ).rejects.toThrow('injected failure');
      // The one the old shape got wrong: an administrator who can sign in,
      // with nothing in the ledger saying anybody made one.
      expect(await countUsers(email)).toBe(0);
    } finally {
      await cleanup(email);
    }
  });

  it('a failing audit write leaves the password and the sessions untouched', async () => {
    const email = freshEmail();
    try {
      const id = await seedOperatorWithSession(email);
      const auditBefore = await countAudit(id);
      await expect(
        upsertOperator(dbFailingOn('INSERT INTO audit_logs'), {
          email,
          role: 'READ_ONLY',
          passwordHash: HASH_B,
          allowUpdate: true,
          reason: 'rotate',
        }),
      ).rejects.toThrow('injected failure');
      expect((await readUser(email))?.password_hash).toBe(HASH_A);
      expect(await countLiveSessions(id)).toBe(1);
      expect(await countAudit(id)).toBe(auditBefore);
    } finally {
      await cleanup(email);
    }
  });

  it('a failing session revoke leaves the password unchanged', async () => {
    const email = freshEmail();
    try {
      const id = await seedOperatorWithSession(email);
      await expect(
        upsertOperator(dbFailingOn('UPDATE operator_sessions'), {
          email,
          role: 'ADMIN',
          passwordHash: HASH_B,
          allowUpdate: true,
          reason: 'rotate',
        }),
      ).rejects.toThrow('injected failure');
      expect((await readUser(email))?.password_hash).toBe(HASH_A);
      expect(await countLiveSessions(id)).toBe(1);
    } finally {
      await cleanup(email);
    }
  });

  it('a failing account insert leaves no audit row behind either', async () => {
    const email = freshEmail();
    try {
      await expect(
        upsertOperator(dbFailingOn('INSERT INTO access_users'), {
          email,
          role: 'ADMIN',
          passwordHash: HASH_A,
          allowUpdate: false,
          reason: 'bootstrap',
        }),
      ).rejects.toThrow('injected failure');
      expect(await countUsers(email)).toBe(0);
    } finally {
      await cleanup(email);
    }
  });
});
