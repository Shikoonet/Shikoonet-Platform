/**
 * Every statement that touches an operator account, in one place.
 *
 * The rule this file exists to satisfy: new SQL belongs to `packages/db`. The
 * pre-existing statements scattered through the apps are debt, not precedent,
 * and nothing here is a licence to add more of them somewhere else.
 *
 * It is not a general operator API. It covers exactly two callers — the
 * bootstrap CLI and the deployment login probe — and each export is shaped by
 * what that caller actually needs rather than by what an operator table might
 * one day want.
 *
 * Two things deliberately stay outside:
 *
 *   - **Hashing.** `passwordHash` arrives already computed. `packages/domain`
 *     owns scrypt and the login route verifies against that same function; a
 *     second call site here would be a second thing to get wrong.
 *   - **Validation.** Email shape, role membership and password strength are
 *     the caller's refusals, made before a connection is opened. This file
 *     assumes they happened and enforces only what the database can.
 */

import type { D1Database, D1DatabaseSession } from './types.js';

/** The roles `access_users.role` will accept — the CHECK in `0004`. */
export const OPERATOR_ROLES = ['ADMIN', 'REVIEWER', 'READ_ONLY'] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

export interface OperatorUpsert {
  /** Already normalised and validated by the caller. */
  email: string;
  role: OperatorRole;
  /** Already hashed by the caller, with `@shikoo/domain`. */
  passwordHash: string;
  /** An existing row is left alone unless this says otherwise. */
  allowUpdate: boolean;
  /** Recorded in the audit row, so the ledger says who ran this. */
  actor?: string | null | undefined;
  /** Correlates the audit row with a request, when there is one. */
  requestId?: string | null | undefined;
  /** Free text for the audit row's `reason`. */
  reason: string;
}

export interface OperatorUpsertResult {
  outcome: 'created' | 'updated';
  id: string;
  /** Sessions revoked because the password changed under them. */
  revokedSessions: number;
}

/** The row is already there and the caller did not ask to change it. */
export class OperatorExistsError extends Error {
  constructor(readonly email: string) {
    super(`${email} already exists`);
    this.name = 'OperatorExistsError';
  }
}

/**
 * Create, or knowingly update, exactly one operator — all of it or none of it.
 *
 * The atomicity is the point, and it is why this is one function rather than
 * the four statements it used to be. The previous shape wrote the account, then
 * revoked the sessions, then wrote the audit row, each on its own connection.
 * A failure at the third left an administrator who could sign in and no record
 * that anybody had made one — the exact opposite of what an audit row is for,
 * and worse than no row at all because the table looks complete.
 *
 * `withSession` is a real BEGIN/COMMIT/ROLLBACK on one connection, so the
 * existence check below is inside the transaction too: two bootstraps racing
 * cannot both read «absent» and both insert.
 *
 * Idempotent in the only sense that matters here: run twice with `allowUpdate`
 * it reaches the same end state; run twice without, the second refuses rather
 * than quietly resetting a password somebody is already using.
 */
export async function upsertOperator(
  db: D1Database,
  input: OperatorUpsert,
): Promise<OperatorUpsertResult> {
  return db.withSession(async (tx: D1DatabaseSession) => {
    const existing = await tx
      .prepare(`SELECT id FROM access_users WHERE email = ?1`)
      .bind(input.email)
      .first<{ id: string }>();

    if (existing && !input.allowUpdate) throw new OperatorExistsError(input.email);

    const id = existing?.id ?? crypto.randomUUID();
    // `updated_at` is epoch-ms and `password_updated_at` is timestamptz. That
    // mismatch is deliberate and documented at `0021_operator_auth.sql:79-86`;
    // it is not a bug to tidy up here.
    const now = Date.now();

    if (existing) {
      await tx
        .prepare(
          `UPDATE access_users
              SET role = ?2, active = 1, password_hash = ?3, password_updated_at = now(),
                  failed_attempts = 0, locked_until = NULL, updated_at = ?4
            WHERE id = ?1`,
        )
        .bind(id, input.role, input.passwordHash, now)
        .run();
    } else {
      await tx
        .prepare(
          `INSERT INTO access_users
             (id, email, role, active, created_at, updated_at, password_hash, password_updated_at)
           VALUES (?1, ?2, ?3, 1, ?4, ?4, ?5, now())`,
        )
        .bind(id, input.email, input.role, now, input.passwordHash)
        .run();
    }

    // Every session that existed belonged to whoever knew the previous
    // password. Run unconditionally: on the create branch the id is fresh, so
    // nothing can reference it and this changes zero rows.
    const killed = await tx
      .prepare(
        `UPDATE operator_sessions SET revoked_at = now()
          WHERE access_user_id = ?1 AND revoked_at IS NULL`,
      )
      .bind(id)
      .run();

    // The same column set `adminAudit.audit()` writes, `before_json` and
    // `request_id` included. Those two were missing from the hand-rolled
    // version this replaces, which is how a row could look complete and not be.
    //
    // Not a call to `audit()` itself: that lives in the dashboard app, and
    // `packages/db` is underneath it. Importing upwards to save nine lines
    // would invert the layering the SQL rule exists to protect.
    //
    // `SYSTEM` because the actor held a shell rather than a session — there was
    // no session to hold yet. It is legal per the CHECK in `0004`.
    //
    // `after_json` names the account and its role and stops there. A password
    // field, even null, is a field somebody later fills in.
    await tx
      .prepare(
        `INSERT INTO audit_logs
           (id, actor_email, actor_role, action, entity_type, entity_id,
            before_json, after_json, reason, request_id, created_at)
         VALUES (?1, ?2, 'SYSTEM', ?3, 'access_user', ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(
        crypto.randomUUID(),
        input.actor ?? null,
        existing ? 'operator.bootstrap.updated' : 'operator.bootstrap.created',
        id,
        existing ? JSON.stringify({ id, email: input.email }) : null,
        JSON.stringify({ email: input.email, role: input.role, active: 1 }),
        input.reason,
        input.requestId ?? null,
        now,
      )
      .run();

    return {
      outcome: existing ? ('updated' as const) : ('created' as const),
      id,
      revokedSessions: killed.meta.changes,
    };
  });
}

/**
 * Remove an operator by address. Used by the login probe at both ends, so it
 * has to be safe when the row is not there.
 */
export async function deleteOperatorByEmail(db: D1Database, email: string): Promise<void> {
  await db.prepare(`DELETE FROM access_users WHERE email = ?1`).bind(email).run();
}

/**
 * Write one ADMIN straight in, for a probe that is testing the deployment
 * rather than the CLI.
 */
export async function insertOperatorWithHash(
  db: D1Database,
  email: string,
  passwordHash: string,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO access_users
         (id, email, role, active, created_at, updated_at, password_hash, password_updated_at)
       VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3, ?4, now())`,
    )
    .bind(crypto.randomUUID(), email, now, passwordHash)
    .run();
}

/**
 * How many un-revoked sessions an operator still holds.
 *
 * The probe's last assertion: a logout that only clears the cookie leaves this
 * above zero, and the replayed-cookie check alone would not notice.
 */
export async function countLiveSessions(db: D1Database, email: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*)::int AS n FROM operator_sessions s
         JOIN access_users u ON u.id = s.access_user_id
        WHERE u.email = ?1 AND s.revoked_at IS NULL`,
    )
    .bind(email)
    .first<{ n: number }>();
  return row?.n ?? -1;
}
