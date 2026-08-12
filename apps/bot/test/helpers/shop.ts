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
}

export async function providerId(code: string): Promise<number> {
  const row = await db
    .prepare(`SELECT id FROM provisioning_providers WHERE code = ?1`)
    .bind(code)
    .first<{ id: number }>();
  if (!row) throw new Error(`fixture provider ${code} is missing`);
  return row.id;
}

/** The one plan of a fixture product — legacy shape, one plan per product. */
export async function planId(productCode: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT pl.id FROM product_plans pl
         JOIN products p ON p.id = pl.product_id
        WHERE p.code = ?1`,
    )
    .bind(productCode)
    .first<{ id: number }>();
  if (!row) throw new Error(`fixture product ${productCode} has no plan`);
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
