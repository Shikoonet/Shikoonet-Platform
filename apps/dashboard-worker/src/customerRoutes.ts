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

import type { EnvName } from '@shikoo/contracts';
import { MAX_SINGLE_PAYMENT_IRR, MIRZABOT_SOURCE, Texts } from '@shikoo/contracts';
import {
  MAX_MESSAGE_LENGTH,
  adjustWallet,
  maskCardDigits,
  queueDirectMessage,
  setCustomerReseller,
  setCustomerStatus,
} from '@shikoo/domain';
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

/**
 * The reseller level in force, and the rule for which one that is.
 *
 * The identical rule lives in `DISCOUNT_PERCENT` and `tierFor`
 * (`apps/bot/src/handle.ts`, `serviceActions.ts`): `is_reseller` is asked
 * first, and a NULL level means level one. It is written here a third time
 * rather than imported because it is SQL against a different alias — what keeps
 * the two honest is `customers.test.ts`, which asserts this route returns the
 * number the bot charges.
 *
 * A LEFT JOIN rather than the bot's scalar subquery because both statements
 * here are plain SELECTs and the panel needs the level's NAME as well as its
 * percentage — «۱۵٪ از نماینده سطح ۲» rather than a bare number an operator
 * cannot account for.
 */
const TIER_JOIN = `LEFT JOIN reseller_tiers t
    ON u.is_reseller AND t.code = COALESCE(u.reseller_tier, 'n')`;

/** The percentage the bot will actually charge. */
const TIER_COLUMNS = `t.code AS tier_code, t.name AS tier_name,
              t.discount_percent AS tier_percent,
              COALESCE(t.discount_percent, u.discount_percent) AS effective_discount_percent`;

const ListQuery = z.object({
  q: z.string().trim().max(64).optional(),
  status: z.enum(['ACTIVE', 'BLOCKED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(25),
  /**
   * «کی بیشترین پول را در کیف پولش دارد» — Sam, 2026-08-30.
   *
   * A closed set rather than a column name from the query string, so this can
   * never become an injection point, and only two entries because those are
   * the two orderings anything asks for. `balance` sorts by credit **and** by
   * debt: the deepest reseller is a page away rather than behind a filter
   * nobody would think to apply, which is the same reason `shopStats` keeps
   * the two wallet totals apart instead of netting them.
   */
  sort: z.enum(['recent', 'balance', 'debt']).default('recent'),
  /**
   * «لیست نمایندگان» — Sam, 2026-09-03. A filter on the list that already
   * paginates, searches and sorts, rather than a screen of its own.
   */
  reseller: z.enum(['yes', 'no']).optional(),
});

const ORDER_BY: Record<'recent' | 'balance' | 'debt', string> = {
  recent: 'u.id DESC',
  // NULLS LAST, because a customer with no wallet row has a zero balance and
  // not the largest one — Postgres sorts NULL highest under DESC by default.
  balance: 'w.balance_irr DESC NULLS LAST, u.id DESC',
  debt: 'w.balance_irr ASC NULLS LAST, u.id DESC',
};

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

/** Whole percent, 0 to 100 — the same bound the bot's typed answer enforces. */
const DiscountBody = z.object({ percent: z.number().int().min(0).max(100) }).strict();

/**
 * The two levels, spelled out rather than taken as any string.
 *
 * `reseller_tiers` has a CHECK allowing only these, so a third value would be a
 * constraint error rather than a wrong price — but a 400 naming the field is a
 * better answer than a 500, and this is also where the enum is visible to
 * whoever adds a third level later.
 */
const ResellerBody = z
  .object({
    isReseller: z.boolean(),
    tier: z.enum(['n', 'n2']).nullable().default(null),
  })
  .strict();

const MessageBody = z
  .object({
    body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
    // The caller's, for the same reason the bulk routes take one: a retry has
    // to land on the same row or the customer is messaged twice.
    messageId: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'expected a uuid'),
  })
  .strict();

interface TierColumns {
  tier_code: string | null;
  tier_name: string | null;
  tier_percent: number | null;
  effective_discount_percent: number;
}

interface CustomerRow extends TierColumns {
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
  app: Hono<{ Bindings: { DB: D1Database; ENV_NAME: EnvName }; Variables: { identity: Ident } }>,
) {
  // --- list ---------------------------------------------------------------

  app.get('/api/v1/admin/customers', async (c) => {
    const parsed = ListQuery.safeParse({
      q: c.req.query('q') || undefined,
      status: c.req.query('status') || undefined,
      page: c.req.query('page') ?? undefined,
      pageSize: c.req.query('pageSize') ?? undefined,
      reseller: c.req.query('reseller') || undefined,
      sort: c.req.query('sort') || undefined,
    });
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    const { q, status, page, pageSize, sort, reseller } = parsed.data;

    // Built by hand rather than by string concatenation of values: the
    // Postgres adapter closes parameter gaps, so the numbering has to stay
    // contiguous and every value has to be bound.
    const where: string[] = [];
    const params: unknown[] = [];
    if (status) {
      params.push(status);
      where.push(`u.status = ?${params.length}`);
    }
    // No parameter: the value is one of two literals from a closed enum, and
    // binding a boolean here would renumber everything after it for nothing.
    if (reseller) where.push(reseller === 'yes' ? `u.is_reseller` : `NOT u.is_reseller`);
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
              u.discount_percent, ${TIER_COLUMNS},
              w.balance_irr, u.registered_at, u.last_seen_at
         FROM users u
         LEFT JOIN wallets w ON w.user_id = u.id
         ${TIER_JOIN}
         ${whereSql}
        ORDER BY ${ORDER_BY[sort]}
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
        // The personal column, raw. `effectiveDiscountPercent` beside it is
        // what the bot charges — they differ for every reseller on a level, and
        // a screen showing only the first would disagree with the shop.
        discountPercent: Number(r.discount_percent),
        tier: r.tier_code === null ? null : { code: r.tier_code, name: r.tier_name ?? r.tier_code, percent: Number(r.tier_percent) },
        effectiveDiscountPercent: Number(r.effective_discount_percent),
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
              u.blocked_reason, u.is_reseller, u.discount_percent, ${TIER_COLUMNS},
              u.referral_code, u.registered_at, u.last_seen_at, w.balance_irr
         FROM users u
         LEFT JOIN wallets w ON w.user_id = u.id
         ${TIER_JOIN}
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

    /**
     * «این آی‌دی چند بار و به کدام کارت‌ها واریز داشته» — the question this
     * drawer is opened with and could not answer. It knew the wallet and the
     * order count; the claims, and the cards they named, were only reachable
     * from the payments screen by typing the id in again.
     *
     * Counted exactly as «توازن کارت‌ها» counts a card's takings — settled
     * claims of this source, summing `expected_amount_irr` — so a customer's
     * rows here are a SUBSET of that card's number rather than a second
     * definition of the same word (rule 6: the two screens have to agree by
     * construction, not by coincidence).
     *
     * `customer_reference` is text and holds the Telegram id — one production
     * row holds «Poyan test payment» — so the id is bound as text and the
     * column is never cast. `idx_claim_customer_reference` (migration 0046)
     * is what keeps this cheap on the drawer's open.
     */
    const byCard = await c.env.DB.prepare(
      `SELECT c.card_digits,
              COUNT(*) AS payments,
              COALESCE(SUM(c.expected_amount_irr), 0) AS amount_irr,
              MAX(COALESCE(c.paid_clicked_at, c.created_at)) AS last_paid_at
         FROM payment_claims c
        WHERE c.source_system = ?1
          AND c.status = 'VERIFIED'
          AND c.customer_reference = ?2
        GROUP BY c.card_digits
        ORDER BY amount_irr DESC, c.card_digits ASC`,
    )
      .bind(MIRZABOT_SOURCE, String(row.telegram_id))
      .all<{
        card_digits: string | null;
        payments: number;
        amount_irr: number;
        last_paid_at: number | null;
      }>();

    const cards = (byCard.results ?? []).map((r) => ({
      // Never the full number, on any screen — the payments list holds the
      // same line.
      cardMasked: r.card_digits ? maskCardDigits(r.card_digits) : null,
      payments: Number(r.payments),
      amountIrr: Number(r.amount_irr),
      lastPaidAt: r.last_paid_at,
    }));

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
        tier:
          row.tier_code === null
            ? null
            : {
                code: row.tier_code,
                name: row.tier_name ?? row.tier_code,
                percent: Number(row.tier_percent),
              },
        effectiveDiscountPercent: Number(row.effective_discount_percent),
        referralCode: row.referral_code,
        balanceIrr: row.balance_irr ?? 0,
        registeredAt: row.registered_at,
        lastSeenAt: row.last_seen_at,
        orderCount: orders?.n ?? 0,
        paidTotalIrr: orders?.paid ?? 0,
      },
      payments: {
        count: cards.reduce((n, c) => n + c.payments, 0),
        totalIrr: cards.reduce((n, c) => n + c.amountIrr, 0),
        byCard: cards,
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

    // The write itself — the lock, the entry, the read-back and the reasons all
    // three are shaped the way they are — is `adjustWallet` in `@shikoo/domain`.
    // It moved there when the bot's admin panel needed the same operation on a
    // phone: two ways to move a customer's money would agree today and drift on
    // the first fix applied to only one of them.
    const outcome = await adjustWallet(c.env.DB, {
      userId: id,
      amountIrr,
      note,
      actor: ident.email,
      idempotencyKey,
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

    const outcome = await setCustomerStatus(c.env.DB, { userId: id, status, reason });
    if (!outcome) return c.json({ ok: false, error: 'not_found' }, 404);
    if (!outcome.changed) return c.json({ ok: true, changed: false, status });

    await audit(
      c.env.DB,
      ident,
      status === 'BLOCKED' ? 'customer.blocked' : 'customer.unblocked',
      'CUSTOMER',
      String(id),
      outcome.before,
      { status, blocked_reason: outcome.blockedReason },
      reason,
    );
    return c.json({ ok: true, changed: true, status });
  });

  // --- permanent discount -------------------------------------------------

  /**
   * The percentage taken off every future order for one customer.
   *
   * The bot has had this since its admin panel shipped and the web panel had
   * nothing — `test/bot-subset.test.ts` is what said so out loud, after the
   * plan had recorded «✅ صفحهٔ کاربران» for it on the strength of the page
   * showing the number.
   */
  app.post('/api/v1/admin/customers/:id/discount', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const parsed = DiscountBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const { percent } = parsed.data;

    // The PERSONAL column, raw and deliberately not the effective one. This
    // route writes that column, and an audit entry saying «was 20» when the
    // personal value was 5 — because the level's 20 was read instead — turns
    // the one record of what an operator actually changed into fiction.
    const before = await c.env.DB.prepare(
      `SELECT u.discount_percent, u.is_reseller, u.reseller_tier FROM users u WHERE u.id = ?1`,
    )
      .bind(id)
      .first<{ discount_percent: number; is_reseller: boolean; reseller_tier: string | null }>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    await c.env.DB.prepare(
      `UPDATE users SET discount_percent = ?2, updated_at = now() WHERE id = ?1`,
    )
      .bind(id, percent)
      .run();
    await audit(
      c.env.DB,
      ident,
      'customer.discount_set',
      'CUSTOMER',
      String(id),
      { discount_percent: before.discount_percent },
      { discount_percent: percent },
      null,
    );
    // What the customer will actually be charged. For a reseller on a level
    // this is the LEVEL's number and not the one just saved — so the screen can
    // say «this is stored, but the level is what they pay» instead of showing a
    // figure the shop will never use.
    const effective = await c.env.DB.prepare(
      `SELECT ${TIER_COLUMNS} FROM users u ${TIER_JOIN} WHERE u.id = ?1`,
    )
      .bind(id)
      .first<TierColumns>();

    return c.json({
      ok: true,
      percent,
      effectivePercent: Number(effective?.effective_discount_percent ?? percent),
      tierName: effective?.tier_name ?? null,
    });
  });

  // --- reseller, and which level ------------------------------------------

  /**
   * Makes somebody a reseller from the panel, or stops them being one.
   *
   * Sam, 2026-09-03: he wanted to choose a person himself rather than wait for
   * them to apply through the bot, which until now was the only path
   * `is_reseller` had.
   *
   * The flag and the level are one body and one statement because they are one
   * decision — see `setCustomerReseller` for why doing it in two would price
   * somebody wrongly in between.
   */
  app.post('/api/v1/admin/customers/:id/reseller', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const parsed = ResellerBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const { isReseller, tier } = parsed.data;

    const outcome = await setCustomerReseller(c.env.DB, { userId: id, isReseller, tier });
    if (!outcome) return c.json({ ok: false, error: 'not_found' }, 404);
    if (!outcome.changed) return c.json({ ok: true, changed: false });

    await audit(
      c.env.DB,
      ident,
      isReseller ? 'customer.reseller_set' : 'customer.reseller_cleared',
      'CUSTOMER',
      String(id),
      outcome.before,
      outcome.after,
      null,
    );
    return c.json({ ok: true, changed: true });
  });

  // --- one message to one customer ----------------------------------------

  /**
   * Queued, not sent.
   *
   * The bot sends its version inline because it is already holding a Telegram
   * connection; this process is not, so the message goes into the same two
   * tables a broadcast uses and the bot's poll loop delivers it. At most once,
   * never twice — a customer who receives a support message twice has been
   * spammed by a shop they trust with their money.
   *
   * The shop's name goes in front of the body, through the same editable text
   * the bot renders. An unattributed message from a bot somebody bought a
   * subscription from reads as a scam, and this is the screen most likely to be
   * used while a customer is already anxious about money — so the prefix is not
   * optional, and it is not a second copy of the wording either.
   */
  app.post('/api/v1/admin/customers/:id/message', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const parsed = MessageBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const { body, messageId } = parsed.data;

    const { results } = await c.env.DB.prepare(`SELECT key, value FROM bot_texts`).all<{
      key: string;
      value: string;
    }>();
    const texts = new Texts(Object.fromEntries((results ?? []).map((r) => [r.key, r.value])));
    const text = texts.render('MESSAGE_FROM_SHOP', { body });
    if (text.length > MAX_MESSAGE_LENGTH) {
      return c.json({ ok: false, error: 'message_too_long' }, 400);
    }

    // `created_by` is a Telegram id on the bot's path and this operator has
    // none. The audit row carries the email, which is who actually did it.
    const queued = await queueDirectMessage(c.env.DB, messageId, text, id, 0);
    if (queued === 0) return c.json({ ok: false, error: 'not_active' }, 409);

    await audit(
      c.env.DB,
      ident,
      'customer.messaged',
      'CUSTOMER',
      String(id),
      null,
      { length: body.length, message_id: messageId },
      null,
    );
    return c.json({ ok: true, queued });
  });
}
