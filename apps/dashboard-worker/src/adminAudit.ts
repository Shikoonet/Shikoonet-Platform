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

export type Ident = { email: string; role: AccessRole };

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
  await db
    .prepare(
      `INSERT INTO audit_logs
         (id, actor_email, actor_role, action, entity_type, entity_id,
          before_json, after_json, reason, request_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10)`,
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
    )
    .run();
}
