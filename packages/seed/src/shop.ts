/**
 * Deterministic shop fixture: customers, their money, their services.
 *
 * ## Why this exists
 *
 * `seed()` builds the payment hub's story and `seedCatalog()` builds something
 * to sell, and between them `users` stayed empty. That gap was invisible for
 * months because the screens that needed it did not exist yet, and then it was
 * expensive: «کاربران», «ارسال گروهی», the customer drawer and every figure on
 * the dashboard had **never been opened against data** — the bulk screen was
 * permanently disabled because its reach was zero, which looks exactly like a
 * working screen with nothing to do.
 *
 * A fixture whose only property is "some rows exist" would not have caught any
 * of that. Every row below is here because some screen or guard treats it
 * differently from its neighbour:
 *
 *   - a BLOCKED customer, so «ارسال گروهی» has someone to skip and the drawer's
 *     send button has a reason to be disabled
 *   - a customer with a standing discount, so the drawer's percent field shows a
 *     value it has to round-trip rather than always starting at zero
 *   - a reseller with a debt ceiling beside ordinary customers
 *   - a referred customer pointing at a referrer, so the graph has one edge
 *   - wallets in credit, at zero, and one in debt — the last is what
 *     `walletHeldIrr` on the dashboard is actually summing, and a fixture of
 *     only-positive balances makes a sign error invisible
 *   - orders in every status the CHECK allows that a customer can reach
 *   - subscriptions ACTIVE, expiring inside the warning window, and expired
 *
 * ## Money
 *
 * Balances are never written. `wallet_entries` is append-only and a trigger
 * derives `wallets.balance_irr` from it (0001), so this file inserts entries and
 * lets the database do the arithmetic — the same path the bot uses. Writing
 * balances directly would produce a fixture that disagrees with its own ledger,
 * which is the one bug this table's design exists to prevent.
 *
 * All amounts are integer IRR. Toman appears nowhere.
 *
 * ## Idempotency
 *
 * Every row is keyed by a natural unique column — `telegram_id`, `public_id`,
 * `idempotency_key` — and inserted `ON CONFLICT DO NOTHING`. Re-running adds
 * nothing. Unlike the catalog, nothing here converges on updates: these rows are
 * a starting position, and a suite that moves one is meant to keep its result.
 */

import type { D1Database } from '@shikoo/database';
import { rng } from './rng.js';

export interface ShopSeedResult {
  customers: number;
  walletEntries: number;
  orders: number;
  subscriptions: number;
}

/** Fixture telegram ids live in one obvious band so they cannot be mistaken for real ones. */
const TG_BASE = 900_000_000;

interface CustomerSpec {
  /** Offset from `TG_BASE`; also the fixture's stable identity. */
  n: number;
  username: string;
  status: 'ACTIVE' | 'BLOCKED';
  discountPercent?: number;
  isReseller?: boolean;
  resellerMaxDebt?: number;
  blockedReason?: string;
  /** `n` of the customer who referred this one. */
  referredBy?: number;
  /** Signed IRR entries; the trigger turns these into a balance. */
  wallet?: { amountIrr: number; kind: string; note: string }[];
}

const CUSTOMERS: readonly CustomerSpec[] = [
  {
    n: 1,
    username: 'sara_m',
    status: 'ACTIVE',
    wallet: [{ amountIrr: 5_000_000, kind: 'TOPUP', note: 'شارژ کارت‌به‌کارت' }],
  },
  {
    n: 2,
    username: 'reza_kh',
    status: 'ACTIVE',
    discountPercent: 15,
    wallet: [
      { amountIrr: 12_000_000, kind: 'TOPUP', note: 'شارژ کارت‌به‌کارت' },
      { amountIrr: -8_500_000, kind: 'PURCHASE', note: 'خرید اشتراک' },
    ],
  },
  // A reseller: sells on, and is allowed to go negative up to a ceiling. The
  // debt below is inside it on purpose — a fixture that is already over the
  // limit tests nothing except the limit.
  {
    n: 3,
    username: 'omid_reseller',
    status: 'ACTIVE',
    isReseller: true,
    resellerMaxDebt: 50_000_000,
    discountPercent: 25,
    wallet: [
      { amountIrr: 30_000_000, kind: 'TOPUP', note: 'شارژ نمایندگی' },
      { amountIrr: -41_000_000, kind: 'PURCHASE', note: 'خرید عمده' },
    ],
  },
  { n: 4, username: 'niloofar_t', status: 'ACTIVE' },
  {
    n: 5,
    username: 'blocked_user',
    status: 'BLOCKED',
    blockedReason: 'ارسال رسید جعلی',
    wallet: [{ amountIrr: 2_000_000, kind: 'TOPUP', note: 'شارژ پیش از مسدودی' }],
  },
  {
    n: 6,
    username: 'ali_referred',
    status: 'ACTIVE',
    referredBy: 1,
    wallet: [{ amountIrr: 500_000, kind: 'REFERRAL_BONUS', note: 'هدیهٔ زیرمجموعه‌گیری' }],
  },
  { n: 7, username: 'mahdi_v', status: 'ACTIVE', discountPercent: 5 },
  {
    n: 8,
    username: 'zahra_p',
    status: 'ACTIVE',
    wallet: [
      { amountIrr: 3_000_000, kind: 'TOPUP', note: 'شارژ کارت‌به‌کارت' },
      { amountIrr: -3_000_000, kind: 'PURCHASE', note: 'خرید اشتراک' },
    ],
  },
  { n: 9, username: 'hossein_d', status: 'ACTIVE' },
  {
    n: 10,
    username: 'fateme_s',
    status: 'ACTIVE',
    wallet: [{ amountIrr: 1_200_000, kind: 'ADMIN_ADJUST', note: 'جبران قطعی سرویس' }],
  },
  { n: 11, username: 'kian_r', status: 'ACTIVE' },
  { n: 12, username: 'setareh_n', status: 'ACTIVE', discountPercent: 10 },
];

/** `n` → the orders that customer placed. */
interface OrderSpec {
  customer: number;
  kind: 'NEW_PURCHASE' | 'RENEWAL' | 'WALLET_TOPUP';
  status: 'AWAITING_PAYMENT' | 'PAID' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'EXPIRED';
  unitPriceIrr: number;
  discountIrr?: number;
  /** Days before now. */
  ageDays: number;
}

const ORDERS: readonly OrderSpec[] = [
  { customer: 1, kind: 'NEW_PURCHASE', status: 'COMPLETED', unitPriceIrr: 4_500_000, ageDays: 30 },
  { customer: 2, kind: 'NEW_PURCHASE', status: 'COMPLETED', unitPriceIrr: 8_500_000, discountIrr: 1_275_000, ageDays: 21 },
  { customer: 3, kind: 'NEW_PURCHASE', status: 'COMPLETED', unitPriceIrr: 12_000_000, discountIrr: 3_000_000, ageDays: 14 },
  { customer: 4, kind: 'NEW_PURCHASE', status: 'AWAITING_PAYMENT', unitPriceIrr: 4_500_000, ageDays: 0 },
  { customer: 6, kind: 'NEW_PURCHASE', status: 'COMPLETED', unitPriceIrr: 2_500_000, ageDays: 9 },
  { customer: 7, kind: 'RENEWAL', status: 'COMPLETED', unitPriceIrr: 4_500_000, discountIrr: 225_000, ageDays: 5 },
  { customer: 8, kind: 'NEW_PURCHASE', status: 'COMPLETED', unitPriceIrr: 3_000_000, ageDays: 3 },
  { customer: 9, kind: 'NEW_PURCHASE', status: 'FAILED', unitPriceIrr: 4_500_000, ageDays: 2 },
  { customer: 10, kind: 'NEW_PURCHASE', status: 'CANCELLED', unitPriceIrr: 8_500_000, ageDays: 2 },
  { customer: 11, kind: 'NEW_PURCHASE', status: 'EXPIRED', unitPriceIrr: 4_500_000, ageDays: 1 },
  { customer: 12, kind: 'NEW_PURCHASE', status: 'PAID', unitPriceIrr: 4_500_000, ageDays: 0 },
  { customer: 1, kind: 'RENEWAL', status: 'COMPLETED', unitPriceIrr: 4_500_000, ageDays: 0 },
];

interface SubSpec {
  customer: number;
  status: 'ACTIVE' | 'DISABLED' | 'ON_HOLD';
  volumeGb: number;
  durationDays: number;
  /** Days from now; negative is already expired. */
  expiresInDays: number;
  priceIrr: number;
}

const SUBS: readonly SubSpec[] = [
  { customer: 1, status: 'ACTIVE', volumeGb: 50, durationDays: 30, expiresInDays: 18, priceIrr: 4_500_000 },
  { customer: 2, status: 'ACTIVE', volumeGb: 100, durationDays: 60, expiresInDays: 41, priceIrr: 8_500_000 },
  { customer: 3, status: 'ACTIVE', volumeGb: 200, durationDays: 90, expiresInDays: 76, priceIrr: 12_000_000 },
  // Inside the expiry warning window, which is the only reason the warning path
  // has anything to act on in a seeded database.
  { customer: 6, status: 'ACTIVE', volumeGb: 30, durationDays: 30, expiresInDays: 2, priceIrr: 2_500_000 },
  { customer: 7, status: 'ACTIVE', volumeGb: 50, durationDays: 30, expiresInDays: 25, priceIrr: 4_500_000 },
  { customer: 8, status: 'DISABLED', volumeGb: 30, durationDays: 30, expiresInDays: -4, priceIrr: 3_000_000 },
  { customer: 5, status: 'DISABLED', volumeGb: 50, durationDays: 30, expiresInDays: -20, priceIrr: 4_500_000 },
];

const DAY_MS = 86_400_000;

function iso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

export async function seedShop(db: D1Database): Promise<ShopSeedResult> {
  // Seeded, so the referral codes and public ids are the same on every machine.
  const rand = rng(0x5170_0f);

  // The catalog decides what can be sold; reading it rather than hardcoding an
  // id keeps this file working when the catalog is reshaped.
  // `provider_id` hangs off the product, not the plan — a plan is a price on a
  // product, and the product is what names the panel it is delivered from.
  const plan = await db
    .prepare(
      `SELECT pp.id, p.provider_id, pp.name
         FROM product_plans pp
         JOIN products p ON p.id = pp.product_id
        WHERE p.status = 'ACTIVE'
        ORDER BY pp.id
        LIMIT 1`,
    )
    .first<{ id: number; provider_id: number | null; name: string }>();

  const userId = new Map<number, number>();
  let customers = 0;

  for (const c of CUSTOMERS) {
    const tg = TG_BASE + c.n;
    await db
      .prepare(
        `INSERT INTO users (telegram_id, username, status, blocked_reason, is_reseller,
                            reseller_max_debt, discount_percent, referral_code, registered_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (telegram_id) DO NOTHING`,
      )
      .bind(
        tg,
        c.username,
        c.status,
        c.blockedReason ?? null,
        c.isReseller ?? false,
        c.resellerMaxDebt ?? 0,
        c.discountPercent ?? 0,
        `REF${String(1000 + Math.floor(rand() * 9000))}${c.n}`,
        iso(-(60 - c.n) * DAY_MS),
        iso(-c.n * 3600_000),
      )
      .run();

    const row = await db
      .prepare(`SELECT id FROM users WHERE telegram_id = ?1`)
      .bind(tg)
      .first<{ id: number }>();
    if (!row) throw new Error(`fixture customer ${c.n} missing after insert`);
    userId.set(c.n, row.id);
    customers += 1;
  }

  // A second pass: `referred_by` points at another fixture row, which cannot be
  // resolved until every row has an id.
  for (const c of CUSTOMERS) {
    if (c.referredBy === undefined) continue;
    const self = userId.get(c.n);
    const referrer = userId.get(c.referredBy);
    if (self === undefined || referrer === undefined) continue;
    await db
      .prepare(`UPDATE users SET referred_by = ?2 WHERE id = ?1 AND referred_by IS NULL`)
      .bind(self, referrer)
      .run();
  }

  let walletEntries = 0;
  for (const c of CUSTOMERS) {
    const uid = userId.get(c.n);
    if (uid === undefined) continue;
    for (const [i, w] of (c.wallet ?? []).entries()) {
      await db
        .prepare(
          `INSERT INTO wallet_entries (user_id, amount_irr, kind, actor, note, idempotency_key, created_at)
           VALUES (?1, ?2, ?3, 'SYSTEM', ?4, ?5, ?6)
           ON CONFLICT (idempotency_key) DO NOTHING`,
        )
        .bind(uid, w.amountIrr, w.kind, w.note, `fixture:wallet:${c.n}:${i}`, iso(-(30 - i) * DAY_MS))
        .run();
      walletEntries += 1;
    }
  }

  let orders = 0;
  for (const [i, o] of ORDERS.entries()) {
    const uid = userId.get(o.customer);
    if (uid === undefined) continue;
    const discount = o.discountIrr ?? 0;
    await db
      .prepare(
        `INSERT INTO orders (public_id, user_id, kind, plan_id, quantity, unit_price_irr,
                             discount_irr, total_irr, status, created_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (public_id) DO NOTHING`,
      )
      .bind(
        `FX-${String(i + 1).padStart(4, '0')}`,
        uid,
        o.kind,
        plan?.id ?? null,
        o.unitPriceIrr,
        discount,
        // The table has a CHECK tying these three together; computing it here
        // rather than listing it keeps a typo from becoming a constraint error
        // nobody can read.
        o.unitPriceIrr - discount,
        o.status,
        iso(-o.ageDays * DAY_MS),
        o.status === 'COMPLETED' ? iso(-o.ageDays * DAY_MS + 3600_000) : null,
      )
      .run();
    orders += 1;
  }

  let subscriptions = 0;
  for (const [i, s] of SUBS.entries()) {
    const uid = userId.get(s.customer);
    if (uid === undefined) continue;
    await db
      .prepare(
        `INSERT INTO subscriptions (public_id, user_id, plan_id, provider_id, plan_name_at_sale,
                                    price_irr, remote_username, volume_gb, duration_days, status,
                                    purchased_at, activated_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12)
         ON CONFLICT (public_id) DO NOTHING`,
      )
      .bind(
        `FXS-${String(i + 1).padStart(4, '0')}`,
        uid,
        plan?.id ?? null,
        plan?.provider_id ?? null,
        plan?.name ?? 'اشتراک آزمایشی',
        s.priceIrr,
        `fx_${s.customer}_${i + 1}`,
        s.volumeGb,
        s.durationDays,
        s.status,
        iso(-(s.durationDays - s.expiresInDays) * DAY_MS),
        iso(s.expiresInDays * DAY_MS),
      )
      .run();
    subscriptions += 1;
  }

  return { customers, walletEntries, orders, subscriptions };
}
