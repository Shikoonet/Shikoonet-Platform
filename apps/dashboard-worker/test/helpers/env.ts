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
}

/** Empties every hub table so each suite starts from a known state. */
export async function resetHub(): Promise<void> {
  await db.prepare(`TRUNCATE ${HUB_TABLES.join(', ')} RESTART IDENTITY CASCADE`).run();
}
