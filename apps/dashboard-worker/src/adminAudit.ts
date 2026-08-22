/**
 * One writer for `audit_logs`, shared by the admin panel's routes.
 *
 * The table is append-only in Postgres (`trg_audit_logs_append_only`), so the
 * only thing a helper can get wrong is failing to write at all — which is
 * exactly what happens when each route hand-rolls its own INSERT and one of
 * them forgets a column. `entity_type` is a parameter because the panel touches
 * customers, plans and products; the shape of the row is not.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import type { AccessRole } from '@shikoo/contracts';
import { createLogger } from '@shikoo/domain';

const log = createLogger('dashboard');

export type Ident = {
  email: string;
  role: AccessRole;
  /**
   * The id of the HTTP request this action came from, set once by the
   * middleware in `index.ts`. Optional because the bot and the scripts write
   * audit rows too, and neither has a request.
   */
  requestId?: string;
};

/**
 * A session as well as a database, so an audit row can be written inside the
 * transaction that earns it.
 *
 * It was `D1Database` alone, which sounds like a detail and was not: it made
 * "write, then record what you wrote" the only shape available to every caller,
 * because the two could not share a transaction even when the caller wanted
 * them to. Bulk repricing is the case that made it matter — the write is the
 * one irreversible thing the panel does, and its audit row is the only record
 * of what the prices used to be.
 */
type Db = D1Database | D1DatabaseSession;

export async function audit(
  db: Db,
  ident: Ident,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
  reason: string | null,
  /**
   * The row's own id, when the caller has one that means something.
   *
   * For an operation that must not run twice, this is the operation's id: the
   * primary key then IS the record that it already happened, with no second
   * table to keep in step. Everything else keeps a fresh uuid.
   */
  id: string = crypto.randomUUID(),
): Promise<void> {
  const insert = () =>
    db
      .prepare(
        `INSERT INTO audit_logs
           (id, actor_email, actor_role, action, entity_type, entity_id,
            before_json, after_json, reason, request_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?11, ?10)`,
      )
      .bind(
        id,
        ident.email,
        ident.role,
        action,
        entityType,
        entityId,
        before === null ? null : JSON.stringify(before),
        after === null ? null : JSON.stringify(after),
        reason,
        Date.now(),
        ident.requestId ?? null,
      )
      .run();

  // Inside a caller's transaction, the audit row and the change it describes
  // stand or fall together — which is the whole reason `Db` widened to accept a
  // session — so the error has to reach the caller and roll the pair back.
  if (isSession(db)) {
    await insert();
    return;
  }

  // On a bare connection it cannot: every one of these calls is the LAST
  // statement of a handler whose write has already committed. Throwing here
  // answered 500 for a change that had been made, and an operator who is told
  // «نشد» presses the button again — so a failed audit row bought a duplicate
  // create on the routes where a repeat is not idempotent.
  //
  // The row is lost either way. What this chooses is which of the two costs to
  // pay: the operator is told the truth, and the gap becomes an `error` in
  // «رویدادها» carrying who did what to which entity, with the request id that
  // ties it to the rest of that request. Silent it is not; atomic it is not
  // either, and the fix for that is the caller passing a session.
  try {
    await insert();
  } catch (err) {
    log.error(
      'audit.unrecorded',
      {
        action,
        entityType,
        entityId,
        actor: ident.email,
        // `trace` and `ref` are lifted out of the fields by `emit` into their
        // own columns, so «رویدادها» can gather this beside everything else
        // that request did and search it by the entity an admin has in hand.
        trace: ident.requestId,
        ref: entityId,
        consequence: 'the change was made and audit_logs has no row for it',
      },
      err,
    );
  }
}

/**
 * A session, told apart from a plain database.
 *
 * By the method rather than by a flag, so a caller inside a transaction gets
 * the strict behaviour without having to say so.
 *
 * The method is `withSession`, and the first version of this said `batch` —
 * which `D1DatabaseSession` also has (`packages/db/src/types.ts:24`). That
 * would have read every session as a bare connection and swallowed exactly the
 * errors that are supposed to roll a transaction back. Read off the interface
 * rather than assumed, after assuming it wrong once.
 */
function isSession(db: Db): db is D1DatabaseSession {
  return typeof (db as D1Database).withSession !== 'function';
}
