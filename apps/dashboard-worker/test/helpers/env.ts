/**
 * Replaces `import { env } from 'cloudflare:test'` for the dashboard worker.
 *
 * The Workers test pool gave each run a fresh D1 and applied the migrations
 * from `?raw` imports. Here the schema is the repo's own migrations, already
 * applied to the test database, so `applySchema()` only has to confirm that —
 * a suite that silently ran against an empty database would pass by asserting
 * nothing.
 *
 * Needs DATABASE_URL and migrations 0001-0005 applied (`pnpm sim:up`).
 */

import { createPostgresD1 } from '@shikoo/db';
import type { Env } from '../../src/index.js';

const { db, pool } = createPostgresD1();

/**
 * The same shape the Worker received as bindings.
 *
 * `TEST_ACCESS_USER` pins an identity so routes can be exercised without a
 * Cloudflare Access JWT. access.ts honours it only when set, and production
 * never sets it — the JWT path is what runs there, and access.test.ts covers it.
 */
export const env: Env = {
  DB: db,
  TEST_ACCESS_USER: 'admin@example.com',
  ENV_NAME: 'test',
  APP_VERSION: 'test',
  // Stated, not defaulted. The device routes refuse to issue a relay
  // configuration without it — see `deploy-config.test.ts` for why a default
  // was the wrong kind of convenience.
  INGEST_URL: 'https://ingest.test/api/v1/sms',
};

export { pool };

/** Tables the hub owns, in an order that satisfies the foreign keys. */
const HUB_TABLES = [
  'reconciliation_matches',
  'transaction_account_assignments',
  'transaction_detected_identifiers',
  'transaction_reviews',
  'reseller_transactions',
  'income_declined_transactions',
  'dashboard_transaction_reads',
  'dashboard_payment_event_reads',
  'account_assignment_preview_items',
  'account_assignment_previews',
  'payment_claims',
  'transaction_candidates',
  'raw_sms_events',
  'payment_cards',
  'financial_account_identifiers',
  'financial_accounts',
  'device_credentials',
  'devices',
  'integration_events',
  'audit_logs',
  'comments',
];

/**
 * Confirms the schema is present. Named `applySchema` because that is what the
 * Worker-era tests called; it no longer applies anything.
 */
export async function applySchema(): Promise<void> {
  const row = await db
    .prepare(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
    )
    .bind(HUB_TABLES)
    .first<{ n: number }>();
  if ((row?.n ?? 0) < HUB_TABLES.length) {
    throw new Error(
      `expected ${HUB_TABLES.length} hub tables, found ${row?.n ?? 0}. ` +
        'Apply migrations/000*.sql to DATABASE_URL first (pnpm sim:up).',
    );
  }
  // Every fixture product needs one; see `fixtureCategory` below.
  await fixtureCategory();
}

/** Empties every hub table so each suite starts from a known state. */
export async function resetHub(): Promise<void> {
  await db.prepare(`TRUNCATE ${HUB_TABLES.join(', ')} RESTART IDENTITY CASCADE`).run();
}

/**
 * A real signed-in session, as the login route would create one.
 *
 * Cloudflare Access is gone, and with it the `TEST_ACCESS_USER` bypass as a way
 * to test anything that runs with `ENV_NAME=production` — the bypass is refused
 * there on purpose, because a bypass that survives into production is the hole
 * `server.ts` already refuses to start on.
 *
 * So tests that need production behaviour need a real session. This builds one
 * the same way `operatorSession.ts` does — a random token, only its hash
 * stored — and hands back the Cookie header to send. Using the production
 * helpers rather than hand-writing a row means a change to how tokens are
 * hashed breaks this too, instead of leaving the tests passing against a shape
 * nothing uses any more.
 */
export async function signIn(email: string, role = 'ADMIN'): Promise<string> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)
       ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, active = 1`,
    )
    .bind(crypto.randomUUID(), email, role, now)
    .run();
  const { newSessionToken } = await import('@shikoo/domain');
  const { token, hash } = newSessionToken();
  await db
    .prepare(
      `INSERT INTO operator_sessions (id, access_user_id, token_hash, expires_at)
       SELECT ?1, u.id, ?2, now() + interval '1 hour' FROM access_users u WHERE u.email = ?3`,
    )
    .bind(crypto.randomUUID(), hash, email)
    .run();
  return `shikoo_session=${token}`;
}

/**
 * A category to hang fixture products off.
 *
 * `products.category_id` became NOT NULL in migration 0032, because the shop's
 * first screen is the category list and a product without one has no button on
 * any screen. Six fixture files insert products and none of them is about
 * categories, so they share this rather than each inventing one — and it is
 * never deleted, for the same reason `applySchema` does not drop tables between
 * files: the next file would find it gone.
 */
export async function fixtureCategory(name = '__fixture'): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO product_categories (name) VALUES (?1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  )
    .bind(name)
    .first<{ id: number }>();
  if (!row) throw new Error(`could not make the fixture category ${name}`);
  return row.id;
}

/**
 * This file's own fixture customers, and nobody else's.
 *
 * Six suites each pick a `TG_BASE` and each wrote
 * `DELETE FROM users WHERE telegram_id >= TG_BASE` — unbounded. So the suite
 * with the LOWEST base silently owned every other suite's customers: 940 000 000
 * deletes 950, 960, 990, 993 and everything above them. They pass today because
 * each file deletes before it inserts, which is ordering rather than isolation.
 *
 * It stopped being theoretical on 2026-09-04. A new suite at 996 100 000 gave
 * its customers ORDERS; the sweep in `bulk.test.ts` then hit
 * `orders_user_id_fkey` and took all 23 of its tests down — in a file that had
 * not changed. That is the shape of issue #46 one range up, and it is the
 * second time a fixture range has reached rows it did not own.
 *
 * One million ids is far more than any suite uses and far less than the gap
 * between two bases.
 */
export async function deleteFixtureUsers(base: number, span = 1_000_000): Promise<void> {
  const hi = base + span;
  const mine = `SELECT id FROM users WHERE telegram_id >= ?1 AND telegram_id < ?2`;
  /*
   * The rows that hang off those customers, bounded the SAME way.
   *
   * Bounding only the `users` delete was half a fix, and CodeRabbit was right
   * to say so on PR #93: the dependent deletes each suite wrote by hand still
   * read `telegram_id >= TG_BASE`, so a suite could still reach into another's
   * orders and subscriptions — the same landmine, one table down.
   *
   * They live here rather than in six files because the range is one idea, and
   * an idea spelled out six times is one that will be spelled wrong somewhere.
   */
  for (const table of ['reseller_requests', 'orders', 'subscriptions']) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE user_id IN (${mine})`)
      .bind(base, hi)
      .run();
  }
  await env.DB.prepare(`DELETE FROM admins WHERE telegram_id >= ?1 AND telegram_id < ?2`)
    .bind(base, hi)
    .run();
  await env.DB.prepare(`DELETE FROM users WHERE telegram_id >= ?1 AND telegram_id < ?2`)
    .bind(base, hi)
    .run();
}
