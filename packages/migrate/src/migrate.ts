/**
 * The migration. Ordered steps, each idempotent, all inside one transaction.
 *
 * Idempotency comes from the schema, not from bookkeeping here: every migrated
 * table carries the legacy natural key under a UNIQUE constraint, so every
 * insert can use `ON CONFLICT DO NOTHING` against that key. A run that dies
 * halfway is simply run again.
 *
 * Rows whose parent no longer exists are skipped and counted, never invented.
 * Production has 87 wheel spins, 19 referrals, 2 reseller requests and 1 order
 * belonging to deleted users.
 */

import type { Connection } from 'mysql2/promise';
import type pg from 'pg';
import { correctCardDigits } from './corrections.js';
import {
  d1Table, insertBatch, mysqlRows, report, type Column, type Config,
} from './db.js';
import * as t from './transform.js';

type Row = Record<string, string | null>;

interface Ctx {
  cfg: Config;
  my: Connection;
  pg: pg.Client;
  /** telegram_id -> users.id, filled by the users step. */
  userId: Map<string, string>;
  skipped: Map<string, number>;
}

const ts = {
  tehran: { expr: t.sqlExpr.tehranString },
  epochS: { expr: t.sqlExpr.epochSeconds },
  epochMs: { expr: t.sqlExpr.epochMillis },
} as const;

function cols(spec: (string | [string, NonNullable<Column['expr']>])[]): Column[] {
  return spec.map((s) =>
    typeof s === 'string' ? { name: s } : { name: s[0], expr: s[1] },
  );
}

function skip(ctx: Ctx, what: string, n = 1): void {
  ctx.skipped.set(what, (ctx.skipped.get(what) ?? 0) + n);
}

/** A legacy percentage field; anything outside 0-100 is treated as unset. */
function percentOrZero(value: string | null | undefined): number {
  const n = Number((value ?? '0').trim());
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 0;
}

/** Resolves a legacy telegram id to a users.id, or null when the user is gone. */
function user(ctx: Ctx, legacyId: string | null | undefined): string | null {
  if (!legacyId) return null;
  return ctx.userId.get(String(legacyId).trim()) ?? null;
}

// ===========================================================================
// steps
// ===========================================================================

async function migrateUsers(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT * FROM `user`');
  const claimed = [
    'id', 'username', 'number', 'verify', 'lang', 'User_Status',
    'description_blocking', 'agent', 'codeInvitation', 'Balance', 'register',
    'limit_usertest', 'score', 'roll_Status', 'pricediscount',
  ];
  // Transient conversation state and a plaintext session token: deliberately
  // not carried into the customer record.
  const dropped = [
    'step', 'Processing_value', 'Processing_value_one', 'Processing_value_tow',
    'Processing_value_four', 'pagenumber', 'token',
  ];

  const values = rows.map((r) => [
    t.telegramId(r.id).toString(),
    t.username(r.username),
    t.phone(r.number),
    t.phone(r.number) !== null && r.verify === '1',
    r.lang === 'en' ? 'en' : 'fa',
    t.userStatus(r.User_Status),
    r.description_blocking || null,
    t.isReseller(r.agent),
    r.codeInvitation || null,
    Number(r.limit_usertest ?? 0),
    Number(r.score ?? 0),
    percentOrZero(r.pricediscount),
    r.roll_Status !== '0',
    t.epochSeconds(r.register, 'user.register'),
    JSON.stringify(t.legacyAttrs(r, claimed, dropped)),
  ]);

  const written = await insertBatch(
    ctx.pg, 'users',
    cols([
      'telegram_id', 'username', 'phone', 'phone_verified', 'lang', 'status',
      'blocked_reason', 'is_reseller', 'referral_code', 'test_quota_used',
      'score', 'discount_percent', 'notify_enabled',
      ['registered_at', ts.epochS.expr], ['legacy_attrs', (p) => `${p}::jsonb`],
    ]),
    values, { conflict: '(telegram_id)' },
  );

  const { rows: idMap } = await ctx.pg.query<{ id: string; telegram_id: string }>(
    'SELECT id, telegram_id FROM users',
  );
  for (const m of idMap) ctx.userId.set(m.telegram_id, m.id);
  return written;
}

/** reagent_report holds referrer telegram ids; all 179 resolve to a user row. */
async function migrateReferrals(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT * FROM reagent_report');
  let n = 0;
  for (const r of rows) {
    const child = user(ctx, r.user_id);
    const referrer = user(ctx, r.reagent);
    if (!child) { skip(ctx, 'referrals: referred user deleted'); continue; }
    if (!referrer) { skip(ctx, 'referrals: referrer deleted'); continue; }
    const res = await ctx.pg.query(
      `UPDATE users SET referred_by = $1, referral_bonus_claimed = $2
        WHERE id = $3 AND referred_by IS DISTINCT FROM $1`,
      [referrer, r.get_gift === '1', child],
    );
    n += res.rowCount ?? 0;
  }
  return n;
}

/**
 * Opens every wallet, then records the legacy balance as a single OPENING entry.
 *
 * The wallets row is created for everyone so that "no wallet" never has to mean
 * "zero"; the entry is written only when there is a balance, because a
 * zero-amount ledger line is meaningless and the schema rejects it.
 */
async function migrateWallets(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT id, Balance FROM `user`');

  await insertBatch(
    ctx.pg, 'wallets', cols(['user_id']),
    rows.flatMap((r) => { const u = user(ctx, r.id); return u ? [[u]] : []; }),
    { conflict: '(user_id)' },
  );

  const entries = rows.flatMap((r) => {
    const u = user(ctx, r.id);
    const amount = t.tomanToIrr(r.Balance);
    if (!u || amount === 0n) return [];
    return [[u, amount.toString(), 'OPENING', 'SYSTEM',
             'legacy balance carried over unchanged',
             `legacy-opening:${String(r.id).trim()}`]];
  });

  return insertBatch(
    ctx.pg, 'wallet_entries',
    cols(['user_id', 'amount_irr', 'kind', 'actor', 'note', 'idempotency_key']),
    entries, { conflict: '(idempotency_key)' },
  );
}

async function migrateSettings(ctx: Ctx): Promise<number> {
  const out: unknown[][] = [];
  const push = (scope: string, key: string, value: unknown) =>
    out.push([scope, key, JSON.stringify(value ?? null)]);

  // `setting` is a single row whose 51 columns are the settings.
  const [botRow] = await mysqlRows<Row>(ctx.my, 'SELECT * FROM `setting` LIMIT 1');
  if (botRow) for (const [k, v] of Object.entries(botRow)) push('bot', k, v);

  for (const r of await mysqlRows<Row>(ctx.my, 'SELECT * FROM shopSetting')) {
    push('shop', String(r.Namevalue), r.value);
  }
  for (const r of await mysqlRows<Row>(ctx.my, 'SELECT * FROM PaySetting')) {
    push('pay', String(r.NamePay), r.ValuePay);
  }
  // Two more single-purpose tables that are configuration, not entities.
  const [aff] = await mysqlRows<Row>(ctx.my, 'SELECT * FROM affiliates LIMIT 1');
  if (aff) for (const [k, v] of Object.entries(aff)) push('shop', `affiliate_${k}`, v);
  for (const r of await mysqlRows<Row>(ctx.my, 'SELECT * FROM topicid')) {
    push('bot', `topic_${String(r.report)}`, r.idreport);
  }

  return insertBatch(
    ctx.pg, 'settings',
    cols(['scope', 'key', ['value', (p) => `${p}::jsonb`]]),
    out, { conflict: '(scope, key)' },
  );
}

async function migrateAdmins(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT * FROM `admin`');
  // `admin.password` is a plaintext web-panel password and is not carried over.
  return insertBatch(
    ctx.pg, 'admins', cols(['telegram_id', 'username', 'role']),
    rows.map((r) => [
      t.telegramId(r.id_admin).toString(),
      t.username(r.username),
      r.rule === 'all' ? 'OWNER' : 'ADMIN',
    ]),
    { conflict: '(telegram_id)' },
  );
}

async function migrateProviders(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT * FROM marzban_panel');
  const claimed = ['id', 'code_panel', 'name_panel', 'type', 'status', 'url_panel',
                   'username_panel', 'password_panel', 'limit_panel'];
  return insertBatch(
    ctx.pg, 'provisioning_providers',
    cols(['legacy_id', 'code', 'name', 'kind', 'status', 'base_url', 'capacity',
          ['config', (p) => `${p}::jsonb`]]),
    rows.map((r) => [
      Number(r.id),
      r.code_panel ?? `panel-${r.id}`,
      r.name_panel ?? `panel-${r.id}`,
      (r.type ?? 'marzban').toLowerCase(),
      r.status === 'active' ? 'ACTIVE' : 'DISABLED',
      r.url_panel,
      // 'unlimited' is the legacy sentinel; NULL means unlimited here.
      r.limit_panel && /^\d+$/.test(r.limit_panel) ? Number(r.limit_panel) : null,
      // Panel credentials stay out of the row; secret_ref is wired up at deploy.
      JSON.stringify(t.legacyAttrs(r, claimed, ['password_panel'])),
    ]),
    { conflict: '(legacy_id)' },
  );
}

async function migrateProducts(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT * FROM product');
  const { rows: providers } = await ctx.pg.query<{ id: string; code: string }>(
    'SELECT id, code FROM provisioning_providers',
  );
  const byCode = new Map(providers.map((p) => [p.code, p.id]));

  const claimed = ['id', 'code_product', 'name_product', 'price_product',
                   'Location', 'Service_time', 'Volume_constraint', 'agent',
                   'one_buy_status', 'note'];

  const written = await insertBatch(
    ctx.pg, 'products',
    cols(['legacy_id', 'code', 'name', 'kind', 'provider_id', 'status',
          'description', 'once_per_user', 'resellers_only',
          ['attrs', (p) => `${p}::jsonb`]]),
    rows.map((r) => [
      Number(r.id),
      r.code_product ?? `product-${r.id}`,
      r.name_product ?? `product-${r.id}`,
      'vpn',
      byCode.get(r.Location ?? '') ?? null,
      'ACTIVE',
      r.note || null,
      r.one_buy_status === '1',
      r.agent === 'n',
      JSON.stringify(t.legacyAttrs(r, claimed)),
    ]),
    { conflict: '(legacy_id)' },
  );

  // Each legacy product row is one purchasable plan: price, duration, volume.
  const { rows: products } = await ctx.pg.query<{ id: string; legacy_id: number }>(
    'SELECT id, legacy_id FROM products WHERE legacy_id IS NOT NULL',
  );
  // String() on both sides: node-postgres returns int4 as a number while MySQL
  // returns it as a string, so a raw key would never match and every plan would
  // be silently skipped.
  const byLegacy = new Map(products.map((p) => [String(p.legacy_id), p.id]));

  await insertBatch(
    ctx.pg, 'product_plans',
    cols(['legacy_id', 'product_id', 'name', 'price_irr', 'duration_days', 'volume_gb']),
    rows.flatMap((r) => {
      const pid = byLegacy.get(String(r.id));
      if (!pid) return [];
      const days = Number(r.Service_time ?? 0);
      const gb = Number(r.Volume_constraint ?? 0);
      return [[
        Number(r.id), pid, r.name_product ?? `plan-${r.id}`,
        t.tomanToIrr(r.price_product).toString(),
        Number.isFinite(days) && days > 0 ? days : null,
        Number.isFinite(gb) && gb > 0 ? gb : null,
      ]];
    }),
    { conflict: '(legacy_id)' },
  );
  return written;
}

/**
 * Two legacy tables, one code namespace.
 *
 * `Discount` holds gift codes that credit the wallet — index.php:5841 does
 * `Balance + price`, so `price` is Toman. `DiscountSell` holds checkout
 * discounts where `price` is a PERCENTAGE — index.php:1795 does
 * `(price / 100) * price_product`. The same column name means two different
 * things in the two tables, which is why this is read from the code rather
 * than inferred from the values.
 *
 * Neither table has a unique index on its code, and production has both
 * duplicates within `DiscountSell` (33 rows, 12 distinct codes) and one code
 * present in both tables. A customer types one code and must get one answer,
 * so the new schema makes the code unique and this step picks a winner:
 * most-used first, then gift over sell, then oldest row. Every loser is
 * counted and reported rather than dropped quietly.
 */
async function migrateDiscounts(ctx: Ctx): Promise<number> {
  const gifts = await mysqlRows<Row>(ctx.my, 'SELECT * FROM Discount');
  const sells = await mysqlRows<Row>(ctx.my, 'SELECT * FROM DiscountSell');

  interface Candidate {
    code: string; uses: number; giftFirst: number; legacyId: number;
    values: unknown[];
  }
  const candidates: Candidate[] = [];

  for (const r of gifts) {
    if (!r.code) { skip(ctx, 'discount codes: row has no code'); continue; }
    const limit = Number(r.limituse ?? 0);
    candidates.push({
      code: r.code, uses: Number(r.limitused ?? 0), giftFirst: 0, legacyId: Number(r.id),
      // A NULL price credits nothing: PHP adds NULL, which is 0. Reproduced,
      // not repaired — the row stays visible instead of vanishing.
      values: ['Discount', Number(r.id), r.code, 'GIFT_BALANCE',
               t.tomanToIrr(r.price).toString(), null,
               Number.isFinite(limit) && limit > 0 ? limit : null, false, false],
    });
  }

  for (const r of sells) {
    if (!r.codeDiscount) { skip(ctx, 'discount codes: row has no code'); continue; }
    const limit = Number(r.limitDiscount ?? 0);
    const percent = Number(r.price ?? 0);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      skip(ctx, 'discount codes: percentage outside 0-100');
      continue;
    }
    candidates.push({
      code: r.codeDiscount, uses: Number(r.usedDiscount ?? 0), giftFirst: 1,
      legacyId: Number(r.id),
      values: ['DiscountSell', Number(r.id), r.codeDiscount, 'PERCENT_OFF',
               null, percent,
               Number.isFinite(limit) && limit > 0 ? limit : null,
               r.usefirst === '1', r.agent === 'n'],
    });
  }

  const winners = new Map<string, Candidate>();
  for (const c of candidates) {
    const held = winners.get(c.code);
    if (!held) { winners.set(c.code, c); continue; }
    const better =
      c.uses !== held.uses ? c.uses > held.uses
      : c.giftFirst !== held.giftFirst ? c.giftFirst < held.giftFirst
      : c.legacyId < held.legacyId;
    if (better) winners.set(c.code, c);
    skip(ctx, `discount codes: duplicate of "${c.code}" collapsed`);
  }

  let n = await insertBatch(
    ctx.pg, 'discount_codes',
    cols(['legacy_table', 'legacy_id', 'code', 'kind', 'amount_irr', 'percent',
          'max_uses', 'first_purchase_only', 'resellers_only']),
    [...winners.values()].map((c) => c.values),
    { conflict: '(legacy_table, legacy_id)' },
  );

  const { rows: codes } = await ctx.pg.query<{ id: string; code: string }>(
    'SELECT id, code FROM discount_codes',
  );
  const byCode = new Map(codes.map((c) => [c.code, c.id]));

  const consumed = await mysqlRows<Row>(ctx.my, 'SELECT * FROM Giftcodeconsumed');
  n += await insertBatch(
    ctx.pg, 'discount_redemptions',
    cols(['legacy_id', 'code_id', 'user_id']),
    consumed.flatMap((r) => {
      const codeId = byCode.get(r.code ?? '');
      const u = user(ctx, r.id_user);
      if (!codeId) { skip(ctx, 'redemptions: code deleted'); return []; }
      if (!u) { skip(ctx, 'redemptions: user deleted'); return []; }
      return [[Number(r.id), codeId, u]];
    }),
    { conflict: '(legacy_id)' },
  );
  return n;
}

async function migrateSubscriptions(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT * FROM invoice');
  const { rows: providers } = await ctx.pg.query<{ id: string; name: string }>(
    'SELECT id, name FROM provisioning_providers',
  );
  const byName = new Map(providers.map((p) => [p.name, p.id]));

  const claimed = ['id_invoice', 'id_user', 'username', 'Service_location',
                   'time_sell', 'name_product', 'price_product', 'Volume',
                   'Service_time', 'uuid', 'note', 'notifctions', 'refral', 'Status'];

  return insertBatch(
    ctx.pg, 'subscriptions',
    cols([
      'public_id', 'user_id', 'provider_id', 'provider_name_at_sale',
      'plan_name_at_sale', 'price_irr', ['remote_ref', (p) => `${p}::jsonb`],
      'remote_username', 'volume_gb', 'duration_days', 'status', 'legacy_status',
      ['notify', (p) => `${p}::jsonb`], 'referral_code', 'note',
      ['purchased_at', ts.epochS.expr], ['legacy_attrs', (p) => `${p}::jsonb`],
    ]),
    rows.flatMap((r) => {
      const u = user(ctx, r.id_user);
      if (!u) { skip(ctx, 'subscriptions: user deleted'); return []; }
      const gb = Number(r.Volume ?? 0);
      const days = Number(r.Service_time ?? 0);
      return [[
        r.id_invoice, u,
        byName.get(r.Service_location ?? '') ?? null,
        r.Service_location,
        r.name_product ?? '(unknown product)',
        t.tomanToIrr(r.price_product).toString(),
        JSON.stringify(t.json(r.uuid)),
        r.username || null,
        Number.isFinite(gb) && gb > 0 ? gb : null,
        Number.isFinite(days) && days > 0 ? days : null,
        t.subscriptionStatus(r.Status), r.Status,
        JSON.stringify(t.json(r.notifctions)),
        r.refral && r.refral !== '0' ? r.refral : null,
        r.note || null,
        t.epochSeconds(r.time_sell, 'invoice.time_sell'),
        JSON.stringify(t.legacyAttrs(r, claimed)),
      ]];
    }),
    { conflict: '(public_id)' },
  );
}

async function migratePayments(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT * FROM Payment_report');
  return insertBatch(
    ctx.pg, 'payments',
    cols([
      'legacy_id', 'public_id', 'user_id', 'legacy_telegram_id', 'amount_irr',
      'method', 'legacy_method', 'status', 'reject_reason',
      'assigned_card_number', 'assigned_card_name', 'operation_type',
      'legacy_step_token', 'telegram_message_id',
      ['created_at', ts.tehran.expr], ['updated_at', ts.tehran.expr],
    ]),
    rows.map((r) => {
      const step = t.stepToken(r.id_invoice);
      const card = t.cardDigits(r.assigned_card_number);
      return [
        Number(r.id),
        // 22 rows carry no order id; the legacy row id keeps them addressable.
        r.id_order || `legacy-payment-${r.id}`,
        user(ctx, r.id_user),
        t.telegramId(r.id_user).toString(),
        t.tomanToIrr(r.price).toString(),
        t.paymentMethod(r.Payment_Method), r.Payment_Method,
        t.paymentStatus(r.payment_Status),
        r.dec_not_confirmed || null,
        card ? correctCardDigits(card) : null,
        r.assigned_card_name || null,
        step.operationType, step.raw,
        r.message_id ? Number(r.message_id) : null,
        t.tehranString(r.time, 'Payment_report.time'),
        t.tehranString(r.at_updated, 'Payment_report.at_updated'),
      ];
    }),
    { conflict: '(legacy_id)' },
  );
}

/** service_other rows are renewals and add-ons: orders without a subscription link. */
async function migrateServiceOrders(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT * FROM service_other');
  return insertBatch(
    ctx.pg, 'orders',
    cols([
      'legacy_ref', 'public_id', 'user_id', 'kind', 'quantity',
      'unit_price_irr', 'discount_irr', 'total_irr', 'status',
      ['created_at', ts.tehran.expr],
    ]),
    rows.flatMap((r) => {
      const u = user(ctx, r.id_user);
      if (!u) { skip(ctx, 'orders: user deleted'); return []; }
      const amount = t.tomanToIrr(r.price).toString();
      return [[
        `service_other:${r.id}`, `so-${r.id}`, u,
        t.orderKind(r.type), 1, amount, 0, amount,
        r.status === 'paid' ? 'COMPLETED'
          : r.status === 'unpaid' ? 'AWAITING_PAYMENT'
          : 'COMPLETED', // blank status rows all carry a provisioning output
        t.tehranString(r.time, 'service_other.time'),
      ]];
    }),
    { conflict: '(legacy_ref)' },
  );
}

async function migrateCardLeases(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT * FROM card_assignment_leases');
  return insertBatch(
    ctx.pg, 'card_leases',
    cols([
      'legacy_id', 'telegram_user_id', 'order_public_id', 'card_number',
      'card_name', 'status', ['assigned_at', ts.epochS.expr],
      ['expires_at', ts.epochS.expr], ['completed_at', ts.epochS.expr],
      ['released_at', ts.epochS.expr], ['created_at', ts.epochS.expr],
      ['updated_at', ts.epochS.expr],
    ]),
    rows.map((r) => {
      const card = t.cardDigits(r.card_number);
      return [
        Number(r.id), t.telegramId(r.telegram_user_id).toString(),
        r.order_id, card ? correctCardDigits(card) : r.card_number,
        r.card_name ?? '', t.leaseStatus(r.status),
        t.epochSeconds(r.assigned_at, 'lease.assigned_at'),
        t.epochSeconds(r.expires_at, 'lease.expires_at'),
        r.completed_at ? t.epochSeconds(r.completed_at, 'lease.completed_at') : null,
        r.released_at ? t.epochSeconds(r.released_at, 'lease.released_at') : null,
        t.epochSeconds(r.created_at, 'lease.created_at'),
        t.epochSeconds(r.updated_at, 'lease.updated_at'),
      ];
    }),
    { conflict: '(legacy_id)' },
  );
}

async function migrateOps(ctx: Ctx): Promise<number> {
  let n = 0;

  n += await insertBatch(
    ctx.pg, 'support_departments', cols(['legacy_id', 'name', 'telegram_id']),
    (await mysqlRows<Row>(ctx.my, 'SELECT * FROM departman')).map((r) => [
      Number(r.id), r.name_departman ?? `dept-${r.id}`,
      r.idsupport && /^\d+$/.test(r.idsupport) ? r.idsupport : null,
    ]),
    { conflict: '(legacy_id)' },
  );

  const { rows: depts } = await ctx.pg.query<{ id: string; legacy_id: string }>(
    'SELECT id, legacy_id FROM support_departments WHERE legacy_id IS NOT NULL',
  );
  const deptByName = new Map(
    (await mysqlRows<Row>(ctx.my, 'SELECT * FROM departman')).map((r) => [
      r.name_departman ?? '',
      depts.find((d) => d.legacy_id === String(r.id))?.id ?? null,
    ]),
  );

  const tickets = await mysqlRows<Row>(ctx.my, 'SELECT * FROM support_message');
  n += await insertBatch(
    ctx.pg, 'support_tickets',
    cols(['legacy_id', 'tracking_code', 'user_id', 'department_id', 'status',
          ['created_at', ts.tehran.expr]]),
    tickets.flatMap((r) => {
      const u = user(ctx, r.iduser);
      if (!u) { skip(ctx, 'support tickets: user deleted'); return []; }
      const status = r.status === 'Answered' ? 'ANSWERED'
        : r.status === 'Pending' ? 'PENDING'
        : r.status === 'Customerresponse' ? 'CUSTOMER_REPLIED'
        : r.status === 'close' ? 'CLOSED' : 'OPEN';
      return [[Number(r.id), r.Tracking ?? `ticket-${r.id}`, u,
               deptByName.get(r.name_departman ?? '') ?? null, status,
               t.tehranString(r.time, 'support_message.time')]];
    }),
    { conflict: '(legacy_id)' },
  );

  // The legacy row holds the question and the answer in two columns; the thread
  // becomes real messages so a third reply has somewhere to go.
  const { rows: ticketIds } = await ctx.pg.query<{ id: string; legacy_id: string }>(
    'SELECT id, legacy_id FROM support_tickets WHERE legacy_id IS NOT NULL',
  );
  const ticketByLegacy = new Map(ticketIds.map((x) => [x.legacy_id, x.id]));
  // A split row has no legacy key of its own to conflict on, so idempotency
  // here is per ticket: a ticket that already has messages is left alone.
  for (const r of tickets) {
    const tid = ticketByLegacy.get(String(r.id));
    if (!tid) continue;
    const { rows: has } = await ctx.pg.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM support_messages WHERE ticket_id = $1', [tid],
    );
    if (Number(has[0]?.n ?? 0) > 0) continue;
    for (const [author, body] of [['USER', r.text], ['ADMIN', r.result]] as const) {
      if (!body) continue;
      await ctx.pg.query(
        'INSERT INTO support_messages (ticket_id, author_type, body) VALUES ($1,$2,$3)',
        [tid, author, body],
      );
      n++;
    }
  }

  n += await insertBatch(
    ctx.pg, 'help_articles',
    cols(['legacy_id', 'title', 'category', 'body', 'media_id', 'media_type']),
    (await mysqlRows<Row>(ctx.my, 'SELECT * FROM help')).map((r) => [
      Number(r.id), r.name_os ?? `help-${r.id}`, r.category || null,
      r.Description_os ?? '', r.Media_os || null, r.type_Media_os || null,
    ]),
    { conflict: '(legacy_id)' },
  );

  n += await insertBatch(
    ctx.pg, 'client_apps', cols(['legacy_id', 'name', 'link']),
    (await mysqlRows<Row>(ctx.my, 'SELECT * FROM app')).map((r) => [
      Number(r.id), r.name ?? `app-${r.id}`, r.link ?? '',
    ]),
    { conflict: '(legacy_id)' },
  );

  n += await insertBatch(
    ctx.pg, 'required_channels', cols(['title', 'chat_ref', 'join_link']),
    (await mysqlRows<Row>(ctx.my, 'SELECT * FROM channels')).flatMap((r) =>
      r.link ? [[r.remark ?? r.link, r.link, r.linkjoin ?? r.link]] : [],
    ),
    { conflict: '(chat_ref)' },
  );

  n += await insertBatch(
    ctx.pg, 'wheel_spins',
    cols(['legacy_id', 'user_id', 'prize_code', 'amount_irr', ['created_at', ts.tehran.expr]]),
    (await mysqlRows<Row>(ctx.my, 'SELECT * FROM wheel_list')).flatMap((r) => {
      const u = user(ctx, r.id_user);
      if (!u) { skip(ctx, 'wheel spins: user deleted'); return []; }
      return [[Number(r.id), u, r.wheel_code ?? '',
               t.tomanToIrr(r.price).toString(),
               t.tehranString(r.time, 'wheel_list.time')]];
    }),
    { conflict: '(legacy_id)' },
  );

  n += await insertBatch(
    ctx.pg, 'reseller_requests',
    cols(['legacy_id', 'user_id', 'description', 'kind', 'status',
          ['created_at', ts.epochS.expr]]),
    (await mysqlRows<Row>(ctx.my, 'SELECT * FROM Requestagent')).flatMap((r) => {
      const u = user(ctx, r.id);
      if (!u) { skip(ctx, 'reseller requests: user deleted'); return []; }
      const status = r.status === 'accept' ? 'APPROVED'
        : r.status === 'reject' ? 'REJECTED' : 'PENDING';
      return [[r.id, u, r.Description || null, r.type || null, status,
               t.epochSeconds(r.time, 'Requestagent.time')]];
    }),
    { conflict: '(legacy_id)' },
  );

  n += await insertBatch(
    ctx.pg, 'revenue_adjustments',
    cols(['legacy_id', 'amount_irr', 'note', 'created_by',
          ['created_at', ts.tehran.expr]]),
    (await mysqlRows<Row>(ctx.my, 'SELECT * FROM revenue_adjustment_log')).map((r) => {
      // `type` decides the sign; `amount` is stored unsigned.
      const magnitude = t.tomanToIrr(r.amount);
      return [Number(r.id),
              (r.type === 'subtract' ? -magnitude : magnitude).toString(),
              r.note ?? '', r.created_by || null,
              t.tehranString(r.created_at, 'revenue_adjustment_log.created_at')];
    }),
    { conflict: '(legacy_id)' },
  );

  return n;
}

// ---------------------------------------------------------------------------
// payment hub (D1 export)
// ---------------------------------------------------------------------------

/** Copies a D1 table straight across, taking only the columns Postgres has. */
async function copyD1(
  ctx: Ctx, table: string, columnNames: readonly string[], conflict: string,
): Promise<number> {
  const rows = d1Table<Record<string, unknown>>(ctx.cfg, table);
  if (rows.length === 0) return 0;
  return insertBatch(
    ctx.pg, table, cols([...columnNames]),
    rows.map((r) =>
      columnNames.map((c) => {
        const v = r[c] ?? null;
        if (!t.HUB_EPOCH_COLUMNS.has(c)) return v;
        const millis = t.hubEpochMillis(v, `${table}.${c}`);
        if (millis !== null && typeof v !== 'number') {
          skip(ctx, `${table}.${c}: datetime string normalised to epoch millis`);
        }
        return millis;
      }),
    ),
    { conflict },
  );
}

/** Each entry is [table, columns, conflict target]; most key on `id`. */
const D1_TABLES: [table: string, columns: string[], conflict?: string][] = [
  ['access_users', ['id', 'email', 'display_name', 'role', 'active', 'created_at', 'updated_at']],
  ['devices', ['id', 'device_code', 'display_name', 'description', 'active',
               'last_seen_at', 'last_success_at', 'last_auth_failure_at',
               'created_at', 'updated_at']],
  ['device_credentials', ['id', 'device_id', 'token_hash', 'token_prefix', 'status',
                          'created_at', 'activated_at', 'revoked_at', 'last_used_at']],
  ['financial_accounts', ['id', 'bank_name', 'display_name', 'owner_label',
                          'account_type', 'account_hint', 'card_last_four',
                          'account_last_four', 'iban', 'device_id', 'active',
                          'status', 'parser_configuration', 'created_at', 'updated_at']],
  ['financial_account_identifiers', ['id', 'financial_account_id', 'kind', 'value',
                                     'label', 'created_at']],
  ['raw_sms_events', ['id', 'device_id', 'sender', 'encrypted_or_protected_body',
                      'normalized_body', 'body_sha256', 'app_checksum',
                      'sms_timestamp', 'received_at', 'classification',
                      'parser_status', 'parser_id', 'parser_version',
                      'duplicate_of', 'processing_error', 'created_at']],
  ['transaction_candidates', ['id', 'raw_sms_event_id', 'financial_account_id',
                              'direction', 'amount_irr', 'balance_irr',
                              'transaction_reference', 'bank_timestamp', 'confidence',
                              'parser_id', 'parser_version', 'parser_evidence_json',
                              'status', 'processing_disposition', 'created_at', 'updated_at']],
  ['payment_claims', ['id', 'external_order_id', 'customer_reference',
                      'expected_amount_irr', 'target_financial_account_id',
                      'card_digits', 'submitted_at', 'paid_clicked_at',
                      'receipt_submitted_at', 'receipt_url_or_r2_key',
                      'source_system', 'metadata_json', 'suspect_reason',
                      'suspect_metadata_json', 'operation_type', 'purchase_type',
                      'status', 'created_at', 'updated_at']],
  ['reconciliation_matches', ['id', 'transaction_candidate_id', 'payment_claim_id',
                              'score', 'matching_reasons_json', 'mismatch_reasons_json',
                              'status', 'reviewed_by', 'reviewed_at',
                              'created_at', 'updated_at']],
  ['transaction_detected_identifiers', ['id', 'transaction_candidate_id',
                                        'identifier_type', 'normalized_value',
                                        'display_value_masked', 'parser_id',
                                        'confidence', 'created_at']],
  ['transaction_reviews', ['id', 'transaction_candidate_id', 'decision', 'reviewed_by',
                           'reviewer_role', 'reason', 'comment', 'reviewed_at',
                           'created_at', 'updated_at']],
  ['transaction_account_assignments', ['id', 'transaction_candidate_id',
                                       'financial_account_id', 'assignment_source',
                                       'identifier_type', 'normalized_identifier',
                                       'assigned_by', 'assigned_at',
                                       'replaced_assignment_id', 'active', 'metadata_json']],
  ['audit_logs', ['id', 'actor_email', 'actor_role', 'action', 'entity_type',
                  'entity_id', 'before_json', 'after_json', 'reason', 'request_id',
                  'created_at']],
  ['comments', ['id', 'entity_type', 'entity_id', 'author_email', 'author_role',
                'body', 'created_at']],
  ['integration_tokens', ['id', 'token_hash', 'token_prefix', 'label', 'status',
                          'created_at', 'revoked_at', 'last_used_at']],
  ['integration_events', ['event_id', 'source', 'external_order_id', 'processed_at'],
   '(event_id)'],
  ['webhook_deliveries', ['id', 'event_type', 'payload_json', 'attempt_count',
                          'last_response_status', 'last_response_body',
                          'last_attempt_at', 'next_attempt_at', 'status']],
  ['resellers', ['id', 'name', 'status', 'created_at', 'updated_at']],
  ['reseller_transactions', ['id', 'transaction_candidate_id', 'reseller_id',
                             'classified_by', 'classified_at', 'note', 'created_at']],
  ['income_declined_transactions', ['id', 'transaction_candidate_id', 'declined_by',
                                    'declined_at', 'reason', 'restored_by',
                                    'restored_at', 'created_at']],
  ['account_assignment_previews', ['id', 'financial_account_id', 'actor_email',
                                   'status', 'account_snapshot_json', 'counts_json',
                                   'created_at', 'expires_at', 'result_json',
                                   'applied_at', 'declined_at', 'audit_log_id']],
  ['account_assignment_preview_items', ['id', 'preview_id', 'transaction_candidate_id',
                                        'disposition', 'identifier_type',
                                        'normalized_identifier', 'current_account_id',
                                        'current_assignment_source', 'tx_snapshot_json',
                                        'selected', 'applied_disposition',
                                        'applied_assignment_id']],
];

async function migrateHub(ctx: Ctx): Promise<number> {
  let n = 0;
  for (const [table, columns, conflict] of D1_TABLES) {
    n += await copyD1(ctx, table, columns, conflict ?? '(id)');
  }
  n += await copyD1(ctx, 'dashboard_notification_state',
    ['actor_email', 'last_seen_transaction_at', 'last_seen_transaction_id', 'updated_at'],
    '(actor_email)');
  n += await copyD1(ctx, 'dashboard_transaction_reads',
    ['actor_email', 'transaction_candidate_id', 'seen_at'],
    '(actor_email, transaction_candidate_id)');
  n += await copyD1(ctx, 'dashboard_payment_event_reads',
    ['actor_email', 'event_key', 'seen_at'], '(actor_email, event_key)');
  return n;
}

/**
 * Merges the two card lists into one table.
 *
 * The hub rows arrive first because `financial_account_id` is NOT NULL and only
 * the hub knows it. A bot card with no hub counterpart cannot be written
 * without inventing a bank account, so it is skipped and reported instead.
 */
async function migrateCards(ctx: Ctx): Promise<number> {
  const hub = d1Table<{
    id: string; financial_account_id: string; card_digits: string;
    label: string | null; created_at: number;
  }>(ctx.cfg, 'payment_cards');

  const written = await insertBatch(
    ctx.pg, 'payment_cards',
    cols(['id', 'financial_account_id', 'card_digits', 'label', 'created_at']),
    hub.map((c) => [c.id, c.financial_account_id,
                    correctCardDigits(c.card_digits), c.label, c.created_at]),
    { conflict: '(id)' },
  );

  const bot = await mysqlRows<Row>(ctx.my, 'SELECT * FROM card_number');
  for (const r of bot) {
    const digits = t.cardDigits(r.cardnumber);
    if (!digits) continue;
    const res = await ctx.pg.query(
      `UPDATE payment_cards
          SET holder_name = COALESCE($2, holder_name),
              status = $3,
              last_assigned_at = COALESCE($4, last_assigned_at)
        WHERE card_digits = $1`,
      [correctCardDigits(digits), r.namecard || null,
       r.status === 'active' ? 'ACTIVE' : 'DISABLED',
       r.last_assigned_at ? Number(r.last_assigned_at) : null],
    );
    if ((res.rowCount ?? 0) === 0) skip(ctx, 'cards: bot card with no hub account');
  }
  return written;
}

// ===========================================================================

const STEPS: [name: string, run: (ctx: Ctx) => Promise<number>][] = [
  ['users', migrateUsers],
  ['referrals', migrateReferrals],
  ['wallets', migrateWallets],
  ['settings', migrateSettings],
  ['admins', migrateAdmins],
  ['providers', migrateProviders],
  ['products + plans', migrateProducts],
  ['discounts', migrateDiscounts],
  ['subscriptions', migrateSubscriptions],
  ['payments', migratePayments],
  ['orders (service_other)', migrateServiceOrders],
  ['payment hub (D1)', migrateHub],
  ['bank cards (merged)', migrateCards],
  ['card leases', migrateCardLeases],
  ['support, content, promos', migrateOps],
];

export async function migrate(cfg: Config, my: Connection, pgc: pg.Client): Promise<void> {
  const ctx: Ctx = { cfg, my, pg: pgc, userId: new Map(), skipped: new Map() };

  report.title('migrating');
  await pgc.query('BEGIN');
  try {
    for (const [name, run] of STEPS) {
      const started = Date.now();
      const written = await run(ctx);
      const ms = Date.now() - started;
      const note = written === 0 ? 'already present' : `${written} row(s) written`;
      report.ok(`${name.padEnd(26)} ${note}  ${String(ms).padStart(5)}ms`);
    }
    await pgc.query('COMMIT');
  } catch (err) {
    await pgc.query('ROLLBACK');
    report.fail('rolled back — nothing was written');
    throw err;
  }

  if (ctx.skipped.size > 0) {
    report.title('skipped (parent row no longer exists)');
    for (const [what, n] of [...ctx.skipped].sort((a, b) => b[1] - a[1])) {
      report.warn(`${n} ${what}`);
    }
  }
}
