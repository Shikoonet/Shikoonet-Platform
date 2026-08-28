/**
 * The first operator on a fresh environment, made in one deliberate step.
 *
 * `operator create` followed by `operator set-password` already did this in two.
 * Two steps is right at a terminal, where the person can see what happened
 * between them; it is wrong for a bootstrap, because a run that dies in the
 * middle leaves a row nobody can sign in as and no record that anybody tried.
 * This does both halves or neither, and writes an `audit_logs` row either way
 * it succeeds — the panel's own account screen would have, and the account it
 * creates is the one that unlocks that screen.
 *
 * Everything here is a decision the caller has already made. The prompting, the
 * hiding of the password and the reading of `ENV_NAME` all live in
 * `operator.ts`; this file is what the tests can call. Nothing it returns
 * contains the password, the hash, a session token or a TOTP secret.
 */

import type { D1Database } from '@shikoo/db';
import { hashPassword, passwordProblem } from '@shikoo/domain';

export const ROLES = ['ADMIN', 'REVIEWER', 'READ_ONLY'] as const;
export type Role = (typeof ROLES)[number];

/**
 * The environment this is allowed to run against, unless told otherwise.
 *
 * Fail-closed, and the closed case is the interesting one: an unset `ENV_NAME`
 * is not «probably a laptop», it is «this process does not know which database
 * it is about to write an administrator into». Production is reached by saying
 * so out loud, in `--env`, on purpose.
 */
export const DEFAULT_ENV = 'staging';

export interface BootstrapInput {
  /** `ENV_NAME` as the process actually sees it. `undefined` is a refusal. */
  envName: string | undefined;
  /** The environment the caller intends to write to. Defaults to staging. */
  expectEnv?: string | undefined;
  email: string;
  role?: string | undefined;
  password: string;
  /** An existing operator is left alone unless this says otherwise. */
  update?: boolean | undefined;
  /** Recorded in the audit row, so the ledger says who ran this. */
  actor?: string | undefined;
}

export interface BootstrapResult {
  outcome: 'created' | 'updated';
  email: string;
  role: Role;
  /** Sessions revoked because the password changed under them. */
  revokedSessions: number;
}

export class BootstrapError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'wrong_env'
      | 'bad_email'
      | 'bad_role'
      | 'bad_password'
      | 'exists'
      | 'missing',
  ) {
    super(message);
    this.name = 'BootstrapError';
  }
}

/**
 * Deliberately narrow, and deliberately not a full RFC 5322 parser.
 *
 * This is the identifier of a person who will hold ADMIN on a shop's money.
 * A shape that is obviously an address, lower-cased so it collides with the
 * unique index rather than sitting beside a differently-cased twin, and
 * nothing exotic. Anything rejected here can be created by a person who has
 * already signed in.
 */
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Every refusal, before a single write. */
function check(input: BootstrapInput): { email: string; role: Role; expect: string } {
  const expect = input.expectEnv ?? DEFAULT_ENV;
  // The whole guard. `ENV_NAME` is what the container was told it is, and the
  // database it is connected to came from the same configuration block — so
  // the two agreeing is the closest thing to proof available from inside the
  // process that this is not production.
  if (input.envName !== expect) {
    throw new BootstrapError(
      `this writes an administrator, so it runs only where ENV_NAME is ${JSON.stringify(expect)} — ` +
        `this process has ${input.envName === undefined ? 'no ENV_NAME at all' : JSON.stringify(input.envName)}`,
      'wrong_env',
    );
  }

  const email = normalizeEmail(input.email);
  if (!EMAIL.test(email) || email.length > 254) {
    throw new BootstrapError(`${JSON.stringify(input.email)} is not an email address`, 'bad_email');
  }

  const role = (input.role ?? 'ADMIN').trim().toUpperCase();
  if (!(ROLES as readonly string[]).includes(role)) {
    throw new BootstrapError(`role must be one of ${ROLES.join(', ')}`, 'bad_role');
  }

  const problem = passwordProblem(input.password);
  if (problem) throw new BootstrapError(problem, 'bad_password');

  return { email, role: role as Role, expect };
}

/**
 * Create, or knowingly update, exactly one operator.
 *
 * Idempotent in the only sense that matters here: running it twice with
 * `update` reaches the same end state, and running it twice without `update`
 * refuses the second time rather than quietly resetting a password somebody is
 * already using.
 */
export async function bootstrapOperator(
  db: D1Database,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  const { email, role } = check(input);

  const existing = await db
    .prepare(`SELECT id, role FROM access_users WHERE email = ?1`)
    .bind(email)
    .first<{ id: string; role: string }>();

  if (existing && input.update !== true) {
    throw new BootstrapError(
      `${email} already exists — re-run with --update to change its password and role`,
      'exists',
    );
  }

  // Hashed once, here, so neither branch below can be written to store a
  // plaintext by accident. `hashPassword` is the same call the login path
  // verifies against — a second implementation would be a second thing to get
  // wrong.
  const hash = await hashPassword(input.password);
  const id = existing?.id ?? crypto.randomUUID();
  const now = Date.now();

  if (existing) {
    await db
      .prepare(
        `UPDATE access_users
            SET role = ?2, active = 1, password_hash = ?3, password_updated_at = now(),
                failed_attempts = 0, locked_until = NULL, updated_at = ?4
          WHERE id = ?1`,
      )
      .bind(id, role, hash, now)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO access_users
           (id, email, role, active, created_at, updated_at, password_hash, password_updated_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?4, ?5, now())`,
      )
      .bind(id, email, role, now, hash)
      .run();
  }

  // Every session that existed belonged to whoever knew the previous password.
  const killed = await db
    .prepare(
      `UPDATE operator_sessions SET revoked_at = now()
        WHERE access_user_id = ?1 AND revoked_at IS NULL`,
    )
    .bind(id)
    .run();

  // `audit_logs`, not `app_events`: this is what an operator did, and the table
  // has an append-only trigger on it. `SYSTEM` because the actor held a shell
  // rather than a session — there was no session to hold yet.
  //
  // `after_json` names the account and its role and stops there. A password
  // field, even null, is a field somebody later fills in.
  await db
    .prepare(
      `INSERT INTO audit_logs
         (id, actor_email, actor_role, action, entity_type, entity_id,
          after_json, reason, created_at)
       VALUES (?1, ?2, 'SYSTEM', ?3, 'access_user', ?4, ?5, ?6, ?7)`,
    )
    .bind(
      crypto.randomUUID(),
      input.actor ?? null,
      existing ? 'operator.bootstrap.updated' : 'operator.bootstrap.created',
      id,
      JSON.stringify({ email, role, active: 1 }),
      `operator bootstrap on ${input.envName}`,
      now,
    )
    .run();

  return {
    outcome: existing ? 'updated' : 'created',
    email,
    role,
    revokedSessions: killed.meta.changes,
  };
}
