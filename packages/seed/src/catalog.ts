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
  | 'pasarguard'
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

interface PlanSpec {
  name: string;
  /** IRR. Toman only ever exists at the bot's edge. */
  priceIrr: number;
  durationDays: number | null;
  /** NULL = unmetered. */
  volumeGb: number | null;
  userLimit: number | null;
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
  /**
   * The groups on the panel an account bought here joins — the tier.
   *
   * Left out by every migrated-shaped row on purpose: those inherit the panel's
   * default, which is the only thing that existed before a product could carry
   * its own.
   */
  groupIds?: number[];
  /**
   * What is actually for sale, cheapest first.
   *
   * A legacy `product` row IS one plan, so most of these hold exactly one and
   * its name is the product's. `sim-vip-platinum` holds three, which is the
   * shape the shop grew: one service, several sizes inside it.
   */
  plans: PlanSpec[];
}

/**
 * Panels, which is what the customer picks first. Production has five: three
 * active, two disabled.
 */
const PROVIDERS: ProviderSpec[] = [
  { code: 'sim-vip', name: '🥇 سرویس VIP (شبیه‌سازی)', kind: 'pasarguard', capacity: 500 },
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
    kind: 'pasarguard',
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
    plans: [
      { name: '۱ماهه - ۲۰ گیگ - چند کاربر', priceIrr: 1_000_000, durationDays: 30, volumeGb: 20, userLimit: 3 },
    ],
  },
  {
    code: 'sim-vip-1m-50',
    name: '۱ماهه - ۵۰ گیگ - چند کاربر',
    kind: 'vpn',
    provider: 'sim-vip',
    plans: [
      { name: '۱ماهه - ۵۰ گیگ - چند کاربر', priceIrr: 1_950_000, durationDays: 30, volumeGb: 50, userLimit: 3 },
    ],
  },
  {
    // The free row. Exercises the price=0 branch, which is the one that gets
    // forgotten until a customer finds it.
    code: 'sim-vip-trial',
    name: 'اکانت تست - ۱ روزه - ۱ گیگ',
    kind: 'vpn',
    provider: 'sim-vip',
    firstPurchaseOnly: true,
    plans: [
      { name: 'اکانت تست - ۱ روزه - ۱ گیگ', priceIrr: 0, durationDays: 1, volumeGb: 1, userLimit: 1 },
    ],
  },
  {
    code: 'sim-vip-hidden',
    name: '۱ماهه - ۱۰۰ گیگ - پنهان',
    kind: 'vpn',
    provider: 'sim-vip',
    status: 'HIDDEN',
    plans: [
      { name: '۱ماهه - ۱۰۰ گیگ - پنهان', priceIrr: 5_000_000, durationDays: 30, volumeGb: 100, userLimit: 3 },
    ],
  },
  {
    code: 'sim-vip-reseller',
    name: 'پک نمایندگی - ۱۰ کاربر',
    kind: 'vpn',
    provider: 'sim-vip',
    resellersOnly: true,
    plans: [
      { name: 'پک نمایندگی - ۱۰ کاربر', priceIrr: 15_000_000, durationDays: 30, volumeGb: 300, userLimit: 10 },
    ],
  },
  {
    // The shape the shop grew into: one SERVICE holding three sizes, delivered
    // into its own groups on the panel.
    //
    // Every other row here is the legacy shape — one product, one plan, the
    // price typed into the name — and a fixture made only of those cannot test
    // the level between a panel and a plan at all. It was missing in exactly
    // that way: the shop drew plans straight off a panel, every button carried
    // its PRODUCT's name, and `group_ids` existed only on the panel, so one
    // panel could sell exactly one tier however many groups it had.
    code: 'sim-vip-platinum',
    name: 'پلاتینیوم',
    kind: 'vpn',
    provider: 'sim-vip',
    groupIds: [6, 7],
    plans: [
      { name: '۳۰ گیگ - یک‌ماهه', priceIrr: 1_500_000, durationDays: 30, volumeGb: 30, userLimit: 2 },
      { name: '۵۰ گیگ - یک‌ماهه', priceIrr: 2_200_000, durationDays: 30, volumeGb: 50, userLimit: 2 },
      { name: '۱۰۰ گیگ - سه‌ماهه', priceIrr: 5_400_000, durationDays: 90, volumeGb: 100, userLimit: 3 },
    ],
  },
  {
    code: 'sim-gold-10',
    name: '۱۰ گیگ - بدون محدودیت زمان',
    kind: 'vpn',
    provider: 'sim-gold',
    plans: [
      { name: '۱۰ گیگ - بدون محدودیت زمان', priceIrr: 1_000_000, durationDays: 365, volumeGb: 10, userLimit: null },
    ],
  },
  {
    code: 'sim-shop-spotify',
    name: 'اسپاتیفای - ۱ ماهه',
    kind: 'spotify',
    provider: 'sim-shop',
    plans: [
      { name: 'اسپاتیفای - ۱ ماهه', priceIrr: 2_500_000, durationDays: 30, volumeGb: null, userLimit: 1 },
    ],
  },
  {
    code: 'sim-shop-ai',
    name: 'اکانت هوش مصنوعی - ۱ ماهه',
    kind: 'ai_account',
    provider: 'sim-shop',
    plans: [
      { name: 'اکانت هوش مصنوعی - ۱ ماهه', priceIrr: 9_000_000, durationDays: 30, volumeGb: null, userLimit: 1 },
    ],
  },
  {
    code: 'sim-empty-hidden',
    name: 'تنها محصول این لوکیشن، و پنهان',
    kind: 'manual',
    provider: 'sim-empty',
    status: 'HIDDEN',
    plans: [
      { name: 'تنها محصول این لوکیشن، و پنهان', priceIrr: 1_000_000, durationDays: 30, volumeGb: null, userLimit: 1 },
    ],
  },
  {
    code: 'sim-off-1m',
    name: '۱ماهه - روی لوکیشن غیرفعال',
    kind: 'vpn',
    provider: 'sim-off',
    plans: [
      { name: '۱ماهه - روی لوکیشن غیرفعال', priceIrr: 1_000_000, durationDays: 30, volumeGb: 20, userLimit: 1 },
    ],
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
        // DO UPDATE, not DO NOTHING. This file promises the database converges
        // on what is written here, and DO NOTHING only promises re-running adds
        // nothing. The difference bit: when `sim-vip` moved from kind 'marzban'
        // to 'pasarguard', every already-seeded database kept the old value —
        // and 'marzban' has no adapter, so the panel silently became a manual
        // one. Nothing would have said so.
        `INSERT INTO provisioning_providers (code, name, kind, status, capacity, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name, kind = EXCLUDED.kind, status = EXCLUDED.status,
           capacity = EXCLUDED.capacity, sort_order = EXCLUDED.sort_order`,
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
        `INSERT INTO products (code, name, kind, provider_id, status, once_per_user, resellers_only, sort_order, attrs)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                 CASE WHEN ?9::jsonb IS NULL THEN '{}'::jsonb
                      ELSE jsonb_build_object('group_ids', ?9::jsonb) END)
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name, kind = EXCLUDED.kind, provider_id = EXCLUDED.provider_id,
           status = EXCLUDED.status, once_per_user = EXCLUDED.once_per_user,
           resellers_only = EXCLUDED.resellers_only, sort_order = EXCLUDED.sort_order,
           attrs = EXCLUDED.attrs`,
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
        prod.groupIds === undefined ? null : JSON.stringify(prod.groupIds),
      )
      .run();
    const row = await db
      .prepare(`SELECT id FROM products WHERE code = ?1`)
      .bind(prod.code)
      .first<{ id: number }>();
    if (!row) throw new Error(`product ${prod.code} missing after insert`);

    // product_plans has no natural unique key in the schema — (product_id, name)
    // is what identifies a plan to a customer, so that is what makes the
    // re-run a no-op. For a legacy-shaped row the one plan carries the
    // product's own name, because there they are the same thing.
    //
    // Plans this file no longer lists are removed, for the same reason
    // `pruneStaleFixture` exists one level up: a database seeded before a
    // service was reshaped otherwise keeps selling the old sizes, ACTIVE, in a
    // real customer's shop on the test bot.
    await db
      .prepare(
        `DELETE FROM product_plans WHERE product_id = ?1 AND name <> ALL($2)`,
      )
      .bind(
        row.id,
        prod.plans.map((pl) => pl.name),
      )
      .run();
    for (const [j, pl] of prod.plans.entries()) {
      const existing = await db
        .prepare(`SELECT id FROM product_plans WHERE product_id = ?1 AND name = ?2`)
        .bind(row.id, pl.name)
        .first<{ id: number }>();
      if (existing) {
        await db
          .prepare(
            `UPDATE product_plans
                SET price_irr = ?3, duration_days = ?4, volume_gb = ?5, user_limit = ?6,
                    sort_order = ?7, status = 'ACTIVE', updated_at = now()
              WHERE id = ?1 AND product_id = ?2`,
          )
          .bind(existing.id, row.id, pl.priceIrr, pl.durationDays, pl.volumeGb, pl.userLimit, j)
          .run();
      } else {
        await db
          .prepare(
            `INSERT INTO product_plans (product_id, name, price_irr, duration_days, volume_gb, user_limit, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
          )
          .bind(row.id, pl.name, pl.priceIrr, pl.durationDays, pl.volumeGb, pl.userLimit, j)
          .run();
      }
      plans++;
    }
  }

  await seedContent(db);

  return {
    providers: PROVIDERS.length,
    products: PRODUCTS.length,
    plans,
  };
}

/**
 * The settings and content the menu's quieter corners read.
 *
 * Without these three the support, education and referral screens all render
 * their "not set up yet" branch in the simulation, and a screen that can only
 * be seen empty is a screen nobody has looked at. The values are shaped like
 * production's — `onpvsupport` with a handle, four articles, a few apps — but
 * the handle is a fixture, not the real admin's.
 */
const HELP_ARTICLES = [
  {
    title: 'اتصال در اندروید',
    body: 'برنامه v2rayNG را نصب کنید، لینک اشتراک را از «سرویس‌های من» کپی کنید و در برنامه Import کنید.',
  },
  {
    title: 'اتصال در آیفون',
    body: 'برنامه Streisand را نصب کنید و لینک اشتراک را در آن وارد کنید.',
  },
  {
    title: 'سرویس وصل نمی‌شود',
    body: 'اول از «سرویس‌های من» ببینید حجم یا زمان تمام نشده باشد. اگر باقی است، لینک اشتراک را یک بار به‌روزرسانی کنید.',
  },
];

const CLIENT_APPS = [
  { name: 'v2rayNG', platform: 'Android', link: 'https://github.com/2dust/v2rayNG/releases' },
  { name: 'Streisand', platform: 'iOS', link: 'https://apps.apple.com/app/streisand/id6450534064' },
  { name: 'v2rayN', platform: 'Windows', link: 'https://github.com/2dust/v2rayN/releases' },
];

async function seedContent(db: D1Database): Promise<void> {
  for (const [scope, key, value] of [
    ['bot', 'statussupportpv', 'onpvsupport'],
    ['bot', 'id_support', 'shikoo_sim_support'],
    ['bot', 'username', 'Test_Shikoo_bot'],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO settings (scope, key, value, updated_at, updated_by)
         VALUES (?1, ?2, to_jsonb(?3::text), now(), 'seed')
         ON CONFLICT (scope, key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = now(), updated_by = 'seed'`,
      )
      .bind(scope, key, value)
      .run();
  }

  // Neither table has a natural key in the schema, so the title and the name
  // are what make a re-run a no-op rather than a fourth copy of every article.
  for (const [i, article] of HELP_ARTICLES.entries()) {
    const existing = await db
      .prepare(`SELECT id FROM help_articles WHERE title = ?1`)
      .bind(article.title)
      .first<{ id: number }>();
    if (existing) continue;
    await db
      .prepare(
        `INSERT INTO help_articles (title, body, category, sort_order, active)
         VALUES (?1, ?2, 'آموزش', ?3, true)`,
      )
      .bind(article.title, article.body, i)
      .run();
  }

  for (const [i, app] of CLIENT_APPS.entries()) {
    const existing = await db
      .prepare(`SELECT id FROM client_apps WHERE name = ?1`)
      .bind(app.name)
      .first<{ id: number }>();
    if (existing) continue;
    await db
      .prepare(
        `INSERT INTO client_apps (name, platform, link, sort_order, active)
         VALUES (?1, ?2, ?3, ?4, true)`,
      )
      .bind(app.name, app.platform, app.link, i)
      .run();
  }
}
