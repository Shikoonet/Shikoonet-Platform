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

import { isRelaxedEnv } from '@shikoo/contracts';
import { createPostgresD1 } from '@shikoo/db';
import { seed } from './generators.js';
import { seedCatalog } from './catalog.js';
import { seedShop } from './shop.js';

/**
 * Tables the migrations own rather than the seed.
 *
 * `schema_meta` is bookkeeping — wiping it would strand the schema.
 * `bank_card_prefixes` is reference data: which bank issued which card range,
 * inserted by `0007` and corrected by admins in the dashboard afterwards.
 * Truncating it would leave every card unattributed until someone noticed, and
 * re-seeding it here would throw away those corrections.
 *
 * `schema_migrations` is a statement about the SCHEMA, and this wipes DATA. The
 * first seed after the ledger landed truncated it and `schema status` then
 * reported all 21 migrations pending on a database that had every one of them —
 * a ledger that lies is worse than no ledger, because the whole point is being
 * able to trust it without reading the tables.
 */
const KEEP = new Set(['schema_meta', 'bank_card_prefixes', 'schema_migrations']);

/**
 * This truncates every table it is pointed at, so it may only ever be pointed
 * at a database on this machine. Customer data lives behind a hostname, and a
 * runner that will happily wipe it is one pasted connection string away from
 * doing so.
 */
export function assertLocal(connectionString: string): void {
  const host = new URL(connectionString).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error(
      `refusing to seed a non-local database (host ${host}). This wipes every table.`,
    );
  }
  // A hostname is not evidence of anything. `127.0.0.1` is exactly what the far
  // end of an SSH tunnel looks like, and a cutover is largely conducted through
  // one — so the check above would have waved through the single worst command
  // in this repository on the single worst night to run it.
  //
  // Asked as an allowlist rather than `=== 'production'`, which let `prod`,
  // `Production` and `staging` straight through. Unset still passes: this
  // script is run by hand a dozen times a day and the two guards either side of
  // it — a local hostname and a user count under a thousand — carry that case.
  const envName = process.env.ENV_NAME;
  if (envName !== undefined && envName !== '' && !isRelaxedEnv(envName)) {
    throw new Error(`refusing to seed with ENV_NAME=${envName}. This wipes every table.`);
  }
}

/**
 * How many users make a database somebody else's.
 *
 * Production holds 11,241. The simulation seed creates none at all, and the bot
 * suite leaves at most a few dozen behind, so this sits an order of magnitude
 * clear of both — it cannot fire on a working laptop and cannot miss a
 * migrated one.
 */
const NOT_A_SIMULATION = 1_000;

/**
 * Asks the database what it is, rather than asking the connection string.
 *
 * This is the guard that would actually have stopped the accident: the address
 * can be forged by a tunnel, but eleven thousand customers cannot.
 */
export async function assertNotRealData(
  db: ReturnType<typeof createPostgresD1>['db'],
): Promise<void> {
  const row = await db.prepare(`SELECT count(*)::int AS n FROM users`).first<{ n: number }>();
  const users = row?.n ?? 0;
  if (users >= NOT_A_SIMULATION) {
    throw new Error(
      `refusing to seed: this database holds ${users} users, which is not a simulation. ` +
        'This wipes every table.',
    );
  }
}

async function wipe(db: ReturnType<typeof createPostgresD1>['db']): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)
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
    // After the connection is open, because this one asks the database rather
    // than the string that reached it.
    await assertNotRealData(db);

    const wiped = await wipe(db);
    console.log(`wiped ${wiped.length} tables`);

    const counts = await seed(db);
    const catalog = await seedCatalog(db);
    // After the catalog: the shop fixture reads a plan out of it so its orders
    // and subscriptions point at something that exists.
    const shop = await seedShop(db);
    await grantLocalAdmin(db);

    for (const [key, value] of Object.entries({ ...counts, ...catalog, ...shop })) {
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
