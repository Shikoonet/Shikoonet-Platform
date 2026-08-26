/**
 * Fixtures for the shop tests.
 *
 * Everything here is looked up by natural code rather than by position. The
 * suite shares one Postgres with the migrated production catalog and with
 * whatever an earlier run left behind, so a test that says "the first panel" is
 * a test that fails for someone else's reason.
 */

import { seedCatalog } from '@shikoo/seed';
import { db } from './env.js';

export async function ensureCatalog(): Promise<void> {
  await seedCatalog(db);
  await ensurePaymentCard();
}

/** The card digits the fixture hands out. Luhn-valid, so it could be real. */
export const FIXTURE_CARD = '6037000000000095';
const FIXTURE_ACCOUNT_ID = 'sim-bot-account';

/**
 * One ACTIVE card and the account it resolves to.
 *
 * Checkout cannot draw a screen without a card, so every shop test needs this —
 * hence calling it from `ensureCatalog` rather than making each test remember.
 * Fixed ids keep it idempotent across the reruns this shared database sees.
 */
export async function ensurePaymentCard(): Promise<void> {
  await db
    .prepare(
      `INSERT INTO financial_accounts
         (id, bank_name, display_name, account_type, account_hint, card_last_four,
          active, parser_configuration, created_at, updated_at)
       VALUES (?1, 'Melli', 'حساب تست ربات', 'CARD', '0095', '0095', 1, '{}', 0, 0)
       ON CONFLICT (id) DO NOTHING`,
    )
    .bind(FIXTURE_ACCOUNT_ID)
    .run();
  await db
    .prepare(
      `INSERT INTO payment_cards
         (id, financial_account_id, card_digits, label, holder_name, status, created_at)
       VALUES ('sim-bot-card', ?1, ?2, 'کارت تست', 'تست شیکو', 'ACTIVE', 0)
       ON CONFLICT (card_digits) DO NOTHING`,
    )
    .bind(FIXTURE_ACCOUNT_ID, FIXTURE_CARD)
    .run();
}

export async function providerId(code: string): Promise<number> {
  const row = await db
    .prepare(`SELECT id FROM provisioning_providers WHERE code = ?1`)
    .bind(code)
    .first<{ id: number }>();
  if (!row) throw new Error(`fixture provider ${code} is missing`);
  return row.id;
}

/** The category a fixture product is filed under. */
export async function categoryIdOfProduct(code: string): Promise<number> {
  const row = await db
    .prepare(`SELECT category_id FROM products WHERE code = ?1`)
    .bind(code)
    .first<{ category_id: number }>();
  if (!row) throw new Error(`fixture product ${code} is missing`);
  return row.category_id;
}

export async function productId(code: string): Promise<number> {
  const row = await db
    .prepare(`SELECT id FROM products WHERE code = ?1`)
    .bind(code)
    .first<{ id: number }>();
  if (!row) throw new Error(`fixture product ${code} is missing`);
  return row.id;
}

/** The one plan of a fixture product — legacy shape, one plan per product. */
export async function planId(productCode: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT pl.id FROM product_plans pl
         JOIN products p ON p.id = pl.product_id
        WHERE p.code = ?1
        ORDER BY pl.sort_order, pl.id`,
    )
    .bind(productCode)
    .first<{ id: number }>();
  if (!row) throw new Error(`fixture product ${productCode} has no plan`);
  return row.id;
}

/** One named plan of a product that has several — the tiered shape. */
/** Every plan of one fixture product, in the shop's own default order. */
export async function planIdsIn(productCode: string): Promise<number[]> {
  const rows = await db
    .prepare(
      `SELECT pl.id FROM product_plans pl
         JOIN products p ON p.id = pl.product_id
        WHERE p.code = ?1
        ORDER BY pl.sort_order, pl.price_irr, pl.id`,
    )
    .bind(productCode)
    .all<{ id: number }>();
  return rows.results.map((r) => r.id);
}

export async function planIdIn(productCode: string, planName: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT pl.id FROM product_plans pl
         JOIN products p ON p.id = pl.product_id
        WHERE p.code = ?1 AND pl.name = ?2`,
    )
    .bind(productCode, planName)
    .first<{ id: number }>();
  if (!row) throw new Error(`fixture product ${productCode} has no plan ${planName}`);
  return row.id;
}

export interface CustomerOptions {
  reseller?: boolean;
  discountPercent?: number;
}

export async function makeCustomer(
  telegramId: number,
  options: CustomerOptions = {},
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO users (telegram_id, username, is_reseller, discount_percent, registered_at)
       VALUES (?1, ?2, ?3, ?4, now())
       ON CONFLICT (telegram_id) DO UPDATE
         SET is_reseller = EXCLUDED.is_reseller,
             discount_percent = EXCLUDED.discount_percent
       RETURNING id`,
    )
    .bind(telegramId, `shop${telegramId}`, options.reseller ?? false, options.discountPercent ?? 0)
    .first<{ id: number }>();
  if (!row) throw new Error('customer fixture failed');
  return row.id;
}

/**
 * Gives a customer something they already own, which is what ends their
 * eligibility for a first-purchase offer. `ACTIVE` rather than
 * `PENDING_PAYMENT` on purpose: the legacy rule is `invoice.Status != 'Unpaid'`.
 */
export async function giveSubscription(userId: number, publicId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, plan_name_at_sale, price_irr, status, purchased_at)
       VALUES (?1, ?2, 'shop fixture', 1000000, 'ACTIVE', now())
       ON CONFLICT (public_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
    )
    .bind(publicId, userId)
    .run();
}
