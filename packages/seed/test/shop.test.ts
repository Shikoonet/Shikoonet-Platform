/**
 * The shop fixture, checked against the database rather than against itself.
 *
 * A fixture is data, and the tempting test for data is "some rows exist" —
 * which is exactly the assertion that let `users` stay empty for months while
 * every screen above it looked fine. So these check the properties the screens
 * and guards actually depend on, and each one is checked against an outside
 * authority: the ledger for balances, Postgres's own CHECK for order totals,
 * the status column for who «ارسال گروهی» is allowed to reach.
 *
 * Runs against the simulation Postgres. `seedShop` is idempotent, so this does
 * not truncate anything and does not care what ran before it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresD1 } from '@shikoo/db';
import { seedShop } from '../src/shop.js';
import { seedCatalog } from '../src/catalog.js';

const url = process.env['DATABASE_URL'];

let db: ReturnType<typeof createPostgresD1>['db'];
let pool: ReturnType<typeof createPostgresD1>['pool'];

beforeAll(async () => {
  if (!url) throw new Error('DATABASE_URL is required — run through sim/.env.local');
  ({ db, pool } = createPostgresD1({ connectionString: url }));
  // The fixture reads a plan out of the catalog, so the catalog has to be there.
  await seedCatalog(db);
  await seedShop(db);
});

afterAll(async () => {
  await pool?.end();
});

const one = async <T>(sql: string): Promise<T> => {
  const row = await db.prepare(sql).first<T>();
  if (!row) throw new Error(`no row for ${sql}`);
  return row;
};

describe('the shop fixture', () => {
  it('derives every balance from the ledger and never writes one', async () => {
    // The one assertion that would catch a fixture inventing a balance: the
    // trigger's output must equal the sum of the entries that produced it. If
    // `seedShop` ever wrote to `wallets` directly, this is what goes red.
    const { n } = await one<{ n: number }>(`
      SELECT count(*)::int AS n FROM (
        SELECT u.id,
               COALESCE((SELECT sum(amount_irr) FROM wallet_entries e WHERE e.user_id = u.id), 0) AS ledger,
               COALESCE((SELECT balance_irr FROM wallets w WHERE w.user_id = u.id), 0) AS derived
          FROM users u
      ) x WHERE ledger <> derived
    `);
    expect(n).toBe(0);
  });

  it('leaves at least one wallet in debt', async () => {
    // `walletHeldIrr` on the dashboard is a sum over these. With only positive
    // balances a dropped sign is invisible, and the reseller ceiling has
    // nothing to be a ceiling over.
    const { n } = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM wallets WHERE balance_irr < 0`,
    );
    expect(n).toBeGreaterThan(0);
  });

  it('has someone «ارسال گروهی» must skip', async () => {
    const active = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE status = 'ACTIVE'`,
    );
    const blocked = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE status = 'BLOCKED'`,
    );
    expect(active.n).toBeGreaterThan(0);
    // Without this the bulk screen's reach equals its customer count and the
    // «blocked customers are skipped» guard is never exercised by anything.
    expect(blocked.n).toBeGreaterThan(0);
  });

  it('gives the drawer a discount to round-trip', async () => {
    // The percent field seeds itself from the customer. Every customer at zero
    // means an empty field and a correct-looking screen either way.
    const { n } = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE discount_percent > 0`,
    );
    expect(n).toBeGreaterThan(0);
  });

  it('spreads orders across the statuses a customer can reach', async () => {
    const { kinds } = await one<{ kinds: number }>(
      `SELECT count(DISTINCT status)::int AS kinds FROM orders WHERE public_id LIKE 'FX-%'`,
    );
    expect(kinds).toBeGreaterThanOrEqual(5);
  });

  it('has a subscription inside the expiry warning window and one already gone', async () => {
    const soon = await one<{ n: number }>(`
      SELECT count(*)::int AS n FROM subscriptions
       WHERE public_id LIKE 'FXS-%' AND status = 'ACTIVE'
         AND expires_at BETWEEN now() AND now() + interval '3 days'
    `);
    const past = await one<{ n: number }>(`
      SELECT count(*)::int AS n FROM subscriptions
       WHERE public_id LIKE 'FXS-%' AND expires_at < now()
    `);
    expect(soon.n).toBeGreaterThan(0);
    expect(past.n).toBeGreaterThan(0);
  });

  it('adds nothing when it runs again', async () => {
    const before = await one<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
    const entriesBefore = await one<{ n: number }>(`SELECT count(*)::int AS n FROM wallet_entries`);
    await seedShop(db);
    const after = await one<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
    const entriesAfter = await one<{ n: number }>(`SELECT count(*)::int AS n FROM wallet_entries`);
    expect(after.n).toBe(before.n);
    // The wallet is append-only and its entries carry an idempotency key. A
    // second run that re-credited every fixture wallet would still leave the
    // user count untouched, which is why this counts entries too.
    expect(entriesAfter.n).toBe(entriesBefore.n);
  });
});
