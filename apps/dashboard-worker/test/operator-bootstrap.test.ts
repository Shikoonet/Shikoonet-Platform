/**
 * The command that makes the first account on an environment nobody can sign
 * in to.
 *
 * Staging has zero rows in `access_users` — the panel answers 401 correctly and
 * there is no account for it to answer anything else about. Everything here is
 * about the one run that changes that, and the ways it must refuse:
 *
 *  - it writes an ADMIN into a database on the strength of `ENV_NAME` alone, so
 *    the wrong environment has to stop it before any statement is prepared;
 *  - a second run must not quietly reset a password somebody is already using;
 *  - and the row it writes has to be one the login route accepts, which is why
 *    the created account is signed in with rather than inspected.
 *
 * The password used below is a fixture, and one assertion exists purely to
 * prove it never reaches the audit table.
 *
 * Needs DATABASE_URL and the migrations applied (`pnpm sim:up`).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyPassword, newSessionToken } from '@shikoo/domain';
import { applySchema, env } from './helpers/env.js';
import { bootstrapOperator, BootstrapError } from '../scripts/bootstrapOperator.js';

const EMAIL = 'bootstrap@example.com';
const PASSWORD = 'a perfectly ordinary password';
const OTHER = 'a different ordinary password';

const db = env.DB;

/**
 * Only this file's accounts. The audit rows they left stay: `audit_logs` has a
 * BEFORE DELETE trigger that refuses, which is the property it exists for. Each
 * run's rows are found by the account's fresh uuid, so the leftovers cost
 * nothing — and the redaction assertion deliberately scans the whole table.
 */
async function wipe(): Promise<void> {
  await db.prepare(`DELETE FROM access_users WHERE email LIKE 'bootstrap%@example.com'`).run();
}

async function stored(email = EMAIL): Promise<{
  id: string;
  role: string;
  active: number;
  password_hash: string | null;
} | null> {
  return db
    .prepare(`SELECT id, role, active, password_hash FROM access_users WHERE email = ?1`)
    .bind(email)
    .first();
}

async function auditRows(id: string): Promise<{ action: string; after_json: string | null }[]> {
  const rows = await db
    .prepare(
      `SELECT action, after_json FROM audit_logs
        WHERE entity_type = 'access_user' AND entity_id = ?1 ORDER BY created_at, id`,
    )
    .bind(id)
    .all<{ action: string; after_json: string | null }>();
  return rows.results ?? [];
}

const ok = { envName: 'staging', email: EMAIL, password: PASSWORD } as const;

beforeAll(applySchema);
beforeEach(wipe);

describe('bootstrapOperator', () => {
  it('creates an operator who can actually sign in', async () => {
    const result = await bootstrapOperator(db, ok);

    expect(result).toMatchObject({ outcome: 'created', email: EMAIL, role: 'ADMIN' });
    const row = await stored();
    expect(row?.active).toBe(1);
    expect(row?.role).toBe('ADMIN');
    // The point of the whole command: the hash it wrote is one the login path
    // accepts. Asserting the column is merely non-null would pass for a hash of
    // the wrong thing.
    expect(await verifyPassword(PASSWORD, row?.password_hash ?? null)).toBe(true);
    expect(await verifyPassword(OTHER, row?.password_hash ?? null)).toBe(false);
  });

  it('refuses a second run rather than overwriting the first', async () => {
    const first = await bootstrapOperator(db, ok);
    const before = await stored();

    await expect(bootstrapOperator(db, { ...ok, password: OTHER })).rejects.toMatchObject({
      code: 'exists',
    });

    // Not merely «it threw». A refusal that had already written the hash would
    // have changed the password of an account somebody is using.
    const after = await stored();
    expect(after?.password_hash).toBe(before?.password_hash);
    expect(await verifyPassword(PASSWORD, after?.password_hash ?? null)).toBe(true);
    expect(await auditRows(after?.id as string)).toHaveLength(1);
    expect(first.outcome).toBe('created');
  });

  it('updates only when told to, and kills the sessions the old password opened', async () => {
    await bootstrapOperator(db, ok);
    const row = await stored();
    // A live session, exactly as `operatorSession.ts` writes one.
    const { hash } = newSessionToken();
    await db
      .prepare(
        `INSERT INTO operator_sessions (id, access_user_id, token_hash, expires_at)
         VALUES (?1, ?2, ?3, now() + interval '1 hour')`,
      )
      .bind(crypto.randomUUID(), row?.id, hash)
      .run();

    const result = await bootstrapOperator(db, {
      ...ok,
      password: OTHER,
      role: 'REVIEWER',
      update: true,
    });

    expect(result.outcome).toBe('updated');
    expect(result.revokedSessions).toBe(1);
    const after = await stored();
    expect(after?.id).toBe(row?.id);
    expect(after?.role).toBe('REVIEWER');
    expect(await verifyPassword(OTHER, after?.password_hash ?? null)).toBe(true);
    expect(await verifyPassword(PASSWORD, after?.password_hash ?? null)).toBe(false);
    const live = await db
      .prepare(
        `SELECT COUNT(*)::int AS n FROM operator_sessions
          WHERE access_user_id = ?1 AND revoked_at IS NULL`,
      )
      .bind(row?.id)
      .first<{ n: number }>();
    expect(live?.n).toBe(0);
  });

  it('writes an audit row for both outcomes, and no password in it', async () => {
    await bootstrapOperator(db, ok);
    await bootstrapOperator(db, { ...ok, password: OTHER, update: true });
    const row = await stored();

    const rows = await auditRows(row?.id as string);
    expect(rows.map((r) => r.action)).toEqual([
      'operator.bootstrap.created',
      'operator.bootstrap.updated',
    ]);
    // The whole table, not only this file's rows: a redaction bug that wrote
    // the password under some other entity_type would still be a leak.
    const all = await db
      .prepare(
        `SELECT COUNT(*)::int AS n FROM audit_logs
          WHERE COALESCE(after_json, '') || COALESCE(before_json, '') || COALESCE(reason, '')
                LIKE '%' || ?1 || '%'`,
      )
      .bind(PASSWORD)
      .first<{ n: number }>();
    expect(all?.n).toBe(0);
    expect(JSON.parse(rows[0]?.after_json ?? '{}')).toEqual({
      email: EMAIL,
      role: 'ADMIN',
      active: 1,
    });
  });

  describe('refusals, each before any write', () => {
    it('refuses an environment that is not the expected one', async () => {
      for (const envName of ['production', 'local', 'Staging', ' staging', undefined]) {
        await expect(bootstrapOperator(db, { ...ok, envName })).rejects.toMatchObject({
          code: 'wrong_env',
        });
      }
      expect(await stored()).toBeNull();
      // And production is reachable only by naming it — the guard is a
      // comparison, not a blanket ban.
      const named = await bootstrapOperator(db, {
        ...ok,
        envName: 'production',
        expectEnv: 'production',
      });
      expect(named.outcome).toBe('created');
    });

    it('refuses malformed input', async () => {
      const cases: [Partial<Parameters<typeof bootstrapOperator>[1]>, string][] = [
        [{ email: 'not-an-email' }, 'bad_email'],
        [{ email: 'no@tld' }, 'bad_email'],
        [{ email: '  ' }, 'bad_email'],
        [{ role: 'SUPERUSER' }, 'bad_role'],
        [{ password: 'short' }, 'bad_password'],
        // Long enough, four characters is what it lacks.
        [{ password: 'aaaaaaaaaaaaaaaaaaaa' }, 'bad_password'],
      ];
      for (const [over, code] of cases) {
        await expect(bootstrapOperator(db, { ...ok, ...over })).rejects.toMatchObject({ code });
      }
      const any = await db
        .prepare(`SELECT COUNT(*)::int AS n FROM access_users WHERE email LIKE 'bootstrap%'`)
        .first<{ n: number }>();
      expect(any?.n).toBe(0);
    });

    it('throws BootstrapError, so the CLI can tell a refusal from a crash', async () => {
      const error = await bootstrapOperator(db, { ...ok, envName: 'production' }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(BootstrapError);
      // The message names what was found, so the person running it can see
      // which box they are on — and it is an environment name, not a secret.
      expect((error as BootstrapError).message).toContain('production');
      expect((error as BootstrapError).message).not.toContain(PASSWORD);
    });
  });

  it('lower-cases the address, so a differently-cased twin cannot exist', async () => {
    await bootstrapOperator(db, { ...ok, email: '  BootStrap@Example.COM  ' });
    expect(await stored(EMAIL)).not.toBeNull();
  });
});
