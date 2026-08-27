/**
 * The triggers that refuse to mutate `audit_logs`.
 *
 * `migrations/0004_payment_hub.sql:292` declares
 *
 *   CREATE TRIGGER trg_audit_logs_append_only
 *     BEFORE UPDATE OR DELETE ON audit_logs
 *     FOR EACH ROW EXECUTE FUNCTION deny_mutation();
 *
 * The same trigger pattern guards `wallet_entries` (`0001_core.sql:132`) and
 * `activity_log` (`0001_core.sql:169`). This file exercises the first one,
 * because `audit_logs` is the surface a reviewer can reach through the
 * dashboard and the one a quiet UPDATE/DELETE on would most plausibly
 * erase evidence rather than fix a typo.
 *
 * Without this test, a migration that dropped `trg_audit_logs_append_only`
 * — or rewrote `deny_mutation()` to a no-op — would leave the entire
 * suite green. The trigger is the schema-side enforcement of the rule
 * `docs/threat-model.md:96` writes down in prose. Prose without a daily
 * check is a comment.
 *
 * Run against the sim database (the same one `pnpm test` exercises); needs
 * migrations 0001-0005 applied, plus the trigger this test is about.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createPostgresD1 } from '../src/index.js';

const { db, pool } = createPostgresD1();

afterAll(async () => {
  await pool.end();
});

const NOW = 1_786_000_000_000;

// Each test inserts a row under a unique id; the trigger refuses DELETE on
// audit_logs, so cleanup must happen by id (the row stays in the table and
// tests use a fresh id every time). The `__inv-audit-` prefix means the
// seed (`packages/seed/src`) and other fixtures never share an id with us.
let nextId = 0;
function freshId(): string {
  return `__inv-audit-${process.pid}-${Date.now()}-${++nextId}`;
}

describe('audit_logs append-only trigger', () => {
  it('refuses UPDATE on audit_logs', async () => {
    const id = freshId();
    await db
      .prepare(
        `INSERT INTO audit_logs
           (id, entity_type, entity_id, actor_email, actor_role, action, created_at)
         VALUES (?1, 'TEST', ?2, 'ci@shikoo.local', 'SYSTEM', 'test.seed', ?3)`,
      )
      .bind(id, id, NOW)
      .run();
    // Postgres surfaces trigger refusals as SQLSTATE P0001 ("raise_exception")
    // wrapping a user-defined message. The driver here exposes that as a
    // thrown Error; the test does not promise which word is in the message,
    // only that an UPDATE which the trigger should block does block.
    await expect(
      db
        .prepare(`UPDATE audit_logs SET action = ?2 WHERE id = ?1`)
        .bind(id, 'test.tampered')
        .run(),
    ).rejects.toThrow();
  });

  it('refuses DELETE on audit_logs', async () => {
    const id = freshId();
    await db
      .prepare(
        `INSERT INTO audit_logs
           (id, entity_type, entity_id, actor_email, actor_role, action, created_at)
         VALUES (?1, 'TEST', ?2, 'ci@shikoo.local', 'SYSTEM', 'test.seed', ?3)`,
      )
      .bind(id, id, NOW)
      .run();
    await expect(
      db.prepare(`DELETE FROM audit_logs WHERE id = ?1`).bind(id).run(),
    ).rejects.toThrow();
  });

  it('leaves the row exactly as inserted when an UPDATE is refused', async () => {
    const id = freshId();
    await db
      .prepare(
        `INSERT INTO audit_logs
           (id, entity_type, entity_id, actor_email, actor_role, action, created_at)
         VALUES (?1, 'TEST', ?2, 'ci@shikoo.local', 'SYSTEM', 'test.seed', ?3)`,
      )
      .bind(id, id, NOW)
      .run();
    // The trigger fires BEFORE the row is touched, so a refused UPDATE must
    // not silently change `action`. Without this assertion the gate could
    // pass while the database accepted partial writes from a tampered
    // trigger that raised AFTER doing the work.
    try {
      await db
        .prepare(`UPDATE audit_logs SET action = ?2 WHERE id = ?1`)
        .bind(id, 'test.tampered')
        .run();
    } catch {
      // expected — the test is about what the row contains after the throw
    }
    const row = await db
      .prepare(`SELECT action FROM audit_logs WHERE id = ?1`)
      .bind(id)
      .first<{ action: string }>();
    expect(row?.action).toBe('test.seed');
  });

  it('still allows INSERT — the trigger is on UPDATE OR DELETE, not INSERT', async () => {
    // The trigger is the deny-mutation guard, not a deny-write guard. A
    // reviewer adding a new audit row must succeed; a tamperer rewriting an
    // old one must not. This test pins that the guard has not been widened
    // by accident to the column at all.
    await expect(
      db
        .prepare(
          `INSERT INTO audit_logs
             (id, entity_type, entity_id, actor_email, actor_role, action, created_at)
           VALUES (?1, 'TEST', ?2, 'ci@shikoo.local', 'SYSTEM', 'test.append', ?3)`,
        )
        .bind(freshId(), freshId(), NOW)
        .run(),
    ).resolves.toBeDefined();
  });
});