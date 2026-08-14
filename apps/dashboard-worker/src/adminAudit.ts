/**
 * One writer for `audit_logs`, shared by the admin panel's routes.
 *
 * The table is append-only in Postgres (`trg_audit_logs_append_only`), so the
 * only thing a helper can get wrong is failing to write at all — which is
 * exactly what happens when each route hand-rolls its own INSERT and one of
 * them forgets a column. `entity_type` is a parameter because the panel touches
 * customers, plans and products; the shape of the row is not.
 */

import type { D1Database } from '@shikoo/database';
import type { AccessRole } from '@shikoo/contracts';

export type Ident = { email: string; role: AccessRole };

export async function audit(
  db: D1Database,
  ident: Ident,
  action: string,
  entityType: string,
  entityId: string,
  before: unknown,
  after: unknown,
  reason: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_logs
         (id, actor_email, actor_role, action, entity_type, entity_id,
          before_json, after_json, reason, request_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10)`,
    )
    .bind(
      crypto.randomUUID(),
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
