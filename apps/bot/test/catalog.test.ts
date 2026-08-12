import { describe, expect, it } from 'vitest';
import { seedCatalog } from '@shikoo/seed';
import { db } from './helpers/env.js';

/**
 * The catalog fixture lives in @shikoo/seed but has no suite of its own, because
 * @shikoo/seed has no database to test against. This is the first package that
 * both depends on it and has one.
 */
describe('seedCatalog', () => {
  it('produces a catalog the bot can sell from', async () => {
    const result = await seedCatalog(db);

    expect(result).toEqual({ providers: 3, categories: 2, products: 6, plans: 8 });

    const rows = await db
      .prepare(
        `SELECT p.code, p.kind, p.once_per_user, p.resellers_only,
                pr.kind AS provider_kind,
                COUNT(pl.id)::int AS plans,
                MIN(pl.price_irr)::bigint AS cheapest
           FROM products p
           JOIN provisioning_providers pr ON pr.id = p.provider_id
           LEFT JOIN product_plans pl ON pl.product_id = p.id
          WHERE p.code LIKE 'sim-%'
          GROUP BY p.id, pr.kind
          ORDER BY p.sort_order`,
      )
      .all<{
        code: string;
        kind: string;
        once_per_user: boolean;
        resellers_only: boolean;
        provider_kind: string;
        plans: number;
        cheapest: number;
      }>();

    expect(rows.results).toHaveLength(6);
    const byCode = new Map(rows.results.map((r) => [r.code, r]));
    expect(byCode.get('sim-vpn-basic')?.provider_kind).toBe('marzban');
    expect(byCode.get('sim-vpn-pro')?.provider_kind).toBe('hiddify');
    expect(byCode.get('sim-spotify')?.kind).toBe('spotify');
    // The free row and the reseller row are the two branches that get forgotten.
    expect(byCode.get('sim-vpn-trial')?.cheapest).toBe(0);
    expect(byCode.get('sim-vpn-trial')?.once_per_user).toBe(true);
    expect(byCode.get('sim-vpn-reseller')?.resellers_only).toBe(true);
  });

  it('is safe to run twice', async () => {
    // Seed first so the count being compared is the settled one, whatever else
    // in this shared database ran before.
    const first = await seedCatalog(db);
    const before = await countPlans();

    const second = await seedCatalog(db);
    const after = await countPlans();

    expect(second).toEqual(first);
    expect(after).toBe(before);
  });

  it('prices money as integer IRR', async () => {
    await seedCatalog(db);
    const row = await db
      .prepare(
        `SELECT COUNT(*)::int AS n FROM product_plans pl
           JOIN products p ON p.id = pl.product_id
          WHERE p.code LIKE 'sim-%' AND pl.price_irr <> trunc(pl.price_irr)`,
      )
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

async function countPlans(): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*)::int AS n FROM product_plans pl
         JOIN products p ON p.id = pl.product_id
        WHERE p.code LIKE 'sim-%'`,
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}
