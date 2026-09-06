/**
 * قفسهٔ انبار — the pre-made configs that keep the shop selling when a panel is
 * unreachable.
 *
 * `migrations/0010_provisioning_stock.sql` built the shelf and the bot has sold
 * from it since; `docs/STATUS.md` has said "no interface for filling it" ever
 * since, and filling it meant an `INSERT` by hand. This is that interface.
 *
 * The shelf is the one place in this platform where the ROW is the product: a
 * `subscription_url` here is a working account somebody paid for the moment it
 * is handed over. So three things are true of every route below.
 *
 * **A sold row is never edited or removed.** `status = 'USED'` names the order
 * that took it, and `subscriptions` points at the same account — deleting the
 * shelf row would leave the customer's service with no record of where it came
 * from. Retiring is the action for a config that must not be sold again;
 * deletion is only ever for one that never was.
 *
 * **The plan decides the panel.** `provider_id` is not a form field: the shelf
 * hands a config to an order for a specific plan, and a config filed under a
 * plan whose product lives on a different panel is a customer receiving an
 * account on a server they did not buy. It is read from the plan's own product.
 *
 * **The database decides duplicates.** `idx_stock_account_once` refuses the same
 * `(provider_id, remote_username)` twice, and the insert lets it answer rather
 * than looking first — two admins pasting the same export at once is exactly the
 * case a read-then-write misses.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import { checkRemoteUsername, isAutomated } from '@shikoo/domain';
import { MAX_SINGLE_PAYMENT_IRR } from '@shikoo/contracts';
import { audit, type Ident } from './adminAudit.js';
import { checkNameEmoji } from './customEmojiNames.js';
import { createLogger } from '@shikoo/domain';

const log = createLogger('dashboard');

const StockBody = z
  .object({
    planId: z.number().int().positive(),
    remoteUsername: z.string().trim().min(1).max(200),
    subscriptionUrl: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .refine((v) => /^https?:\/\//i.test(v), 'لینک اشتراک باید با http یا https شروع شود'),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

const BulkStockBody = z
  .object({
    planId: z.number().int().positive(),
    text: z.string().min(1).max(200_000),
  })
  .strict();

/** One shelf-load per request keeps the failure story simple. */
const BULK_MAX_LINES = 1000;

/**
 * A pasted field, with the quotes a spreadsheet puts around it removed.
 *
 * Not a CSV parser and not trying to be: the format here is one separator per
 * line and everything after it is the credential, so the only thing quoting
 * changes is that `"user","pass"` would otherwise be shelved WITH its quotes
 * and handed to a customer that way. A quote in the middle of a password is
 * left exactly where it is.
 */
function unquote(field: string): string {
  const v = field.trim();
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"')
    ? v.slice(1, -1).replace(/""/g, '"').trim()
    : v;
}

/** The column names a spreadsheet export puts on its first line. */
function looksLikeHeader(username: string, credential: string): boolean {
  const a = username.toLowerCase();
  const b = credential.toLowerCase();
  const names = ['username', 'user', 'email', 'login', 'account', 'نام کاربری', 'یوزرنیم'];
  const creds = ['password', 'pass', 'secret', 'url', 'link', 'subscription', 'گذرواژه', 'رمز'];
  return names.includes(a) && creds.some((c) => b === c || b.replace(/[_\s-]/g, '') === c);
}

/**
 * Everything a shelf needs to exist, asked as the two things it actually is:
 * a name and a price.
 *
 * A shelf is a plan, and a plan needs a product, and a product needs a panel.
 * That is three screens to reach one «قفسهٔ اسپاتیفای», and the two middle
 * steps ask about panels and services — machinery that has nothing to do with
 * a box of accounts. This route builds the whole chain from a name.
 */
const ShelfCreate = z
  .object({
    name: z.string().trim().min(1).max(120),
    // What is being SOLD, which is labelling — the delivery route is decided by
    // the panel below, and this route always makes that panel `manual`.
    kind: z.enum(['vpn', 'ai_account', 'spotify', 'manual', 'other']).default('other'),
    // One rial, not zero. `placeOrder` refuses `totalIrr <= 0` outright
    // (`apps/bot/src/order.ts:304`), so a free shelf draws every button in the
    // shop and then does nothing when the customer taps «خرید» — an operator
    // fills it and waits for a sale that cannot happen.
    priceIrr: z.number().int().min(1).max(MAX_SINGLE_PAYMENT_IRR),
    durationDays: z.number().int().positive().max(3650).nullable().default(null),
    categoryId: z.number().int().positive(),
  })
  .strict();

const StockQuery = z.object({
  planId: z.coerce.number().int().positive().optional(),
  status: z.enum(['AVAILABLE', 'USED', 'RETIRED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

interface StockRow {
  id: number;
  plan_id: number;
  plan_name: string;
  product_name: string;
  provider_name: string;
  remote_username: string;
  subscription_url: string | null;
  secret: string | null;
  status: string;
  order_public_id: string | null;
  note: string | null;
  created_at: string;
  used_at: string | null;
}

/**
 * The subscription link is a live credential: whoever holds it holds the
 * service. It is returned only for a row that is still on the shelf, and only
 * to an ADMIN — a REVIEWER counting stock does not need to be handed the
 * accounts, and a sold row's link belongs to the customer who bought it.
 * A password (0057) is the same kind of thing and gets the same gate.
 */
function shape(r: StockRow, withUrl: boolean) {
  return {
    id: Number(r.id),
    planId: Number(r.plan_id),
    planName: r.plan_name,
    productName: r.product_name,
    providerName: r.provider_name,
    remoteUsername: r.remote_username,
    subscriptionUrl: withUrl && r.status === 'AVAILABLE' ? r.subscription_url : null,
    secret: withUrl && r.status === 'AVAILABLE' ? r.secret : null,
    status: r.status,
    orderPublicId: r.order_public_id,
    note: r.note,
    createdAt: r.created_at,
    usedAt: r.used_at,
  };
}

const SELECT_STOCK = `
  SELECT st.id, st.plan_id, st.remote_username, st.subscription_url, st.secret, st.status,
         st.note, st.created_at, st.used_at,
         pl.name AS plan_name, p.name AS product_name, pr.name AS provider_name,
         o.public_id AS order_public_id
    FROM provisioning_stock st
    JOIN product_plans pl ON pl.id = st.plan_id
    JOIN products p ON p.id = pl.product_id
    JOIN provisioning_providers pr ON pr.id = st.provider_id
    LEFT JOIN orders o ON o.id = st.order_id`;

export function registerStockRoutes(
  app: Hono<{ Bindings: { DB: D1Database }; Variables: { identity: Ident } }>,
) {
  app.get('/api/v1/admin/stock', async (c) => {
    const q = StockQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!q.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    const ident = c.get('identity');

    const where: string[] = [];
    const binds: unknown[] = [];
    if (q.data.planId !== undefined) {
      binds.push(q.data.planId);
      where.push(`st.plan_id = ?${binds.length}`);
    }
    if (q.data.status !== undefined) {
      binds.push(q.data.status);
      where.push(`st.status = ?${binds.length}`);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

    const total = await c.env.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM provisioning_stock st${clause}`,
    )
      .bind(...binds)
      .first<{ n: number }>();

    binds.push(q.data.pageSize, (q.data.page - 1) * q.data.pageSize);
    const rows = await c.env.DB.prepare(
      `${SELECT_STOCK}${clause} ORDER BY st.status, st.id DESC
        LIMIT ?${binds.length - 1} OFFSET ?${binds.length}`,
    )
      .bind(...binds)
      .all<StockRow>();

    // What an admin actually needs from this screen: how deep the shelf is per
    // plan. Counting rows on the page would count the page, not the shelf.
    //
    // Counted FROM the plans, not from the rows. Started from
    // `provisioning_stock`, an empty shelf was not a shelf with a zero on it —
    // it was absent, so a product whose accounts had never been loaded appeared
    // nowhere, and the «قفسه خالی است» warning below could only ever fire for a
    // shelf that had once been full. A plan that sells from the shelf is a
    // shelf on the day it is created.
    //
    // Which plans those are: any on a panel with no automated adapter — the
    // account kinds — plus any that already holds stock, which is how a VPN
    // panel's outage shelf keeps its row.
    const counts = await c.env.DB.prepare(
      `SELECT pl.id AS plan_id, pl.name AS plan_name, p.name AS product_name,
              pr.kind AS provider_kind,
              COUNT(st.id) FILTER (WHERE st.status = 'AVAILABLE')::int AS available,
              COUNT(st.id) FILTER (WHERE st.status = 'USED')::int AS used
         FROM product_plans pl
         JOIN products p ON p.id = pl.product_id
         LEFT JOIN provisioning_providers pr ON pr.id = p.provider_id
         LEFT JOIN provisioning_stock st ON st.plan_id = pl.id
        -- A switched-off plan that still HOLDS stock stays on the list: those
        -- rows are real inventory and hiding them is how an admin stops seeing
        -- accounts they have already paid for.
        WHERE st.id IS NOT NULL
           OR (pl.status <> 'DISABLED' AND p.status <> 'DISABLED')
        GROUP BY pl.id, pl.name, p.name, pr.kind
        ORDER BY available, pl.name`,
    ).all<{
      plan_id: number;
      plan_name: string;
      product_name: string;
      provider_kind: string | null;
      available: number;
      used: number;
    }>();

    return c.json({
      ok: true,
      total: total?.n ?? 0,
      page: q.data.page,
      pageSize: q.data.pageSize,
      items: (rows.results ?? []).map((r) => shape(r, ident.role === 'ADMIN')),
      shelves: (counts.results ?? [])
        // A shelf is a plan that sells from one: every plan on a panel with no
        // automated adapter, plus any plan that already holds stock — which is
        // how a VPN panel's outage shelf keeps its row. Asked through
        // `isAutomated` rather than a list of kinds spelled again in SQL.
        .filter((r) => !isAutomated(r.provider_kind ?? '') || r.available + r.used > 0)
        .map((r) => ({
          planId: Number(r.plan_id),
          planName: r.plan_name,
          productName: r.product_name,
          available: Number(r.available),
          used: Number(r.used),
        })),
    });
  });

  /**
   * Builds a shelf: «قفسهٔ اسپاتیفای», «قفسهٔ OpenVPN», whatever is in the box.
   *
   * Three rows, because that is what a sellable shelf is made of — a panel, a
   * service on it, and one product under that — and one transaction, because
   * two of the three on their own are litter nobody can see or delete from the
   * shelf screen.
   *
   * **The panel is per-shelf, and that is not tidiness.**
   * `idx_stock_account_once` is `(provider_id, remote_username)`, so two
   * shelves sharing a panel could not both hold `sam@example.com` — and the
   * same address having a Spotify account and a ChatGPT account is the ordinary
   * case, not the strange one. One panel per shelf is what keeps those apart.
   *
   * Its kind is `manual`: no adapter, so `provision.ts` reaches for the shelf
   * first and hands the account over. A kind with an adapter would try to
   * provision on a panel that does not exist.
   */
  app.post('/api/v1/admin/stock/shelves', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = ShelfCreate.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }
    const b = body.data;

    // The shelf's name is written into all three tables and the panel's copy
    // reaches the customer through `PLAN_LOCATION`, so it gets the same check
    // every other customer-facing name in this panel gets.
    const nameProblem = await checkNameEmoji(c.env.DB, b.name);
    if (nameProblem) return c.json({ ok: false, error: 'invalid_body', detail: nameProblem }, 400);

    // Refused here as well as by the foreign key, because the message matters:
    // a shelf with no category has no button on any screen in the shop.
    const category = await c.env.DB.prepare(`SELECT id FROM product_categories WHERE id = ?1`)
      .bind(b.categoryId)
      .first<{ id: number }>();
    if (!category) return c.json({ ok: false, error: 'category_not_found' }, 404);

    // The codes are ours, not the operator's. They must be lowercase-and-dashed
    // for the panel, and a Persian name slugs to nothing — so they are derived
    // from a uuid and never shown.
    const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
    const code = `shelf-${suffix}`;

    let planId: number | null = null;
    try {
      await c.env.DB.withSession(async (tx) => {
        const provider = await tx
          .prepare(
            `INSERT INTO provisioning_providers (code, name, kind, status)
             VALUES (?1, ?2, 'manual', 'ACTIVE') RETURNING id`,
          )
          .bind(code, b.name)
          .first<{ id: number }>();
        const product = await tx
          .prepare(
            `INSERT INTO products (code, name, kind, provider_id, category_id, status)
             VALUES (?1, ?2, ?3, ?4, ?5, 'ACTIVE') RETURNING id`,
          )
          .bind(code, b.name, b.kind, provider!.id, b.categoryId)
          .first<{ id: number }>();
        // Named after the shelf, not «یک‌ماهه»: the screen shows the service
        // above the plan and hides the plan when they match, so one shelf reads
        // as one line. A second plan added later is what makes it two.
        const plan = await tx
          .prepare(
            `INSERT INTO product_plans (product_id, name, price_irr, duration_days, status)
             VALUES (?1, ?2, ?3, ?4, 'ACTIVE') RETURNING id`,
          )
          .bind(product!.id, b.name, b.priceIrr, b.durationDays)
          .first<{ id: number }>();
        planId = Number(plan!.id);
      });
    } catch (err) {
      // Logged, not swallowed. The message tells the operator to retry, and a
      // uuid collision — the one failure that is genuinely worth retrying —
      // really is fixed by drawing another. Everything else that can land here
      // is not: a pool timeout, a category deleted between the check above and
      // the insert, a constraint nobody expected. Told only «try again», an
      // operator retries something retrying cannot fix and «رویدادها» has
      // nothing to show anyone looking for the reason.
      //
      // Safe to log in full, unlike the bulk route's catch: these statements
      // bind a name, a kind, a price and two ids, and the driver attaches the
      // statement to its error. No credential passes through here.
      log.error(
        'stock.shelf_create_failed',
        {
          actor: ident.email,
          trace: ident.requestId,
          name: b.name,
          category_id: b.categoryId,
          consequence: 'nothing was written — the transaction rolled back',
        },
        err,
      );
      return c.json(
        { ok: false, error: 'rejected', detail: 'قفسه ساخته نشد — دوباره تلاش کن.' },
        409,
      );
    }

    await audit(
      c.env.DB,
      ident,
      'stock.shelf_created',
      'PRODUCT_PLAN',
      String(planId),
      null,
      { name: b.name, kind: b.kind, price_irr: b.priceIrr, category_id: b.categoryId },
      null,
    );
    return c.json({ ok: true, planId });
  });

  app.post('/api/v1/admin/stock', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = StockBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    // The panel comes from the plan, never from the request. A config filed
    // under a plan whose product lives elsewhere is a customer being handed an
    // account on a server they did not buy.
    const plan = await c.env.DB.prepare(
      `SELECT pl.id, p.provider_id FROM product_plans pl
         JOIN products p ON p.id = pl.product_id
        WHERE pl.id = ?1`,
    )
      .bind(body.data.planId)
      .first<{ id: number; provider_id: number }>();
    if (!plan) return c.json({ ok: false, error: 'plan_not_found' }, 404);

    // The name goes to a PANEL, and until now this field took any 200
    // characters — Persian, spaces, capitals, anything. That matters more than
    // it looks: a shelved config is handed to a customer whose panel account is
    // then looked up by this exact string on every later sync and renewal, so a
    // name the panel stores differently is an account this system loses. The
    // charset is the one every real username on this shop's panels uses.
    const nameProblem = checkRemoteUsername(body.data.remoteUsername);
    if (nameProblem) {
      return c.json({ ok: false, error: 'invalid_body', detail: nameProblem }, 400);
    }

    const row = await c.env.DB.prepare(
      `INSERT INTO provisioning_stock
         (plan_id, provider_id, remote_username, subscription_url, note, status)
       VALUES (?1, ?2, ?3, ?4, ?5, 'AVAILABLE')
       ON CONFLICT DO NOTHING
       RETURNING id`,
    )
      .bind(
        body.data.planId,
        plan.provider_id,
        body.data.remoteUsername,
        body.data.subscriptionUrl,
        body.data.note ?? null,
      )
      .first<{ id: number }>();
    if (!row) {
      return c.json(
        {
          ok: false,
          error: 'already_shelved',
          detail: 'این نام کاربری از قبل روی همین پنل در قفسه است.',
        },
        409,
      );
    }

    // The username identifies the account; the link is the credential and is
    // not written to a table anyone can read afterwards.
    await audit(
      c.env.DB,
      ident,
      'stock.added',
      'PROVISIONING_STOCK',
      String(row.id),
      null,
      {
        plan_id: body.data.planId,
        remote_username: body.data.remoteUsername,
      },
      null,
    );
    return c.json({ ok: true, id: Number(row.id) });
  });

  /**
   * Fills a shelf from a pasted export — the bulk half of the form above.
   *
   * One account per line, `username,credential` (a tab works too, so a
   * spreadsheet export pastes as-is). A credential starting with http(s) is a
   * subscription link and the username must be panel-safe, exactly as the
   * single-row route demands; anything else is an account password (0057) —
   * there the username is whatever the upstream service issued, an email
   * included, so it is only required to be one whitespace-free token.
   *
   * Nothing is transactional across lines on purpose: every line answers for
   * itself, a duplicate is the database's verdict per row, and the response
   * names each line that did not make it. Credentials never appear in the
   * response or the audit trail — counts and usernames only.
   */
  app.post('/api/v1/admin/stock/bulk', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = BulkStockBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    const plan = await c.env.DB.prepare(
      `SELECT pl.id, p.provider_id, pr.kind AS provider_kind
         FROM product_plans pl
         JOIN products p ON p.id = pl.product_id
         LEFT JOIN provisioning_providers pr ON pr.id = p.provider_id
        WHERE pl.id = ?1`,
    )
      .bind(body.data.planId)
      .first<{ id: number; provider_id: number; provider_kind: string | null }>();
    if (!plan) return c.json({ ok: false, error: 'plan_not_found' }, 404);
    // An account is a username and a password and no panel knows about it. On a
    // panel that provisions for itself, the shelf holds CONFIGS — a password
    // row there would be handed to a customer as an account on a server where
    // it does not exist, and the panel would never have heard of the username.
    const panelIsAutomated = isAutomated(plan.provider_kind ?? '');

    const lines = body.data.text.split(/\r?\n/);
    if (lines.filter((l) => l.trim() !== '').length > BULK_MAX_LINES) {
      return c.json(
        {
          ok: false,
          error: 'too_many_lines',
          detail: `حداکثر ${BULK_MAX_LINES} سطر در هر بار — فایل را تکه‌تکه بفرست.`,
        },
        400,
      );
    }

    let added = 0;
    let seenAContentLine = false;
    const skipped: { line: number; username?: string; reason: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] ?? '').trim();
      if (line === '') continue;
      const at = i + 1;
      // The FIRST line with anything on it, not line 1: a file that opens with
      // a blank line would otherwise carry its header straight past the check
      // below and onto the shelf.
      const isFirstContentLine = !seenAContentLine;
      seenAContentLine = true;

      const sep = /[\t,]/.exec(line);
      if (!sep) {
        skipped.push({ line: at, reason: 'جداکننده ندارد — «نام‌کاربری,گذرواژه» یا «نام‌کاربری,لینک»' });
        continue;
      }
      const username = unquote(line.slice(0, sep.index));
      const credential = unquote(line.slice(sep.index + 1));
      if (username === '' || credential === '') {
        skipped.push({ line: at, reason: 'نام کاربری یا اعتبارنامه خالی است' });
        continue;
      }
      // A spreadsheet export starts with its column names, and shelved as an
      // account that row sorts lowest — so «username / password» would be the
      // first thing sold to a real customer.
      if (isFirstContentLine && looksLikeHeader(username, credential)) {
        skipped.push({ line: at, reason: 'سطر عنوان فایل است، نه یک اکانت' });
        continue;
      }

      const isUrl = /^https?:\/\//i.test(credential);
      if (!isUrl && panelIsAutomated) {
        skipped.push({
          line: at,
          username,
          reason: 'این محصول روی پنل خودکار است — قفسه‌اش لینک اشتراک می‌گیرد، نه گذرواژه.',
        });
        continue;
      }
      if (isUrl) {
        // A link is sold onto a panel; the username must survive that panel.
        const nameProblem = checkRemoteUsername(username);
        if (nameProblem) {
          skipped.push({ line: at, username, reason: nameProblem });
          continue;
        }
        if (credential.length > 2000) {
          skipped.push({ line: at, username, reason: 'لینک بلندتر از ۲۰۰۰ نویسه است' });
          continue;
        }
      } else {
        if (!/^\S{1,200}$/.test(username)) {
          skipped.push({ line: at, username, reason: 'نام کاربری باید یک تکه و حداکثر ۲۰۰ نویسه باشد' });
          continue;
        }
        if (credential.length > 500) {
          skipped.push({ line: at, username, reason: 'گذرواژه بلندتر از ۵۰۰ نویسه است' });
          continue;
        }
      }

      // Caught per line rather than left to escape. Escaping, the handler
      // answers 500 with rows already committed and no audit row: the admin is
      // told nothing was added while some of it was, and the only way to find
      // out is to count the shelf by hand.
      let row: { id: number } | null = null;
      try {
        row = await c.env.DB.prepare(
          `INSERT INTO provisioning_stock
             (plan_id, provider_id, remote_username, subscription_url, secret, status)
           VALUES (?1, ?2, ?3, ?4, ?5, 'AVAILABLE')
           ON CONFLICT DO NOTHING
           RETURNING id`,
        )
          .bind(
            plan.id,
            plan.provider_id,
            username,
            isUrl ? credential : null,
            isUrl ? null : credential,
          )
          .first<{ id: number }>();
      } catch {
        // The driver attaches the failing statement to its error and the
        // statement carries the credential, so the reason is written here
        // rather than taken from the error.
        skipped.push({ line: at, username, reason: 'دیتابیس این سطر را نپذیرفت' });
        continue;
      }
      if (!row) {
        skipped.push({ line: at, username, reason: 'از قبل روی همین پنل در قفسه است' });
        continue;
      }
      added++;
    }

    await audit(
      c.env.DB,
      ident,
      'stock.bulk_added',
      'PROVISIONING_STOCK',
      `plan:${plan.id}`,
      null,
      { plan_id: plan.id, added, skipped: skipped.length },
      null,
    );
    return c.json({ ok: true, added, skipped });
  });

  /**
   * Takes a config off the shelf without pretending it was never there.
   *
   * Guarded inside the UPDATE rather than by reading the status first: the sale
   * that claims a row runs `... WHERE status = 'AVAILABLE'` in its own
   * statement, and an admin retiring the same row at the same moment must lose
   * that race rather than both succeeding.
   */
  app.post('/api/v1/admin/stock/:id/retire', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const done = await c.env.DB.prepare(
      `UPDATE provisioning_stock SET status = 'RETIRED'
        WHERE id = ?1 AND status = 'AVAILABLE'`,
    )
      .bind(id)
      .run();
    if (done.meta.changes === 0) {
      const row = await c.env.DB.prepare(`SELECT status FROM provisioning_stock WHERE id = ?1`)
        .bind(id)
        .first<{ status: string }>();
      if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json(
        {
          ok: false,
          error: 'not_available',
          detail:
            row.status === 'USED'
              ? 'این کانفیگ فروخته شده و به یک سفارش وصل است.'
              : 'این کانفیگ از قبل بازنشسته شده است.',
        },
        409,
      );
    }

    await audit(
      c.env.DB,
      ident,
      'stock.retired',
      'PROVISIONING_STOCK',
      String(id),
      null,
      null,
      null,
    );
    return c.json({ ok: true });
  });

  app.delete('/api/v1/admin/stock/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    // Only a config that was never sold. A USED row names the order that took
    // it and the customer's subscription points at the same account — removing
    // it loses the only record of where their service came from.
    const done = await c.env.DB.prepare(
      `DELETE FROM provisioning_stock WHERE id = ?1 AND status <> 'USED'`,
    )
      .bind(id)
      .run();
    if (done.meta.changes === 0) {
      const row = await c.env.DB.prepare(`SELECT status FROM provisioning_stock WHERE id = ?1`)
        .bind(id)
        .first<{ status: string }>();
      if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json(
        { ok: false, error: 'sold', detail: 'کانفیگ فروخته‌شده حذف نمی‌شود — تاریخچهٔ سفارش است.' },
        409,
      );
    }

    await audit(
      c.env.DB,
      ident,
      'stock.deleted',
      'PROVISIONING_STOCK',
      String(id),
      null,
      null,
      null,
    );
    return c.json({ ok: true });
  });
}
