/**
 * سفارشات · سرویس‌ها · تراکنش‌ها — the three ledgers an admin reads, never writes.
 *
 * Every route in this file is a GET. That is the whole design: an order's
 * status is written by the purchase flow, a subscription's by provisioning and
 * the expiry sweep, and a wallet entry is append-only in Postgres. A screen
 * that could edit any of them would be a second writer racing the first, and
 * for the wallet the trigger would refuse it outright.
 *
 * The one place an admin does need to act — correcting a balance — already
 * exists on the customer's own page, where it inserts an entry rather than
 * assigning a total. This screen links to it instead of duplicating it.
 *
 * All three list queries page in SQL and join the customer, because "which
 * customer" is the first question asked of any row here and the PHP screens
 * make it a second lookup.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import type { Ident } from './adminAudit.js';

const PAGE_SIZE_MAX = 100;

/**
 * The delivery lifecycle, read off the two facts that decide it.
 *
 * Deliberately derived rather than stored. `orders.status` already *is* the
 * durable delivery status — PAID is owed, PROVISIONING is being worked on,
 * COMPLETED and FAILED are terminal — and the only thing it cannot say is
 * whether a FAILED order is worth trying again. That is the refund: `fail()`
 * returns wallet credit and leaves card-to-card money in the bank, so an order
 * with a REFUND entry has been settled with the customer and one without has
 * not. A second column holding the same answer is a second thing to keep true.
 */
export function deliveryStateOf(status: string, refunded: boolean): string {
  if (status === 'COMPLETED') return 'DELIVERED';
  if (status === 'PROVISIONING') return 'PROCESSING';
  if (status === 'PAID') return 'PENDING';
  if (status === 'FAILED') return refunded ? 'FAILED_TERMINAL' : 'FAILED_RETRYABLE';
  return status;
}

const Paging = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(25),
};

const OrderQuery = z.object({
  ...Paging,
  q: z.string().trim().max(64).optional(),
  status: z
    .enum([
      'DRAFT',
      'AWAITING_PAYMENT',
      'PAID',
      'PROVISIONING',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
      'EXPIRED',
    ])
    .optional(),
  kind: z
    .enum(['NEW_PURCHASE', 'RENEWAL', 'ADD_VOLUME', 'ADD_TIME', 'WALLET_TOPUP', 'TRANSFER'])
    .optional(),
});

const SubscriptionQuery = z.object({
  ...Paging,
  q: z.string().trim().max(64).optional(),
  status: z
    .enum(['ACTIVE', 'PENDING_PAYMENT', 'ON_HOLD', 'DISABLED', 'REMOVED', 'FAILED'])
    .optional(),
  providerId: z.coerce.number().int().positive().optional(),
});

const EntryQuery = z.object({
  ...Paging,
  q: z.string().trim().max(64).optional(),
  kind: z
    .enum([
      'OPENING',
      'TOPUP',
      'PURCHASE',
      'REFUND',
      'ADMIN_ADJUST',
      'REFERRAL_BONUS',
      'RENEWAL_CASHBACK',
      'WHEEL_PRIZE',
      'TRANSFER_IN',
      'TRANSFER_OUT',
      'GIFT_CODE',
    ])
    .optional(),
});

/**
 * Matches a customer by numeric Telegram id or by username fragment, and the
 * row by whichever identifier its own screen prints.
 *
 * `alsoLike` is that second half, and it exists because of what walking these
 * screens on 2026-08-22 turned up: سفارشات prints `FX-0012` in its first column
 * and refused to find it, and سرویس‌ها prints the panel account name and
 * refused that too. Both are the identifier support actually starts from — a
 * customer quotes an order number, and a panel shows an account name and
 * nothing else about who owns it. A screen that displays an identifier it will
 * not accept sends the admin to the database.
 *
 * Every column here shares one `?n`: the same fragment is tried against each,
 * which is what makes one box answer «who is this» from any of the names the
 * row carries.
 *
 * Pushed into `params` so the caller keeps a contiguous parameter sequence —
 * the Postgres adapter closes gaps but cannot invent a value for a hole.
 */
function customerFilter(
  q: string,
  params: unknown[],
  alsoLike: readonly string[] = [],
  alias = 'u',
): string {
  const handle = q.replace(/^@/, '');
  params.push(`%${handle}%`);
  const nameParam = params.length;
  const clauses = [
    `${alias}.username ILIKE ?${nameParam}`,
    ...alsoLike.map((col) => `${col} ILIKE ?${nameParam}`),
  ];
  if (/^[0-9]{1,19}$/.test(handle)) {
    params.push(handle);
    clauses.push(`${alias}.telegram_id = ?${params.length}`);
  }
  return `(${clauses.join(' OR ')})`;
}

export function registerSalesRoutes(
  app: Hono<{ Bindings: { DB: D1Database }; Variables: { identity: Ident } }>,
) {
  // --- سفارشات -------------------------------------------------------------

  app.get('/api/v1/admin/orders', async (c) => {
    const parsed = OrderQuery.safeParse({
      q: c.req.query('q') || undefined,
      status: c.req.query('status') || undefined,
      kind: c.req.query('kind') || undefined,
      page: c.req.query('page') ?? undefined,
      pageSize: c.req.query('pageSize') ?? undefined,
    });
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    const { q, status, kind, page, pageSize } = parsed.data;

    const where: string[] = [];
    const params: unknown[] = [];
    if (status) {
      params.push(status);
      where.push(`o.status = ?${params.length}`);
    }
    if (kind) {
      params.push(kind);
      where.push(`o.kind = ?${params.length}`);
    }
    // The order number is on the screen and in the customer's own invoice, so
    // it is the first thing typed into this box when somebody asks about one.
    if (q) where.push(customerFilter(q, params, ['o.public_id']));
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const from = `FROM orders o JOIN users u ON u.id = o.user_id`;
    const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS n ${from} ${whereSql}`)
      .bind(...params)
      .first<{ n: number }>();

    params.push(pageSize);
    const limitParam = params.length;
    params.push((page - 1) * pageSize);
    const rows = await c.env.DB.prepare(
      `SELECT o.id, o.public_id, o.kind, o.status, o.quantity,
              o.unit_price_irr, o.discount_irr, o.total_irr,
              o.failure_reason, o.created_at, o.completed_at,
              -- Whether a retry may still serve this customer. A refunded
              -- order is terminal: the money is back, so delivering now
              -- would be giving the service away.
              EXISTS (SELECT 1 FROM wallet_entries w
                       WHERE w.order_id = o.id AND w.kind = 'REFUND') AS refunded,
              u.id AS user_id, u.telegram_id, u.username,
              COALESCE(pl.name, s.plan_name_at_sale) AS plan_name
         ${from}
         LEFT JOIN product_plans pl ON pl.id = o.plan_id
         -- Joined for the name only, and safe to join at all because
         -- idx_subscriptions_one_per_order is UNIQUE on order_id: the schema,
         -- not this query, is what stops a row multiplying. Kept outside the
         -- shared FROM so the COUNT above still counts orders.
         LEFT JOIN subscriptions s ON s.order_id = o.id
         ${whereSql}
        ORDER BY o.id DESC
        LIMIT ?${limitParam} OFFSET ?${params.length}`,
    )
      .bind(...params)
      .all<{
        id: number;
        public_id: string;
        kind: string;
        status: string;
        quantity: number;
        unit_price_irr: number;
        discount_irr: number;
        total_irr: number;
        failure_reason: string | null;
        refunded: boolean;
        created_at: string;
        completed_at: string | null;
        user_id: number;
        telegram_id: number;
        username: string | null;
        plan_name: string | null;
      }>();

    return c.json({
      ok: true,
      total: totalRow?.n ?? 0,
      page,
      pageSize,
      items: (rows.results ?? []).map((r) => ({
        id: r.id,
        publicId: r.public_id,
        kind: r.kind,
        status: r.status,
        quantity: r.quantity,
        unitPriceIrr: Number(r.unit_price_irr),
        discountIrr: Number(r.discount_irr),
        totalIrr: Number(r.total_irr),
        failureReason: r.failure_reason,
        // The delivery half of the order, named separately from `status`
        // because the payment half is already decided and must not be
        // re-read from it. FAILED_RETRYABLE is the only one that offers the
        // operator a button; FAILED_TERMINAL says why there is none.
        deliveryState: deliveryStateOf(r.status, r.refunded),
        createdAt: r.created_at,
        completedAt: r.completed_at,
        customer: { id: r.user_id, telegramId: r.telegram_id, username: r.username },
        // Two sources, in this order, because `plan_id` answers for one
        // kind of order and not the other:
        //
        //   * `product_plans.name` — today's catalogue, for an order the
        //     shop itself took. NULL once a plan is retired, since
        //     `orders.plan_id` is ON DELETE SET NULL.
        //   * `subscriptions.plan_name_at_sale` — the name the customer
        //     actually bought under. This is the only one an imported
        //     order has: legacy plan names are free text with the price
        //     inside them, so the migration deliberately maps none of them
        //     to a catalogue row and `plan_id` stays NULL on all 8,909.
        //
        // Still NULL for a renewal or add-on, which is right: `service_other`
        // carries no product name in the legacy database either, and the
        // «نوع» column already says what those orders are.
        planName: r.plan_name,
      })),
    });
  });

  // --- سرویس‌ها ------------------------------------------------------------

  app.get('/api/v1/admin/subscriptions', async (c) => {
    const parsed = SubscriptionQuery.safeParse({
      q: c.req.query('q') || undefined,
      status: c.req.query('status') || undefined,
      providerId: c.req.query('providerId') || undefined,
      page: c.req.query('page') ?? undefined,
      pageSize: c.req.query('pageSize') ?? undefined,
    });
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    const { q, status, providerId, page, pageSize } = parsed.data;

    const where: string[] = [];
    const params: unknown[] = [];
    if (status) {
      params.push(status);
      where.push(`s.status = ?${params.length}`);
    }
    if (providerId) {
      params.push(providerId);
      where.push(`s.provider_id = ?${params.length}`);
    }
    // The panel account name, because the panel is where this lookup starts:
    // an admin sees an account misbehaving or expiring on PasarGuard and holds
    // no other identifier for it. Without this, the column is a dead end.
    if (q) where.push(customerFilter(q, params, ['s.remote_username']));
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const from = `FROM subscriptions s JOIN users u ON u.id = s.user_id`;
    const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS n ${from} ${whereSql}`)
      .bind(...params)
      .first<{ n: number }>();

    params.push(pageSize);
    const limitParam = params.length;
    params.push((page - 1) * pageSize);
    const rows = await c.env.DB.prepare(
      `SELECT s.id, s.public_id, s.status, s.plan_name_at_sale, s.provider_name_at_sale,
              s.price_irr, s.volume_gb, s.duration_days, s.remote_username,
              s.purchased_at, s.expires_at, s.last_synced_at, s.used_bytes,
              u.id AS user_id, u.telegram_id, u.username
         ${from}
         ${whereSql}
        ORDER BY s.id DESC
        LIMIT ?${limitParam} OFFSET ?${params.length}`,
    )
      .bind(...params)
      .all<{
        id: number;
        public_id: string;
        status: string;
        plan_name_at_sale: string;
        provider_name_at_sale: string | null;
        price_irr: number;
        volume_gb: number | null;
        duration_days: number | null;
        remote_username: string | null;
        purchased_at: string;
        expires_at: string | null;
        last_synced_at: string | null;
        used_bytes: number | null;
        user_id: number;
        telegram_id: number;
        username: string | null;
      }>();

    return c.json({
      ok: true,
      total: totalRow?.n ?? 0,
      page,
      pageSize,
      items: (rows.results ?? []).map((r) => ({
        id: r.id,
        publicId: r.public_id,
        status: r.status,
        // The names as they were at the moment of sale, not as they are now:
        // renaming a plan must not rewrite what a customer bought.
        planName: r.plan_name_at_sale,
        providerName: r.provider_name_at_sale,
        priceIrr: Number(r.price_irr),
        volumeGb: r.volume_gb === null ? null : Number(r.volume_gb),
        durationDays: r.duration_days,
        remoteUsername: r.remote_username,
        purchasedAt: r.purchased_at,
        expiresAt: r.expires_at,
        lastSyncedAt: r.last_synced_at,
        // What the panel says has been consumed, as of `lastSyncedAt`. The
        // bot's sweep writes both (`apps/bot/src/sync.ts`); this route
        // shipped the timestamp and not the number it timestamps, so the
        // screen could say how fresh a figure was but never show it.
        usedBytes: r.used_bytes === null ? null : Number(r.used_bytes),
        customer: { id: r.user_id, telegramId: r.telegram_id, username: r.username },
      })),
    });
  });

  // --- تراکنش‌ها -----------------------------------------------------------

  app.get('/api/v1/admin/wallet-entries', async (c) => {
    const parsed = EntryQuery.safeParse({
      q: c.req.query('q') || undefined,
      kind: c.req.query('kind') || undefined,
      page: c.req.query('page') ?? undefined,
      pageSize: c.req.query('pageSize') ?? undefined,
    });
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    const { q, kind, page, pageSize } = parsed.data;

    const where: string[] = [];
    const params: unknown[] = [];
    if (kind) {
      params.push(kind);
      where.push(`e.kind = ?${params.length}`);
    }
    if (q) where.push(customerFilter(q, params));
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const from = `FROM wallet_entries e JOIN users u ON u.id = e.user_id`;
    const totals = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(e.amount_irr) FILTER (WHERE e.amount_irr > 0), 0) AS credit,
              COALESCE(SUM(e.amount_irr) FILTER (WHERE e.amount_irr < 0), 0) AS debit
         ${from} ${whereSql}`,
    )
      .bind(...params)
      .first<{ n: number; credit: number; debit: number }>();

    params.push(pageSize);
    const limitParam = params.length;
    params.push((page - 1) * pageSize);
    const rows = await c.env.DB.prepare(
      `SELECT e.id, e.amount_irr, e.kind, e.actor, e.note, e.created_at,
              e.order_id, e.payment_id,
              u.id AS user_id, u.telegram_id, u.username
         ${from}
         ${whereSql}
        ORDER BY e.id DESC
        LIMIT ?${limitParam} OFFSET ?${params.length}`,
    )
      .bind(...params)
      .all<{
        id: number;
        amount_irr: number;
        kind: string;
        actor: string | null;
        note: string | null;
        created_at: string;
        order_id: number | null;
        payment_id: number | null;
        user_id: number;
        telegram_id: number;
        username: string | null;
      }>();

    return c.json({
      ok: true,
      total: totals?.n ?? 0,
      page,
      pageSize,
      // Summed over everything the filter matches, not over the page — a page
      // total would read as the shop's figure and be wrong by a factor of the
      // page count.
      creditIrr: Number(totals?.credit ?? 0),
      debitIrr: Number(totals?.debit ?? 0),
      items: (rows.results ?? []).map((r) => ({
        id: r.id,
        amountIrr: Number(r.amount_irr),
        kind: r.kind,
        actor: r.actor,
        note: r.note,
        createdAt: r.created_at,
        orderId: r.order_id,
        paymentId: r.payment_id,
        customer: { id: r.user_id, telegramId: r.telegram_id, username: r.username },
      })),
    });
  });
}
