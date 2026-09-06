/**
 * کدهای تخفیف — the codes, who has spent them, and what is left.
 *
 * The state of a code is not a column. It is derived from the facts the bot
 * checks at redemption time (`apps/bot/src/discount.ts`): the expiry, the
 * redemption count against `max_uses`, and — for a discount, not a gift — the
 * fact that `GIFT_BALANCE` is never usable as a discount at all. This route
 * derives it from the same facts, so the badge on the screen and the answer the
 * customer gets cannot disagree. A `status` column holding «usable» would be a
 * second source of truth that drifts the first time someone forgets to write it.
 *
 * ## `status` arrived in 0059 anyway, and it is not that column
 *
 * The warning above is about deriving a FACT into a column. `discount_codes
 * .status` is not a fact about the code, it is an INTENT of the admin's:
 * «paused» is not implied by any date or count and cannot be computed from
 * anything. Nothing derives it and nothing else writes it.
 *
 * `state()` still derives, and now reads it FIRST — because a switched-off code
 * that showed «قابل استفاده» would be precisely the drift this header exists to
 * prevent, arriving from the other direction.
 *
 * **The code is unique case-insensitively here, and only here.** The column is
 * `UNIQUE` on the exact text, but the bot looks codes up with
 * `WHERE lower(code) = ?` and `LIMIT 1`. So `OFF15` and `off15` can both exist
 * as far as Postgres is concerned, and the customer who types either gets
 * whichever row the planner happens to return — a silently wrong discount. The
 * check that guards a value has to be at least as strict as the code that reads
 * it, so creation is refused on a case-insensitive collision.
 *
 * **No delete.** `discount_redemptions.code_id` is ON DELETE CASCADE, so
 * removing a code erases the record of everyone who spent it — including the
 * rows that stop a customer redeeming twice. Retiring a code sets its expiry to
 * now, which is exactly what the bot already treats as spent.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import { MAX_SINGLE_PAYMENT_IRR } from '@shikoo/contracts';
import { audit, type Ident } from './adminAudit.js';

const PAGE_SIZE_MAX = 100;

/**
 * Letters, digits, dash and underscore. Production holds codes like `off15`.
 *
 * No spaces, because the customer types this into a Telegram message and a
 * trailing space is invisible; no Persian digits, because `normalizeCode` only
 * lowercases and would not fold `۱` onto `1`.
 */
const CODE_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

const ListQuery = z.object({
  q: z.string().trim().max(64).optional(),
  state: z.enum(['USABLE', 'EXPIRED', 'USED_UP', 'DISABLED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(25),
});

const CreateBody = z
  .object({
    code: z.string().trim().regex(CODE_PATTERN, 'code must be 3-64 of A-Z, 0-9, - or _'),
    kind: z.enum(['GIFT_BALANCE', 'PERCENT_OFF', 'AMOUNT_OFF']),
    // A gift code is a credit to a wallet by another name, so it is bounded by
    // the same ceiling as a deposit.
    amountIrr: z.number().int().min(1).max(MAX_SINGLE_PAYMENT_IRR).nullable().default(null),
    percent: z.number().min(0.01).max(100).nullable().default(null),
    maxUses: z.number().int().min(1).max(1_000_000).nullable().default(null),
    appliesTo: z.enum(['ALL', 'BUY', 'RENEW']).default('ALL'),
    firstPurchaseOnly: z.boolean().default(false),
    resellersOnly: z.boolean().default(false),
    productId: z.number().int().positive().nullable().default(null),
    providerId: z.number().int().positive().nullable().default(null),
    expiresAt: z.string().datetime().nullable().default(null),
    // How many times ONE customer may use it. 1 is what every code did before
    // migration 0059, so an unchanged form keeps producing what it always did.
    // The ceiling of 100 is arbitrary and generous; what it refuses is the
    // typo that turns a code into an unbounded discount for one person.
    usesPerUser: z.number().int().min(1).max(100).default(1),
    // The customer's TELEGRAM id, not our internal one. It is what an operator
    // has in front of them — from «کاربران», from the customer's own message —
    // and it is resolved to a user below rather than trusted as a row id.
    targetTelegramId: z.number().int().nullable().default(null),
  })
  .strict()
  // The same rule as the table's own CHECK, stated here so the caller gets a
  // sentence instead of a driver error. The database still holds it.
  .refine(
    (b) => (b.kind === 'PERCENT_OFF' ? b.percent !== null : b.amountIrr !== null),
    'PERCENT_OFF needs a percent; the other kinds need an amount',
  )
  .refine(
    (b) => (b.kind === 'PERCENT_OFF' ? b.amountIrr === null : b.percent === null),
    'a code carries a percent or an amount, not both',
  )
  // A gift credits a wallet and is never applied to a purchase, so the fields
  // that narrow a discount would silently do nothing on one.
  .refine(
    (b) =>
      b.kind !== 'GIFT_BALANCE' ||
      (b.appliesTo === 'ALL' && b.productId === null && b.providerId === null),
    'a gift code credits a wallet and cannot be limited to a product, panel or action',
  );

interface CodeRow {
  id: number;
  code: string;
  kind: string;
  amount_irr: number | null;
  percent: number | null;
  max_uses: number | null;
  applies_to: string;
  first_purchase_only: boolean;
  resellers_only: boolean;
  product_id: number | null;
  product_name: string | null;
  provider_id: number | null;
  provider_name: string | null;
  expires_at: string | null;
  created_at: string;
  used: number;
  uses_per_user: number;
  status: 'ACTIVE' | 'DISABLED';
  target_user_id: number | null;
  target_user_telegram_id: number | null;
  target_user_username: string | null;
}

/**
 * Usable, expired, or spent — derived exactly as `checkCode` derives it.
 *
 * Expiry is compared against the server's clock, the same instant Postgres
 * would use; the caller renders it in Tehran time but never decides with it.
 */
function state(r: CodeRow, nowMs: number): 'USABLE' | 'EXPIRED' | 'USED_UP' | 'DISABLED' {
  // First, and in the same order the bot refuses. A paused code that is also
  // expired reads as paused here and refuses as paused there; the alternative
  // is a screen that says «منقضی» about something an admin can un-pause.
  if (r.status !== 'ACTIVE') return 'DISABLED';
  if (r.expires_at !== null && Date.parse(r.expires_at) <= nowMs) return 'EXPIRED';
  if (r.max_uses !== null && Number(r.used) >= r.max_uses) return 'USED_UP';
  return 'USABLE';
}

function shape(r: CodeRow, nowMs: number) {
  return {
    id: r.id,
    code: r.code,
    kind: r.kind,
    amountIrr: r.amount_irr === null ? null : Number(r.amount_irr),
    percent: r.percent === null ? null : Number(r.percent),
    maxUses: r.max_uses,
    used: Number(r.used),
    appliesTo: r.applies_to,
    firstPurchaseOnly: r.first_purchase_only,
    resellersOnly: r.resellers_only,
    product: r.product_id ? { id: r.product_id, name: r.product_name } : null,
    provider: r.provider_id ? { id: r.provider_id, name: r.provider_name } : null,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    usesPerUser: r.uses_per_user,
    status: r.status,
    // The telegram id, not the internal one: it is what an operator can search
    // «کاربران» by and what the customer would quote. No name is invented when
    // the user has no username — «—» is the screen's business, not the API's.
    targetUser: r.target_user_id
      ? {
          id: r.target_user_id,
          telegramId:
            r.target_user_telegram_id === null ? null : Number(r.target_user_telegram_id),
          username: r.target_user_username,
        }
      : null,
    state: state(r, nowMs),
  };
}

const SELECT_CODE = `
  SELECT dc.id, dc.code, dc.kind, dc.amount_irr, dc.percent, dc.max_uses,
         dc.applies_to, dc.first_purchase_only, dc.resellers_only,
         dc.product_id, p.name AS product_name,
         dc.provider_id, pr.name AS provider_name,
         dc.expires_at, dc.created_at,
         dc.uses_per_user, dc.status, dc.target_user_id,
         tu.telegram_id AS target_user_telegram_id, tu.username AS target_user_username,
         (SELECT COUNT(*) FROM discount_redemptions r WHERE r.code_id = dc.id) AS used
    FROM discount_codes dc
    LEFT JOIN products p ON p.id = dc.product_id
    LEFT JOIN provisioning_providers pr ON pr.id = dc.provider_id
    LEFT JOIN users tu ON tu.id = dc.target_user_id`;

export function registerDiscountRoutes(
  app: Hono<{ Bindings: { DB: D1Database }; Variables: { identity: Ident } }>,
) {
  // --- the codes ----------------------------------------------------------

  app.get('/api/v1/admin/discounts', async (c) => {
    const parsed = ListQuery.safeParse({
      q: c.req.query('q') || undefined,
      state: c.req.query('state') || undefined,
      page: c.req.query('page') ?? undefined,
      pageSize: c.req.query('pageSize') ?? undefined,
    });
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    const { q, state: wanted, page, pageSize } = parsed.data;

    const where: string[] = [];
    const params: unknown[] = [];
    if (q) {
      // Case-insensitive, because that is how the code will be typed.
      params.push(`%${q.toLowerCase()}%`);
      where.push(`lower(dc.code) LIKE ?${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM discount_codes dc ${whereSql}`,
    )
      .bind(...params)
      .first<{ n: number }>();

    params.push(pageSize);
    const limitParam = params.length;
    params.push((page - 1) * pageSize);
    const rows = await c.env.DB.prepare(
      `${SELECT_CODE} ${whereSql} ORDER BY dc.id DESC LIMIT ?${limitParam} OFFSET ?${params.length}`,
    )
      .bind(...params)
      .all<CodeRow>();

    const now = Date.now();
    let items = (rows.results ?? []).map((r) => shape(r, now));
    // The state filter runs after shaping because the state is derived, not
    // stored. It therefore filters the page, and `total` stays the count of
    // everything matching `q` — the pager would otherwise claim pages that do
    // not exist.
    if (wanted) items = items.filter((i) => i.state === wanted);

    return c.json({
      ok: true,
      total: totalRow?.n ?? 0,
      page,
      pageSize,
      filteredByState: wanted ?? null,
      items,
    });
  });

  // --- who spent one ------------------------------------------------------

  app.get('/api/v1/admin/discounts/:id/redemptions', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const rows = await c.env.DB.prepare(
      `SELECT r.id, r.amount_irr, r.created_at, r.order_id,
              u.telegram_id, u.username
         FROM discount_redemptions r
         JOIN users u ON u.id = r.user_id
        WHERE r.code_id = ?1
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT 100`,
    )
      .bind(id)
      .all<{
        id: number;
        amount_irr: number;
        created_at: string;
        order_id: number | null;
        telegram_id: number;
        username: string | null;
      }>();

    return c.json({
      ok: true,
      items: (rows.results ?? []).map((r) => ({
        id: r.id,
        amountIrr: Number(r.amount_irr),
        createdAt: r.created_at,
        orderId: r.order_id,
        telegramId: r.telegram_id,
        username: r.username,
      })),
    });
  });

  // --- create -------------------------------------------------------------

  app.post('/api/v1/admin/discounts', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const parsed = CreateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: parsed.error.issues[0]?.message },
        400,
      );
    }
    const b = parsed.data;

    // Stricter than the column, on purpose — see the file header. Without this
    // a second `OFF15` alongside `off15` is accepted by Postgres and the bot
    // then resolves the customer's code to an arbitrary one of the two.
    const clash = await c.env.DB.prepare(
      `SELECT code FROM discount_codes WHERE lower(code) = ?1 LIMIT 1`,
    )
      .bind(b.code.toLowerCase())
      .first<{ code: string }>();
    if (clash) {
      return c.json({ ok: false, error: 'code_exists', detail: clash.code }, 409);
    }

    if (b.productId !== null) {
      const p = await c.env.DB.prepare(`SELECT 1 AS ok FROM products WHERE id = ?1`)
        .bind(b.productId)
        .first<{ ok: number }>();
      if (!p) return c.json({ ok: false, error: 'unknown_product' }, 400);
    }
    if (b.providerId !== null) {
      const p = await c.env.DB.prepare(`SELECT 1 AS ok FROM provisioning_providers WHERE id = ?1`)
        .bind(b.providerId)
        .first<{ ok: number }>();
      if (!p) return c.json({ ok: false, error: 'unknown_panel' }, 400);
    }

    // Resolved rather than stored as typed. A code aimed at a telegram id that
    // has never opened the bot would be a code that silently works for nobody,
    // and the operator would have no way to see that from the screen.
    let targetUserId: number | null = null;
    if (b.targetTelegramId !== null) {
      const u = await c.env.DB.prepare(`SELECT id FROM users WHERE telegram_id = ?1`)
        .bind(b.targetTelegramId)
        .first<{ id: number }>();
      if (!u) return c.json({ ok: false, error: 'unknown_customer' }, 400);
      targetUserId = Number(u.id);
    }

    const created = await c.env.DB.prepare(
      `INSERT INTO discount_codes
         (code, kind, amount_irr, percent, max_uses, applies_to,
          first_purchase_only, resellers_only, product_id, provider_id, expires_at,
          uses_per_user, target_user_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
       RETURNING id`,
    )
      .bind(
        b.code,
        b.kind,
        b.amountIrr,
        b.percent,
        b.maxUses,
        b.appliesTo,
        b.firstPurchaseOnly,
        b.resellersOnly,
        b.productId,
        b.providerId,
        b.expiresAt,
        b.usesPerUser,
        targetUserId,
      )
      .first<{ id: number }>();
    const id = Number(created!.id);

    await audit(
      c.env.DB,
      ident,
      'discount.created',
      'DISCOUNT_CODE',
      String(id),
      null,
      {
        code: b.code,
        kind: b.kind,
        amount_irr: b.amountIrr,
        percent: b.percent,
        max_uses: b.maxUses,
        applies_to: b.appliesTo,
        expires_at: b.expiresAt,
        uses_per_user: b.usesPerUser,
        target_user_id: targetUserId,
      },
      null,
    );

    const row = await c.env.DB.prepare(`${SELECT_CODE} WHERE dc.id = ?1`).bind(id).first<CodeRow>();
    return c.json({ ok: true, discount: shape(row!, Date.now()) }, 201);
  });

  // --- pause and resume ---------------------------------------------------

  /**
   * Turns a code off, or back on.
   *
   * Deliberately separate from `/expire` rather than folded into it, because
   * they are not two spellings of one thing. Expiring writes a DATE and cannot
   * be undone — the record of when the code ended is the point. Pausing is a
   * switch, and every reason to reach for it («stop this until I check
   * something») is a reason to want it back.
   */
  app.post('/api/v1/admin/discounts/:id/status', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = z
      .object({ status: z.enum(['ACTIVE', 'DISABLED']) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ ok: false, error: 'invalid_body' }, 400);

    const before = await c.env.DB.prepare(`${SELECT_CODE} WHERE dc.id = ?1`)
      .bind(id)
      .first<CodeRow>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);
    // Already there. Not an error, and not an audit row saying nothing moved.
    if (before.status === body.data.status) {
      return c.json({ ok: true, changed: false, discount: shape(before, Date.now()) });
    }

    await c.env.DB.prepare(`UPDATE discount_codes SET status = ?2 WHERE id = ?1`)
      .bind(id, body.data.status)
      .run();

    const after = await c.env.DB.prepare(`${SELECT_CODE} WHERE dc.id = ?1`)
      .bind(id)
      .first<CodeRow>();

    await audit(
      c.env.DB,
      ident,
      'discount.status',
      'DISCOUNT_CODE',
      String(id),
      { status: before.status },
      { status: body.data.status },
      null,
    );

    return c.json({ ok: true, changed: true, discount: shape(after!, Date.now()) });
  });

  // --- retire -------------------------------------------------------------

  app.post('/api/v1/admin/discounts/:id/expire', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const before = await c.env.DB.prepare(`${SELECT_CODE} WHERE dc.id = ?1`)
      .bind(id)
      .first<CodeRow>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    // Already in the past — the code is spent and nothing needs to move. Not
    // an error, and not a second audit row saying nothing happened.
    if (before.expires_at !== null && Date.parse(before.expires_at) <= Date.now()) {
      return c.json({ ok: true, changed: false, discount: shape(before, Date.now()) });
    }

    await c.env.DB.prepare(`UPDATE discount_codes SET expires_at = now() WHERE id = ?1`)
      .bind(id)
      .run();

    const after = await c.env.DB.prepare(`${SELECT_CODE} WHERE dc.id = ?1`)
      .bind(id)
      .first<CodeRow>();

    await audit(
      c.env.DB,
      ident,
      'discount.expired',
      'DISCOUNT_CODE',
      String(id),
      { expires_at: before.expires_at },
      { expires_at: after!.expires_at },
      null,
    );

    return c.json({ ok: true, changed: true, discount: shape(after!, Date.now()) });
  });
}
