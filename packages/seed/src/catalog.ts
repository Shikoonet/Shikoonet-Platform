/**
 * Deterministic catalog fixture: providers, categories, products, plans.
 *
 * Kept apart from `seed()` in generators.ts on purpose. That one builds the
 * payment-hub story — 600 SMS events, 350 claims, 250 matches — and its tests
 * assert exact counts. The bot needs something to sell, which is a different
 * fixture with a different lifetime, and mixing them would mean every change to
 * the shop breaks an ingestion test.
 *
 * Idempotent: every row is keyed by its natural `code` and inserted with
 * ON CONFLICT DO NOTHING, then read back by that code. The catalog tables are
 * not in any suite's TRUNCATE list, so calling this twice — or calling it after
 * a suite that wiped the hub — has to be safe. It is.
 *
 * No money is invented here that the invariants do not already police: prices
 * are bigint IRR, as everywhere outside the bot's own edge.
 */

import type { D1Database } from '@shikoo/database';

/** `kind` values the schema allows for a provider (0002_catalog.sql). */
type ProviderKind =
  | 'marzban'
  | 'marzneshin'
  | 'hiddify'
  | 'xui'
  | 'wireguard'
  | 'ai_account'
  | 'spotify'
  | 'manual';

/** `kind` values the schema allows for a product. */
type ProductKind = 'vpn' | 'ai_account' | 'spotify' | 'manual' | 'other';

interface PlanSpec {
  name: string;
  /** IRR. Toman only ever exists at the bot's edge. */
  priceIrr: number;
  durationDays: number | null;
  volumeGb: number | null;
  userLimit: number | null;
}

interface ProductSpec {
  code: string;
  name: string;
  kind: ProductKind;
  category: string;
  provider: string;
  oncePerUser?: boolean;
  resellersOnly?: boolean;
  plans: PlanSpec[];
}

const PROVIDERS: { code: string; name: string; kind: ProviderKind; capacity: number | null }[] = [
  { code: 'sim-marzban', name: 'Marzban (sim)', kind: 'marzban', capacity: 500 },
  { code: 'sim-hiddify', name: 'Hiddify (sim)', kind: 'hiddify', capacity: 200 },
  // Fulfilled by hand. The one adapter that cannot fail for a network reason,
  // which makes it the right control in any provisioning test.
  { code: 'sim-manual', name: 'Manual delivery (sim)', kind: 'manual', capacity: null },
];

const CATEGORIES = ['VPN', 'Accounts'] as const;

const PRODUCTS: ProductSpec[] = [
  {
    code: 'sim-vpn-basic',
    name: 'VPN Basic',
    kind: 'vpn',
    category: 'VPN',
    provider: 'sim-marzban',
    plans: [
      { name: '1 month / 30GB', priceIrr: 1_800_000, durationDays: 30, volumeGb: 30, userLimit: 1 },
      {
        name: '3 months / 100GB',
        priceIrr: 4_900_000,
        durationDays: 90,
        volumeGb: 100,
        userLimit: 1,
      },
    ],
  },
  {
    code: 'sim-vpn-pro',
    name: 'VPN Pro',
    kind: 'vpn',
    category: 'VPN',
    provider: 'sim-hiddify',
    plans: [
      {
        name: '1 month / unmetered',
        priceIrr: 3_500_000,
        durationDays: 30,
        volumeGb: null,
        userLimit: 3,
      },
      {
        name: '6 months / unmetered',
        priceIrr: 18_000_000,
        durationDays: 180,
        volumeGb: null,
        userLimit: 3,
      },
    ],
  },
  {
    code: 'sim-vpn-trial',
    name: 'VPN Trial',
    kind: 'vpn',
    category: 'VPN',
    provider: 'sim-marzban',
    // The free row. Exercises the price=0 branch, which is the one that gets
    // forgotten until a customer finds it.
    oncePerUser: true,
    plans: [{ name: '1 day / 1GB', priceIrr: 0, durationDays: 1, volumeGb: 1, userLimit: 1 }],
  },
  {
    code: 'sim-vpn-reseller',
    name: 'VPN Reseller Pack',
    kind: 'vpn',
    category: 'VPN',
    provider: 'sim-marzban',
    resellersOnly: true,
    plans: [
      {
        name: '10 x 1 month',
        priceIrr: 15_000_000,
        durationDays: 30,
        volumeGb: 300,
        userLimit: 10,
      },
    ],
  },
  {
    code: 'sim-ai-account',
    name: 'AI Account',
    kind: 'ai_account',
    category: 'Accounts',
    provider: 'sim-manual',
    plans: [
      { name: '1 month', priceIrr: 9_000_000, durationDays: 30, volumeGb: null, userLimit: 1 },
    ],
  },
  {
    code: 'sim-spotify',
    name: 'Spotify',
    kind: 'spotify',
    category: 'Accounts',
    provider: 'sim-manual',
    plans: [
      { name: '1 month', priceIrr: 2_500_000, durationDays: 30, volumeGb: null, userLimit: 1 },
    ],
  },
];

export interface CatalogSeedResult {
  providers: number;
  categories: number;
  products: number;
  plans: number;
}

/**
 * Inserts the fixture and returns how many rows of each kind now exist for it.
 * Counts are of the fixture, not of the table, so a database that already
 * carried migrated production rows still reports the same numbers.
 */
export async function seedCatalog(db: D1Database): Promise<CatalogSeedResult> {
  const categoryIds = new Map<string, number>();
  for (const [i, name] of CATEGORIES.entries()) {
    await db
      .prepare(
        `INSERT INTO product_categories (name, sort_order) VALUES (?1, ?2)
         ON CONFLICT (name) DO NOTHING`,
      )
      .bind(name, i)
      .run();
    const row = await db
      .prepare(`SELECT id FROM product_categories WHERE name = ?1`)
      .bind(name)
      .first<{ id: number }>();
    if (!row) throw new Error(`category ${name} missing after insert`);
    categoryIds.set(name, row.id);
  }

  const providerIds = new Map<string, number>();
  for (const [i, p] of PROVIDERS.entries()) {
    await db
      .prepare(
        `INSERT INTO provisioning_providers (code, name, kind, capacity, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (code) DO NOTHING`,
      )
      .bind(p.code, p.name, p.kind, p.capacity, i)
      .run();
    const row = await db
      .prepare(`SELECT id FROM provisioning_providers WHERE code = ?1`)
      .bind(p.code)
      .first<{ id: number }>();
    if (!row) throw new Error(`provider ${p.code} missing after insert`);
    providerIds.set(p.code, row.id);
  }

  let plans = 0;
  for (const [i, prod] of PRODUCTS.entries()) {
    await db
      .prepare(
        `INSERT INTO products (code, name, kind, category_id, provider_id, once_per_user, resellers_only, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (code) DO NOTHING`,
      )
      .bind(
        prod.code,
        prod.name,
        prod.kind,
        categoryIds.get(prod.category) ?? null,
        providerIds.get(prod.provider) ?? null,
        prod.oncePerUser ?? false,
        prod.resellersOnly ?? false,
        i,
      )
      .run();
    const row = await db
      .prepare(`SELECT id FROM products WHERE code = ?1`)
      .bind(prod.code)
      .first<{ id: number }>();
    if (!row) throw new Error(`product ${prod.code} missing after insert`);

    for (const [j, plan] of prod.plans.entries()) {
      // product_plans has no natural unique key in the schema — (product_id, name)
      // is what identifies a plan to a customer, so that is what makes the
      // re-run a no-op.
      const existing = await db
        .prepare(`SELECT id FROM product_plans WHERE product_id = ?1 AND name = ?2`)
        .bind(row.id, plan.name)
        .first<{ id: number }>();
      if (!existing) {
        await db
          .prepare(
            `INSERT INTO product_plans (product_id, name, price_irr, duration_days, volume_gb, user_limit, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
          )
          .bind(
            row.id,
            plan.name,
            plan.priceIrr,
            plan.durationDays,
            plan.volumeGb,
            plan.userLimit,
            j,
          )
          .run();
      }
      plans++;
    }
  }

  return {
    providers: PROVIDERS.length,
    categories: CATEGORIES.length,
    products: PRODUCTS.length,
    plans,
  };
}
