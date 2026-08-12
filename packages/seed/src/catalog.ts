/**
 * Deterministic catalog fixture: panels, products, plans.
 *
 * Shaped like production, not like the schema's ambitions. Three facts from the
 * 2026-08-11 dump decide the shape:
 *
 *   - `category` has ZERO rows, and `setting.statuscategory = 'offcategory'`.
 *     The category step is switched off and has no data behind it. This fixture
 *     therefore creates no categories; `products.category_id` stays NULL.
 *   - `product.Location` is the panel NAME (index.php:1507 binds
 *     `marzban_panel.name_panel` into it). The buy menu is panel → product.
 *   - A legacy `product` row IS one purchasable plan: its price, volume and
 *     duration are columns on it, and the price is spelled out in its name.
 *     So every product here has exactly one plan.
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
 * Every row that a customer must NOT see has a counterpart here that they must:
 * a disabled panel beside active ones, a hidden product beside a listed one, a
 * resellers-only product, a first-purchase-only product. A fixture with nothing
 * invisible in it cannot test invisibility.
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

interface ProviderSpec {
  code: string;
  name: string;
  kind: ProviderKind;
  capacity: number | null;
  status?: 'ACTIVE' | 'DISABLED';
}

interface ProductSpec {
  code: string;
  name: string;
  kind: ProductKind;
  /** Provider code. This is what the buy menu groups by. */
  provider: string;
  status?: 'ACTIVE' | 'HIDDEN' | 'DISABLED';
  /** Legacy one_buy_status: shown only to a customer who has never bought. */
  firstPurchaseOnly?: boolean;
  resellersOnly?: boolean;
  /** IRR. Toman only ever exists at the bot's edge. */
  priceIrr: number;
  durationDays: number | null;
  /** NULL = unmetered. */
  volumeGb: number | null;
  userLimit: number | null;
}

/**
 * Panels, which is what the customer picks first. Production has five: three
 * active, two disabled.
 */
const PROVIDERS: ProviderSpec[] = [
  { code: 'sim-vip', name: '🥇 سرویس VIP (شبیه‌سازی)', kind: 'marzban', capacity: 500 },
  { code: 'sim-gold', name: '🥈 سرویس طلایی (شبیه‌سازی)', kind: 'hiddify', capacity: 200 },
  // Fulfilled by hand. The one adapter that cannot fail for a network reason,
  // which makes it the right control in any provisioning test.
  { code: 'sim-shop', name: '📦 اکانت‌ها (شبیه‌سازی)', kind: 'manual', capacity: null },
  // Active, but everything on it is hidden — the empty panel that must not be
  // offered as a button that leads nowhere.
  { code: 'sim-empty', name: '🫙 لوکیشن بی‌محصول (شبیه‌سازی)', kind: 'manual', capacity: null },
  // Disabled, with a perfectly saleable product on it. Nothing here may ever
  // reach a customer, by either route.
  {
    code: 'sim-off',
    name: '🚫 لوکیشن غیرفعال (شبیه‌سازی)',
    kind: 'marzban',
    capacity: null,
    status: 'DISABLED',
  },
];

const PRODUCTS: ProductSpec[] = [
  {
    code: 'sim-vip-1m-20',
    name: '۱ماهه - ۲۰ گیگ - چند کاربر',
    kind: 'vpn',
    provider: 'sim-vip',
    priceIrr: 1_000_000,
    durationDays: 30,
    volumeGb: 20,
    userLimit: 3,
  },
  {
    code: 'sim-vip-1m-50',
    name: '۱ماهه - ۵۰ گیگ - چند کاربر',
    kind: 'vpn',
    provider: 'sim-vip',
    priceIrr: 1_950_000,
    durationDays: 30,
    volumeGb: 50,
    userLimit: 3,
  },
  {
    // The free row. Exercises the price=0 branch, which is the one that gets
    // forgotten until a customer finds it.
    code: 'sim-vip-trial',
    name: 'اکانت تست - ۱ روزه - ۱ گیگ',
    kind: 'vpn',
    provider: 'sim-vip',
    firstPurchaseOnly: true,
    priceIrr: 0,
    durationDays: 1,
    volumeGb: 1,
    userLimit: 1,
  },
  {
    code: 'sim-vip-hidden',
    name: '۱ماهه - ۱۰۰ گیگ - پنهان',
    kind: 'vpn',
    provider: 'sim-vip',
    status: 'HIDDEN',
    priceIrr: 5_000_000,
    durationDays: 30,
    volumeGb: 100,
    userLimit: 3,
  },
  {
    code: 'sim-vip-reseller',
    name: 'پک نمایندگی - ۱۰ کاربر',
    kind: 'vpn',
    provider: 'sim-vip',
    resellersOnly: true,
    priceIrr: 15_000_000,
    durationDays: 30,
    volumeGb: 300,
    userLimit: 10,
  },
  {
    code: 'sim-gold-10',
    name: '۱۰ گیگ - بدون محدودیت زمان',
    kind: 'vpn',
    provider: 'sim-gold',
    priceIrr: 1_000_000,
    durationDays: 365,
    volumeGb: 10,
    userLimit: null,
  },
  {
    code: 'sim-shop-spotify',
    name: 'اسپاتیفای - ۱ ماهه',
    kind: 'spotify',
    provider: 'sim-shop',
    priceIrr: 2_500_000,
    durationDays: 30,
    volumeGb: null,
    userLimit: 1,
  },
  {
    code: 'sim-shop-ai',
    name: 'اکانت هوش مصنوعی - ۱ ماهه',
    kind: 'ai_account',
    provider: 'sim-shop',
    priceIrr: 9_000_000,
    durationDays: 30,
    volumeGb: null,
    userLimit: 1,
  },
  {
    code: 'sim-empty-hidden',
    name: 'تنها محصول این لوکیشن، و پنهان',
    kind: 'manual',
    provider: 'sim-empty',
    status: 'HIDDEN',
    priceIrr: 1_000_000,
    durationDays: 30,
    volumeGb: null,
    userLimit: 1,
  },
  {
    code: 'sim-off-1m',
    name: '۱ماهه - روی لوکیشن غیرفعال',
    kind: 'vpn',
    provider: 'sim-off',
    priceIrr: 1_000_000,
    durationDays: 30,
    volumeGb: 20,
    userLimit: 1,
  },
];

export interface CatalogSeedResult {
  providers: number;
  products: number;
  plans: number;
}

/**
 * Removes fixture rows this file no longer owns.
 *
 * "Idempotent" has to mean the database converges on what is written here, not
 * merely that re-running adds nothing. Without this, a database seeded before
 * the fixture was reshaped keeps its old products forever — and they are ACTIVE,
 * so they turn up in a real customer's buy menu on the test bot.
 *
 * Scoped to the `sim-` prefix, which nothing migrated from production uses.
 * Products go first: `products.provider_id` is ON DELETE RESTRICT, so a panel
 * cannot be dropped while anything still hangs off it. Plans follow their
 * product by cascade, and any order or subscription that pointed at one keeps
 * its row with a NULL plan — which is exactly what those columns are for.
 */
async function pruneStaleFixture(db: D1Database): Promise<void> {
  const productCodes = PRODUCTS.map((p) => p.code);
  const providerCodes = PROVIDERS.map((p) => p.code);
  await db
    .prepare(`DELETE FROM products WHERE code LIKE 'sim-%' AND code <> ALL($1)`)
    .bind(productCodes)
    .run();
  await db
    .prepare(`DELETE FROM provisioning_providers WHERE code LIKE 'sim-%' AND code <> ALL($1)`)
    .bind(providerCodes)
    .run();
}

/**
 * Inserts the fixture and returns how many rows of each kind now exist for it.
 * Counts are of the fixture, not of the table, so a database that already
 * carried migrated production rows still reports the same numbers.
 */
export async function seedCatalog(db: D1Database): Promise<CatalogSeedResult> {
  await pruneStaleFixture(db);

  const providerIds = new Map<string, number>();
  for (const [i, p] of PROVIDERS.entries()) {
    await db
      .prepare(
        `INSERT INTO provisioning_providers (code, name, kind, status, capacity, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (code) DO NOTHING`,
      )
      .bind(p.code, p.name, p.kind, p.status ?? 'ACTIVE', p.capacity, i)
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
    const providerId = providerIds.get(prod.provider);
    if (providerId === undefined) throw new Error(`product ${prod.code} names no known provider`);

    await db
      .prepare(
        `INSERT INTO products (code, name, kind, provider_id, status, once_per_user, resellers_only, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (code) DO NOTHING`,
      )
      .bind(
        prod.code,
        prod.name,
        prod.kind,
        providerId,
        prod.status ?? 'ACTIVE',
        prod.firstPurchaseOnly ?? false,
        prod.resellersOnly ?? false,
        i,
      )
      .run();
    const row = await db
      .prepare(`SELECT id FROM products WHERE code = ?1`)
      .bind(prod.code)
      .first<{ id: number }>();
    if (!row) throw new Error(`product ${prod.code} missing after insert`);

    // product_plans has no natural unique key in the schema — (product_id, name)
    // is what identifies a plan to a customer, so that is what makes the
    // re-run a no-op. The plan carries the product's own name, because in the
    // legacy shape being migrated from they are the same thing.
    const existing = await db
      .prepare(`SELECT id FROM product_plans WHERE product_id = ?1 AND name = ?2`)
      .bind(row.id, prod.name)
      .first<{ id: number }>();
    if (!existing) {
      await db
        .prepare(
          `INSERT INTO product_plans (product_id, name, price_irr, duration_days, volume_gb, user_limit, sort_order)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)`,
        )
        .bind(row.id, prod.name, prod.priceIrr, prod.durationDays, prod.volumeGb, prod.userLimit)
        .run();
    }
    plans++;
  }

  return {
    providers: PROVIDERS.length,
    products: PRODUCTS.length,
    plans,
  };
}
