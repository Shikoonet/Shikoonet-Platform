/**
 * Standalone seed runner for the simulation Postgres.
 *
 *   corepack pnpm --filter @shikoo/seed seed:sim
 *
 * Wipes every table except `schema_meta`, then runs the deterministic seed and
 * the catalog fixture and prints the row counts.
 *
 * This existed as an empty stub, which is why the simulation database could
 * never be populated: the seed only ever ran inside the workerd/D1 vitest
 * harness, so anything wanting to *look* at seeded data — the dashboard, a
 * Playwright run, a human — had nothing to look at.
 */

import { createPostgresD1 } from '@shikoo/db';
import { seed } from './generators.js';
import { seedCatalog } from './catalog.js';

/**
 * Tables the migrations own rather than the seed.
 *
 * `schema_meta` is bookkeeping — wiping it would strand the schema.
 * `bank_card_prefixes` is reference data: which bank issued which card range,
 * inserted by `0007` and corrected by admins in the dashboard afterwards.
 * Truncating it would leave every card unattributed until someone noticed, and
 * re-seeding it here would throw away those corrections.
 */
const KEEP = new Set(['schema_meta', 'bank_card_prefixes']);

/**
 * This truncates every table it is pointed at, so it may only ever be pointed
 * at a database on this machine. Customer data lives behind a hostname, and a
 * runner that will happily wipe it is one pasted connection string away from
 * doing so.
 */
function assertLocal(connectionString: string): void {
  const host = new URL(connectionString).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error(
      `refusing to seed a non-local database (host ${host}). This wipes every table.`,
    );
  }
}

async function wipe(db: ReturnType<typeof createPostgresD1>['db']): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    )
    .all<{ tablename: string }>();
  const tables = (results ?? []).map((r) => r.tablename).filter((t) => !KEEP.has(t));
  if (tables.length === 0) return [];
  // One statement, so foreign keys never see a half-empty database.
  await db.prepare(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`).run();
  return tables;
}

/**
 * The dashboard checks `access_users` even when `TEST_ACCESS_USER` skips the
 * JWT, so a wiped table locks the local dashboard out with a 403 that looks
 * like a bug. Deliberately here and not in `seed()`: `seed()` also runs inside
 * the test harness, where a pre-granted admin would quietly weaken the tests
 * that assert a 403.
 */
async function grantLocalAdmin(db: ReturnType<typeof createPostgresD1>['db']): Promise<void> {
  const email = process.env['TEST_ACCESS_USER'];
  if (!email) return;
  await db
    .prepare(
      `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)
       ON CONFLICT (email) DO UPDATE SET role = 'ADMIN', active = 1`,
    )
    .bind(`local-admin`, email, Date.now())
    .run();
  console.log(`  granted local ADMIN to ${email}`);
}

export async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is required');
  assertLocal(connectionString);

  const { db, pool } = createPostgresD1({ connectionString });
  try {
    const wiped = await wipe(db);
    console.log(`wiped ${wiped.length} tables`);

    const counts = await seed(db);
    const catalog = await seedCatalog(db);
    await grantLocalAdmin(db);

    for (const [key, value] of Object.entries({ ...counts, ...catalog })) {
      console.log(`  ${key.padEnd(24)} ${value}`);
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
