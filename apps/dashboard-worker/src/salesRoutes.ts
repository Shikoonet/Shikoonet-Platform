import type { EnvName } from '@shikoo/contracts';
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
import { tehranDayBoundsFromDate } from '@shikoo/domain';
import { csvCell, IRR_PER_TOMAN } from './revenueRoutes.js';

const PAGE_SIZE_MAX = 100;

/** A calendar day the operator typed, not an instant. */
const ISO_DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/**
 * The window a date filter means, in Tehran.
 *
 * `from` is the start of that day and `to` is the start of the day AFTER it,
 * because `tehranDayBoundsFromDate(...).end` is `start + DAY_MS` — the first
 * instant that is NOT in the day. So the SQL compares `< endMs`, and «۱۵ تا ۱۵
 * شهریور» is one whole day rather than an empty range. Reading that `end` as
 * inclusive is the mistake `mirzabotRoutes.ts` records paying for with a
 * `- 1`; comparing with `<` says the same thing without the magic number.
 * Epoch milliseconds against `to_timestamp(?/1000.0)`, so the column stays a
 * timestamp and its index stays usable.
 */
function dayWindow(from: string | undefined, to: string | undefined) {
  return {
    startMs: from === undefined ? null : tehranDayBoundsFromDate(from).start,
    endMs: to === undefined ? null : tehranDayBoundsFromDate(to).end,
  };
}

/**
 * The columns each ledger will order by, and nothing else.
 *
 * A whitelist rather than an escape, because the value lands inside `ORDER BY`
 * where no parameter can go. `?sort=total_irr;DROP` is a 400 before it reaches
 * SQL — zod refuses the enum — so the map below is only ever indexed by a
 * string this file wrote.
 *
 * Every entry ends `, <table>.id DESC`. Ordering by a non-unique column alone
 * leaves ties in whatever order the plan happens to produce, and with LIMIT/
 * OFFSET on top that means a row can appear on two pages or on none.
 */
const ORDER_BY = {
  orders: {
    id: 'o.id',
    created_at: 'o.created_at',
    total_irr: 'o.total_irr',
    status: 'o.status',
  },
  subscriptions: {
    id: 's.id',
    purchased_at: 's.purchased_at',
    expires_at: 's.expires_at',
    price_irr: 's.price_irr',
    status: 's.status',
  },
  entries: {
    id: 'e.id',
    created_at: 'e.created_at',
    amount_irr: 'e.amount_irr',
  },
} as const;

function orderClause(
  table: keyof typeof ORDER_BY,
  sort: string | undefined,
  dir: 'asc' | 'desc',
  tie: string,
): string {
  const map = ORDER_BY[table] as Record<string, string>;
  const col = sort === undefined ? undefined : map[sort];
  if (col === undefined) return `ORDER BY ${tie} DESC`;
  return `ORDER BY ${col} ${dir === 'asc' ? 'ASC' : 'DESC'}, ${tie} DESC`;
}

/**
 * One request, one file.
 *
 * Above this the answer is truncated rather than wrong, and the same number
 * `/api/v1/payments` uses — an export that silently stops at a different row
 * count from the one beside it is worse than either.
 */
const EXPORT_MAX = 5000;

/**
 * A CSV body, with the two things a spreadsheet needs to read Persian.
 *
 * The BOM, or Excel opens UTF-8 as its own legacy code page and every column
 * is mojibake. CRLF, because that is what Excel writes and therefore what it
 * round-trips without adding a blank line.
 */
function csvBody(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  return `﻿${lines.join('\r\n')}\r\n`;
}

const CSV_HEADERS = { 'content-type': 'text/csv; charset=utf-8' } as const;

/**
 * Whether this operator may take a file away.
 *
 * ADMIN only, and that IS stricter than the screen — the same line
 * `mirzabotRoutes.ts` draws for `/payments`. Reading a page and carrying off
 * every customer's Telegram id are different acts, and the second one leaves
 * the building.
 */
function mayExport(ident: Ident): boolean {
  return ident.role === 'ADMIN';
}

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
  // The internal user id, not the telegram id: this is what a link out of a
  // row carries, and it has to mean exactly one customer. `q` cannot serve —
  // it is a fragment match by design, so it answers «who might this be» and
  // not «this one».
  customerId: z.coerce.number().int().positive().optional(),
  // A calendar day in Tehran, inclusive at both ends. Named `...Day` because
  // that is what they are — `from`/`to` on the wire, since that is what the
  // screen's two date fields are called.
  fromDay: ISO_DAY.optional(),
  toDay: ISO_DAY.optional(),
  dir: z.enum(['asc', 'desc']).default('desc'),
  format: z.enum(['csv']).optional(),
  sort: z.enum(['id', 'created_at', 'total_irr', 'status']).optional(),
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
  customerId: z.coerce.number().int().positive().optional(),
  // A calendar day in Tehran, inclusive at both ends. Named `...Day` because
  // that is what they are — `from`/`to` on the wire, since that is what the
  // screen's two date fields are called.
  fromDay: ISO_DAY.optional(),
  toDay: ISO_DAY.optional(),
  dir: z.enum(['asc', 'desc']).default('desc'),
  format: z.enum(['csv']).optional(),
  sort: z.enum(['id', 'purchased_at', 'expires_at', 'price_irr', 'status']).optional(),
  status: z
    .enum(['ACTIVE', 'PENDING_PAYMENT', 'ON_HOLD', 'DISABLED', 'REMOVED', 'FAILED'])
    .optional(),
  providerId: z.coerce.number().int().positive().optional(),
});

const EntryQuery = z.object({
  ...Paging,
  q: z.string().trim().max(64).optional(),
  customerId: z.coerce.number().int().positive().optional(),
  // A calendar day in Tehran, inclusive at both ends. Named `...Day` because
  // that is what they are — `from`/`to` on the wire, since that is what the
  // screen's two date fields are called.
  fromDay: ISO_DAY.optional(),
  toDay: ISO_DAY.optional(),
  dir: z.enum(['asc', 'desc']).default('desc'),
  format: z.enum(['csv']).optional(),
  sort: z.enum(['id', 'created_at', 'amount_irr']).optional(),
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
  app: Hono<{ Bindings: { DB: D1Database; ENV_NAME: EnvName }; Variables: { identity: Ident } }>,
) {
  // --- سفارشات -------------------------------------------------------------

  app.get('/api/v1/admin/orders', async (c) => {
    const parsed = OrderQuery.safeParse({
      q: c.req.query('q') || undefined,
      customerId: c.req.query('customerId') || undefined,
      fromDay: c.req.query('from') || undefined,
      toDay: c.req.query('to') || undefined,
      sort: c.req.query('sort') || undefined,
      dir: c.req.query('dir') ?? undefined,
      format: c.req.query('format') || undefined,
      status: c.req.query('status') || undefined,
      kind: c.req.query('kind') || undefined,
      page: c.req.query('page') ?? undefined,
      pageSize: c.req.query('pageSize') ?? undefined,
    });
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    const { q, customerId, status, kind, page, pageSize, fromDay, toDay, sort, dir, format } =
      parsed.data;

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
    if (customerId) {
      params.push(customerId);
      where.push(`o.user_id = ?${params.length}`);
    }
    const { startMs, endMs } = dayWindow(fromDay, toDay);
    if (startMs !== null) {
      params.push(startMs);
      where.push(`o.created_at >= to_timestamp(?${params.length} / 1000.0)`);
    }
    if (endMs !== null) {
      params.push(endMs);
      where.push(`o.created_at < to_timestamp(?${params.length} / 1000.0)`);
    }
    // The order number is on the screen and in the customer's own invoice, so
    // it is the first thing typed into this box when somebody asks about one.
    if (q) where.push(customerFilter(q, params, ['o.public_id']));
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const from = `FROM orders o JOIN users u ON u.id = o.user_id`;

    /*
     * `?format=csv` on the same GET, rather than a route beside it.
     *
     * A sibling route means a second copy of every filter above, and an export
     * that answers a different question from the screen it was taken from is
     * worse than no export at all. Here it cannot drift: same handler, same
     * WHERE, one branch at the end.
     */
    if (format === 'csv') {
      if (!mayExport(c.get('identity'))) return c.json({ ok: false, error: 'forbidden' }, 403);
      params.push(EXPORT_MAX);
      const { results } = await c.env.DB.prepare(
        `SELECT o.public_id, o.kind, o.status, o.quantity, o.total_irr, o.created_at,
                u.telegram_id, u.username,
                COALESCE(pl.name, sub.plan_name_at_sale) AS plan_name
           ${from}
           LEFT JOIN product_plans pl ON pl.id = o.plan_id
           LEFT JOIN subscriptions sub ON sub.order_id = o.id
           ${whereSql}
          ${orderClause('orders', sort, dir, 'o.id')}
          LIMIT ?${params.length}`,
      )
        .bind(...params)
        .all<Record<string, unknown>>();
      return c.body(
        csvBody(
          ['شمارهٔ سفارش', 'کاربر', 'آیدی تلگرام', 'نوع', 'وضعیت', 'چه چیزی', 'تعداد', 'مبلغ (تومان)', 'زمان'],
          (results ?? []).map((r) => [
            r['public_id'],
            r['username'] === null ? '' : `@${String(r['username'])}`,
            r['telegram_id'],
            r['kind'],
            r['status'],
            r['plan_name'] ?? '',
            r['quantity'],
            Number(r['total_irr']) / IRR_PER_TOMAN,
            r['created_at'],
          ]),
        ),
        200,
        CSV_HEADERS,
      );
    }
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
        ${orderClause('orders', sort, dir, 'o.id')}
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
      customerId: c.req.query('customerId') || undefined,
      fromDay: c.req.query('from') || undefined,
      toDay: c.req.query('to') || undefined,
      sort: c.req.query('sort') || undefined,
      dir: c.req.query('dir') ?? undefined,
      format: c.req.query('format') || undefined,
      status: c.req.query('status') || undefined,
      providerId: c.req.query('providerId') || undefined,
      page: c.req.query('page') ?? undefined,
      pageSize: c.req.query('pageSize') ?? undefined,
    });
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    const { q, customerId, status, providerId, page, pageSize, fromDay, toDay, sort, dir, format } =
      parsed.data;

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
    if (customerId) {
      params.push(customerId);
      where.push(`s.user_id = ?${params.length}`);
    }
    const { startMs, endMs } = dayWindow(fromDay, toDay);
    if (startMs !== null) {
      params.push(startMs);
      where.push(`s.purchased_at >= to_timestamp(?${params.length} / 1000.0)`);
    }
    if (endMs !== null) {
      params.push(endMs);
      where.push(`s.purchased_at < to_timestamp(?${params.length} / 1000.0)`);
    }
    // The panel account name, because the panel is where this lookup starts:
    // an admin sees an account misbehaving or expiring on PasarGuard and holds
    // no other identifier for it. Without this, the column is a dead end.
    if (q) where.push(customerFilter(q, params, ['s.remote_username']));
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const from = `FROM subscriptions s JOIN users u ON u.id = s.user_id`;

    if (format === 'csv') {
      if (!mayExport(c.get('identity'))) return c.json({ ok: false, error: 'forbidden' }, 403);
      params.push(EXPORT_MAX);
      const { results } = await c.env.DB.prepare(
        `SELECT s.public_id, s.status, s.plan_name_at_sale, s.provider_name_at_sale,
                s.price_irr, s.volume_gb, s.remote_username, s.purchased_at, s.expires_at,
                u.telegram_id, u.username
           ${from} ${whereSql}
          ${orderClause('subscriptions', sort, dir, 's.id')}
          LIMIT ?${params.length}`,
      )
        .bind(...params)
        .all<Record<string, unknown>>();
      return c.body(
        csvBody(
          ['شناسه', 'کاربر', 'آیدی تلگرام', 'سرویس', 'پنل', 'نام روی پنل', 'حجم (گیگ)', 'مبلغ (تومان)', 'وضعیت', 'خرید', 'انقضا'],
          (results ?? []).map((r) => [
            r['public_id'],
            r['username'] === null ? '' : `@${String(r['username'])}`,
            r['telegram_id'],
            r['plan_name_at_sale'],
            r['provider_name_at_sale'] ?? '',
            r['remote_username'] ?? '',
            r['volume_gb'] ?? '',
            Number(r['price_irr']) / IRR_PER_TOMAN,
            r['status'],
            r['purchased_at'],
            r['expires_at'] ?? '',
          ]),
        ),
        200,
        CSV_HEADERS,
      );
    }
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
        ${orderClause('subscriptions', sort, dir, 's.id')}
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
      customerId: c.req.query('customerId') || undefined,
      fromDay: c.req.query('from') || undefined,
      toDay: c.req.query('to') || undefined,
      sort: c.req.query('sort') || undefined,
      dir: c.req.query('dir') ?? undefined,
      format: c.req.query('format') || undefined,
      kind: c.req.query('kind') || undefined,
      page: c.req.query('page') ?? undefined,
      pageSize: c.req.query('pageSize') ?? undefined,
    });
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    const { q, customerId, kind, page, pageSize, fromDay, toDay, sort, dir, format } = parsed.data;

    const where: string[] = [];
    const params: unknown[] = [];
    if (kind) {
      params.push(kind);
      where.push(`e.kind = ?${params.length}`);
    }
    if (customerId) {
      params.push(customerId);
      where.push(`e.user_id = ?${params.length}`);
    }
    const { startMs, endMs } = dayWindow(fromDay, toDay);
    if (startMs !== null) {
      params.push(startMs);
      where.push(`e.created_at >= to_timestamp(?${params.length} / 1000.0)`);
    }
    if (endMs !== null) {
      params.push(endMs);
      where.push(`e.created_at < to_timestamp(?${params.length} / 1000.0)`);
    }
    if (q) where.push(customerFilter(q, params));
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const from = `FROM wallet_entries e JOIN users u ON u.id = e.user_id`;

    if (format === 'csv') {
      if (!mayExport(c.get('identity'))) return c.json({ ok: false, error: 'forbidden' }, 403);
      params.push(EXPORT_MAX);
      const { results } = await c.env.DB.prepare(
        `SELECT e.id, e.amount_irr, e.kind, e.actor, e.note, e.created_at,
                u.telegram_id, u.username
           ${from} ${whereSql}
          ${orderClause('entries', sort, dir, 'e.id')}
          LIMIT ?${params.length}`,
      )
        .bind(...params)
        .all<Record<string, unknown>>();
      return c.body(
        csvBody(
          ['شناسه', 'کاربر', 'آیدی تلگرام', 'نوع', 'مبلغ (تومان)', 'توسط', 'یادداشت', 'زمان'],
          (results ?? []).map((r) => [
            r['id'],
            r['username'] === null ? '' : `@${String(r['username'])}`,
            r['telegram_id'],
            r['kind'],
            Number(r['amount_irr']) / IRR_PER_TOMAN,
            r['actor'] ?? '',
            r['note'] ?? '',
            r['created_at'],
          ]),
        ),
        200,
        CSV_HEADERS,
      );
    }
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
        ${orderClause('entries', sort, dir, 'e.id')}
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
