import type { AuditAction } from '@hub/contracts';
import { SQL } from '@hub/database';
import type { D1Database } from '@hub/database';

/**
 * Append-only audit log writer. Every approval, rejection, fake-receipt
 * decision, comment, match change, credential rotation, and reveal must
 * route through this.
 */
export async function recordAudit(db: D1Database, a: AuditAction & { id?: string }): Promise<void> {
  const id = a.id ?? crypto.randomUUID();
  const created = Date.now();
  await db
    .prepare(SQL.insertAudit)
    .bind(
      id,
      a.actorEmail,
      a.actorRole,
      a.action,
      a.entityType,
      a.entityId,
      JSON.stringify(a.before ?? null),
      JSON.stringify(a.after ?? null),
      a.reason ?? null,
      a.requestId ?? null,
      created,
    )
    .run();
}
