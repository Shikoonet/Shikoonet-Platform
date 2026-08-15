/**
 * Customers and their wallets — the shop's admin panel, not the payment hub.
 *
 * Everything here is under `/api/v1/admin/`, which is a different Cloudflare
 * Access application with a different audience: a token minted for the payment
 * dashboard does not verify against it. The two surfaces answer two different
 * questions — "is this one payment real" versus "how is the shop doing" — and
 * the people who need them are not the same people. See `isAdminSurface` in
 * `index.ts` for the gate, and `admin/AdminApp.tsx` for the page.
 *
 * Three rules shape the whole file, and each of them is a thing the PHP panel
 * this replaces gets wrong.
 *
 *   **The balance is never assigned.** `wallets.balance_irr` is derived by a
 *   trigger from append-only `wallet_entries`; an adjustment here inserts an
 *   entry and reads the balance back. Mirzabot does `Balance = Balance ± x` as
 *   a read-modify-write, which loses one of two concurrent edits and leaves
 *   nothing to reconstruct from — production still carries an account at
 *   -5,940,000 Toman that nothing can explain. Faoxima inherited it verbatim
 *   (`panel/user.php:195`), and its only audit trail is a Telegram message to a
 *   report channel: if the channel is muted or the send fails, the money moved
 *   and no record exists.
 *
 *   **Every change is ADMIN-only and writes `audit_logs`.** Reading is open to
 *   any signed-in operator, the same split `bankRoutes.ts` uses.
 *
 *   **The list is paginated in SQL.** `panel/users.php:18` is
 *   `SELECT * FROM user ORDER BY id DESC` with no LIMIT, rendered into one HTML
 *   page and sorted in the browser — 11,241 rows on this dataset. The count and
 *   the page come from the database.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';

import { MAX_SINGLE_PAYMENT_IRR } from '@shikoo/contracts';
import { audit, type Ident } from './adminAudit.js';

/**
 * A correction larger than the largest deposit the shop will accept is far more
 * likely to be a typed extra zero than an intent, and an extra zero on a debit
 * is the failure that has no undo. The bound itself is the shop's own
 * card-to-card ceiling — see `MAX_SINGLE_PAYMENT_IRR`.
 *
 * ponytail: one flat bound rather than per-role limits. There is one admin
 * role that can reach this route at all.
 */

const PAGE_SIZE_MAX = 100;

const ListQuery = z.object({
  q: z.string().trim().max(64).optional(),
  status: z.enum(['ACTIVE', 'BLOCKED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(25),
});

const AdjustBody = z
  .object({
    // Signed and non-zero, matching the CHECK on wallet_entries.amount_irr.
    // A credit and a debit are the same operation with a different sign, so
    // there is no separate "subtract" route to get out of step with this one.
    amountIrr: z
      .number()
      .int()
      .refine((n) => n !== 0, 'amount must not be zero')
      .refine(
        (n) => Math.abs(n) <= MAX_SINGLE_PAYMENT_IRR,
        'amount exceeds the single-adjustment ceiling',
      ),
    note: z.string().trim().min(1).max(500),
    // Supplied by the client so a double-submitted form collapses onto one
    // row in the database rather than being deduped by a disabled button.
    idempotencyKey: z.string().trim().min(8).max(120),
  })
  .strict();

const StatusBody = z
  .object({
    status: z.enum(['ACTIVE', 'BLOCKED']),
    reason: z.string().trim().max(500).nullable().default(null),
  })
  .strict();

interface CustomerRow {
  id: number;
  telegram_id: number;
  username: string | null;
  phone: string | null;
  status: string;
  is_reseller: boolean;
  discount_percent: number;
  balance_irr: number | null;
  registered_at: string;
  last_seen_at: string | null;
}

export function registerCustomerRoutes(
  app: Hono<{ Bindings: { DB: D1Database }; Variables: { identity: Ident } }>,
) {
  // --- list ---------------------------------------------------------------

  app.get('/api/v1/admin/customers', async (c) => {
    const parsed = ListQuery.safeParse({
      q: c.req.query('q') || undefined,
      status: c.req.query('status') || undefined,
      page: c.req.query('page') ?? undefined,
      pageSize: c.req.query('pageSize') ?? undefined,
    });
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    const { q, status, page, pageSize } = parsed.data;

    // Built by hand rather than by string concatenation of values: the
    // Postgres adapter closes parameter gaps, so the numbering has to stay
    // contiguous and every value has to be bound.
    const where: string[] = [];
    const params: unknown[] = [];
    if (status) {
      params.push(status);
      where.push(`u.status = ?${params.length}`);
    }
    if (q) {
      // A Telegram id is the identifier an admin actually has to hand — it is
      // what the bot reports and what a customer can read off their own
      // profile. A username is matched as a substring, case-insensitively,
      // and the leading @ is optional because people paste it either way.
      const handle = q.replace(/^@/, '');
      params.push(`%${handle}%`);
      const nameParam = params.length;
      const asId = /^[0-9]{1,19}$/.test(handle) ? handle : null;
      if (asId) {
        params.push(asId);
        where.push(`(u.username ILIKE ?${nameParam} OR u.telegram_id = ?${params.length})`);
      } else {
        where.push(`u.username ILIKE ?${nameParam}`);
      }
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM users u ${whereSql}`)
      .bind(...params)
      .first<{ n: number }>();
    const total = totalRow?.n ?? 0;

    params.push(pageSize);
    const limitParam = params.length;
    params.push((page - 1) * pageSize);
    const rows = await c.env.DB.prepare(
      `SELECT u.id, u.telegram_id, u.username, u.phone, u.status, u.is_reseller,
              u.discount_percent, w.balance_irr, u.registered_at, u.last_seen_at
         FROM users u
         LEFT JOIN wallets w ON w.user_id = u.id
         ${whereSql}
        ORDER BY u.id DESC
        LIMIT ?${limitParam} OFFSET ?${params.length}`,
    )
      .bind(...params)
      .all<CustomerRow>();

    return c.json({
      ok: true,
      total,
      page,
      pageSize,
      items: (rows.results ?? []).map((r) => ({
        id: r.id,
        telegramId: r.telegram_id,
        username: r.username,
        phone: r.phone,
        status: r.status,
        isReseller: r.is_reseller,
        discountPercent: Number(r.discount_percent),
        // No wallets row means no entries, which is a zero balance and not a
        // missing one — the trigger writes the row on the first entry.
        balanceIrr: r.balance_irr ?? 0,
        registeredAt: r.registered_at,
        lastSeenAt: r.last_seen_at,
      })),
    });
  });

  // --- one customer -------------------------------------------------------

  app.get('/api/v1/admin/customers/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const row = await c.env.DB.prepare(
      `SELECT u.id, u.telegram_id, u.username, u.phone, u.phone_verified, u.status,
              u.blocked_reason, u.is_reseller, u.discount_percent, u.referral_code,
              u.registered_at, u.last_seen_at, w.balance_irr
         FROM users u
         LEFT JOIN wallets w ON w.user_id = u.id
        WHERE u.id = ?1`,
    )
      .bind(id)
      .first<
        CustomerRow & {
          phone_verified: boolean;
          blocked_reason: string | null;
          referral_code: string | null;
        }
      >();
    if (!row) return c.json({ ok: false, error: 'not_found' }, 404);

    const entries = await c.env.DB.prepare(
      `SELECT amount_irr, kind, actor, note, created_at
         FROM wallet_entries
        WHERE user_id = ?1
        ORDER BY created_at DESC, id DESC
        LIMIT 50`,
    )
      .bind(id)
      .all<{
        amount_irr: number;
        kind: string;
        actor: string | null;
        note: string | null;
        created_at: string;
      }>();

    const orders = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total_irr) FILTER (WHERE status = 'COMPLETED'), 0) AS paid
         FROM orders WHERE user_id = ?1`,
    )
      .bind(id)
      .first<{ n: number; paid: number }>();

    return c.json({
      ok: true,
      customer: {
        id: row.id,
        telegramId: row.telegram_id,
        username: row.username,
        phone: row.phone,
        phoneVerified: row.phone_verified,
        status: row.status,
        blockedReason: row.blocked_reason,
        isReseller: row.is_reseller,
        discountPercent: Number(row.discount_percent),
        referralCode: row.referral_code,
        balanceIrr: row.balance_irr ?? 0,
        registeredAt: row.registered_at,
        lastSeenAt: row.last_seen_at,
        orderCount: orders?.n ?? 0,
        paidTotalIrr: orders?.paid ?? 0,
      },
      entries: (entries.results ?? []).map((e) => ({
        amountIrr: e.amount_irr,
        kind: e.kind,
        actor: e.actor,
        note: e.note,
        createdAt: e.created_at,
      })),
    });
  });

  // --- adjust the wallet --------------------------------------------------

  app.post('/api/v1/admin/customers/:id/wallet', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const parsed = AdjustBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: parsed.error.issues[0]?.message ?? null },
        400,
      );
    }
    const { amountIrr, note, idempotencyKey } = parsed.data;

    // Namespaced so a key the client picked cannot collide with the keys the
    // bot writes (`order:<id>:purchase`, `referral:<id>`) — and the AMOUNT is
    // part of it.
    //
    // Without the amount, an admin who types 500,000, notices the mistake,
    // corrects it to 5,000,000 and submits again gets a silent no-op: the form
    // keeps its key, the key is already spent, and the response says the money
    // moved. It did — the wrong amount, once. Keying by what is being written
    // means a corrected amount is a different write, while the double-submit
    // this exists for still collapses onto one row.
    const key = `admin-adjust:${id}:${amountIrr}:${idempotencyKey}`;

    // The read, the insert and the read-back are one transaction, and it opens
    // by locking the customer's row.
    //
    // The transaction alone is not enough, and believing it was is how the
    // first version of this went out: `wallets.balance_irr` is derived by a
    // trigger whose `INSERT … ON CONFLICT DO UPDATE` locks the wallet only from
    // the moment the entry lands, so two adjustments still both read the same
    // balance BEFORE either inserts. Eight of them at once produced eight audit
    // rows claiming the same starting balance and eight different totals — the
    // test names them.
    //
    // So the lock is taken on `users` — a row that always exists, where the
    // wallet may not yet — and it is taken by a statement of its own.
    //
    // That separation is the second thing this got wrong. Locking and reading
    // the balance in one joined statement does not work: a query that blocks on
    // `FOR UPDATE` re-checks only the locked table when it wakes and keeps its
    // original snapshot for everything joined to it, so seven waiting
    // adjustments all reported the balance as it was when they started. Under
    // READ COMMITTED a second statement takes a fresh snapshot, and by then the
    // lock is held.
    //
    // It does not serialise against the bot spending on the same wallet; that
    // would need the same lock on the bot's path, and the bot's own guard is
    // `spendOnOrder`. What this row claims — "your adjustment took the balance
    // from X to Y" — is true of every adjustment made here.
    const outcome = await c.env.DB.withSession(async (tx) => {
      const exists = await tx
        .prepare(`SELECT id FROM users WHERE id = ?1 FOR UPDATE`)
        .bind(id)
        .first<{ id: number }>();
      if (!exists) return null;

      const before = await tx
        .prepare(`SELECT COALESCE(balance_irr, 0) AS balance_irr FROM wallets WHERE user_id = ?1`)
        .bind(id)
        .first<{ balance_irr: number }>();

      const done = await tx
        .prepare(
          `INSERT INTO wallet_entries (user_id, amount_irr, kind, actor, note, idempotency_key)
           VALUES (?1, ?2, 'ADMIN_ADJUST', ?3, ?4, ?5)
           ON CONFLICT (idempotency_key) DO NOTHING`,
        )
        .bind(id, amountIrr, ident.email, note, key)
        .run();

      const after = await tx
        .prepare(`SELECT COALESCE(balance_irr, 0) AS balance_irr FROM wallets WHERE user_id = ?1`)
        .bind(id)
        .first<{ balance_irr: number }>();

      return {
        // No wallet row yet means no entries yet, which is a balance of zero.
        beforeIrr: Number(before?.balance_irr ?? 0),
        balanceIrr: Number(after?.balance_irr ?? 0),
        applied: done.meta.changes !== 0,
      };
    });

    if (outcome === null) return c.json({ ok: false, error: 'not_found' }, 404);
    const { beforeIrr, balanceIrr, applied } = outcome;

    // A replayed key is the ordinary outcome of a double-submitted form, not
    // an error: the money moved exactly once and the caller gets the same
    // balance either way. It is not audited twice, because nothing changed.
    if (!applied) {
      return c.json({ ok: true, applied: false, balanceIrr });
    }

    await audit(
      c.env.DB,
      ident,
      'customer.wallet_adjusted',
      'CUSTOMER',
      String(id),
      { balance_irr: beforeIrr },
      { balance_irr: balanceIrr, amount_irr: amountIrr },
      note,
    );

    // Reported rather than refused. An admin correcting a credit the customer
    // has already spent has to be able to leave the balance negative, and the
    // bot refuses to spend below zero anyway (`spendOnOrder`), so a negative
    // balance cannot become a free service. The caller shows it.
    return c.json({ ok: true, applied: true, balanceIrr, negative: balanceIrr < 0 });
  });

  // --- block / unblock ----------------------------------------------------

  app.post('/api/v1/admin/customers/:id/status', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const parsed = StatusBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const { status, reason } = parsed.data;

    const before = await c.env.DB.prepare(
      `SELECT status, blocked_reason FROM users WHERE id = ?1`,
    )
      .bind(id)
      .first<{ status: string; blocked_reason: string | null }>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);
    if (before.status === status) return c.json({ ok: true, changed: false, status });

    const blockedReason = status === 'BLOCKED' ? reason : null;
    await c.env.DB.prepare(
      `UPDATE users SET status = ?1, blocked_reason = ?2, updated_at = now() WHERE id = ?3`,
    )
      .bind(status, blockedReason, id)
      .run();
    await audit(
      c.env.DB,
      ident,
      status === 'BLOCKED' ? 'customer.blocked' : 'customer.unblocked',
      'CUSTOMER',
      String(id),
      before,
      { status, blocked_reason: blockedReason },
      reason,
    );
    return c.json({ ok: true, changed: true, status });
  });
}
