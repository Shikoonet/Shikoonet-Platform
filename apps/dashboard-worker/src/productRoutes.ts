/**
 * The catalogue — what the shop sells, and for how much.
 *
 * The screen this replaces (`panel/product.php`) lists one row per *sellable
 * combination*: name, price, volume, days, panel, user group, category. That is
 * the right unit for an admin, and it is what this endpoint returns — but in
 * Mirzabot's schema that row is literally the `product` table, because a second
 * duration means a second product. Here it is `product_plans` joined onto its
 * `products` parent, so the admin sees the same list while the database keeps
 * the product and its SKUs apart.
 *
 * Three deliberate differences from the PHP:
 *
 *   **Delete is guarded, not absent.** `product.php:159` offers a delete button
 *   and `orders.plan_id` is `ON DELETE SET NULL`, so removing a plan there
 *   silently detaches every order ever placed on it and the sales history stops
 *   being able to say what was sold. Here the delete is one statement that
 *   removes the row *only* when nothing points at it, so a plan carrying sales
 *   cannot be detached at all — see `DELETE_PLAN` below for why counting first
 *   and deleting second would not be the same thing.
 *
 *   **The price has a ceiling.** The PHP takes any integer. The most expensive
 *   thing this shop has ever sold is 750,000 Toman (max of `product.price_product`
 *   in the production dump, read 2026-08-14, over 21 rows); the ceiling here is
 *   13× that. A price is typed by hand, and the failure mode is an extra zero.
 *
 *   **Every write is ADMIN-only and lands in `audit_logs`.** A price change is
 *   the one catalogue edit that costs money in both directions, and the PHP
 *   leaves no trace of who made it.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import {
  MAX_CATALOG_ROWS,
  MAX_SINGLE_PAYMENT_IRR,
  checkCatalogLayout,
  type CatalogLayoutProblem,
} from '@shikoo/contracts';
import { audit, type Ident } from './adminAudit.js';
import { faNum } from './fa.js';

const PAGE_SIZE_MAX = 100;

/** The `kind` values `products.kind`'s CHECK constraint allows. */
const PRODUCT_KINDS = ['vpn', 'ai_account', 'spotify', 'manual', 'other'] as const;
const STATUSES = ['ACTIVE', 'HIDDEN', 'DISABLED'] as const;

const ListQuery = z.object({
  q: z.string().trim().max(64).optional(),
  status: z.enum(['ACTIVE', 'HIDDEN', 'DISABLED']).optional(),
  providerId: z.coerce.number().int().positive().optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  /**
   * Absent means «both», which is why this is not a boolean with a default.
   * `?resellersOnly=false` is a real question — «what does an ordinary customer
   * see» — and it has to be askable separately from not asking at all.
   */
  resellersOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(25),
});

/**
 * A plan edit. Every field is optional — the form sends only what changed — but
 * an empty body is rejected rather than treated as a no-op write, because an
 * audit row saying "nothing changed" is worse than no audit row.
 *
 * `durationDays` and `volumeGb` accept null on purpose: null volume is an
 * unmetered plan and null duration is one that does not expire. That is a real
 * distinction in the schema, so the API has to be able to express it.
 */
const PLAN_FIELDS = {
  name: z.string().trim().min(1).max(120),
  priceIrr: z.number().int().min(0).max(MAX_SINGLE_PAYMENT_IRR),
  durationDays: z.number().int().positive().max(3650).nullable(),
  volumeGb: z.number().min(0).max(100_000).nullable(),
  userLimit: z.number().int().positive().max(10_000).nullable(),
  sortOrder: z.number().int().min(0).max(10_000),
  status: z.enum(STATUSES),
};

/**
 * `attrs` after this product's group selection is written into it.
 *
 * A merge rather than an overwrite: `attrs` is the adapter's bag and holds more
 * than groups on migrated rows. `?N::jsonb` for the list, and the key is
 * REMOVED for null so that "the panel decides" is the absence of the key, which
 * is what `pick()` reads.
 */
function groupIdsSql(param: number): string {
  return `attrs = CASE WHEN ?${param}::jsonb IS NULL THEN attrs - 'group_ids'
                       ELSE COALESCE(attrs, '{}'::jsonb) || jsonb_build_object('group_ids', ?${param}::jsonb)
                  END`;
}

const PlanPatch = z
  .object({
    name: PLAN_FIELDS.name.optional(),
    priceIrr: PLAN_FIELDS.priceIrr.optional(),
    durationDays: PLAN_FIELDS.durationDays.optional(),
    volumeGb: PLAN_FIELDS.volumeGb.optional(),
    userLimit: PLAN_FIELDS.userLimit.optional(),
    sortOrder: PLAN_FIELDS.sortOrder.optional(),
    status: PLAN_FIELDS.status.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'no fields to change');

/**
 * A new plan.
 *
 * `durationDays` and `volumeGb` default to null rather than to a number: the
 * unmetered/no-expiry pair is what the schema means by NULL, and a create form
 * that quietly substituted 0 or 30 would sell something nobody chose.
 */
const PlanCreate = z
  .object({
    name: PLAN_FIELDS.name,
    priceIrr: PLAN_FIELDS.priceIrr,
    durationDays: PLAN_FIELDS.durationDays.default(null),
    volumeGb: PLAN_FIELDS.volumeGb.default(null),
    userLimit: PLAN_FIELDS.userLimit.default(null),
    sortOrder: PLAN_FIELDS.sortOrder.default(0),
    status: PLAN_FIELDS.status.default('ACTIVE'),
  })
  .strict();

/**
 * The product fields the panel may write.
 *
 * `code` is the customer-invisible key the legacy `code_product` became and it
 * is UNIQUE, so it is validated to the shape the importer produced rather than
 * left as free text — a code with a space in it reads as two columns in every
 * report that joins on it.
 */
const PRODUCT_FIELDS = {
  code: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'code may hold letters, digits, dot, dash and underscore only'),
  name: z.string().trim().min(1).max(160),
  kind: z.enum(PRODUCT_KINDS),
  providerId: z.number().int().positive().nullable(),
  categoryId: z.number().int().positive().nullable(),
  description: z.string().trim().max(2000).nullable(),
  resellersOnly: z.boolean(),
  oncePerUser: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000),
  status: z.enum(STATUSES),
  /**
   * Which groups on the panel an account bought here joins — the tier.
   *
   * `[]` and `null` are different answers and both are kept. An empty list
   * means "send no groups at all"; null means "this service does not decide,
   * the panel's default does". Collapsing them would make clearing the boxes
   * indistinguishable from never having opened the section, and one of those
   * silently keeps selling the old tier.
   *
   * The ids are the panel's own, not ours — they are read from the panel and
   * sent back to it — so the range is only sanity, never a foreign key. A
   * group deleted on the panel is caught by the delete guard on the other side
   * and by the purchase itself, not here.
   */
  groupIds: z.array(z.number().int().positive().max(1_000_000)).max(50).nullable(),
};

const ProductCreate = z
  .object({
    code: PRODUCT_FIELDS.code,
    name: PRODUCT_FIELDS.name,
    kind: PRODUCT_FIELDS.kind,
    providerId: PRODUCT_FIELDS.providerId.default(null),
    categoryId: PRODUCT_FIELDS.categoryId.default(null),
    description: PRODUCT_FIELDS.description.default(null),
    resellersOnly: PRODUCT_FIELDS.resellersOnly.default(false),
    oncePerUser: PRODUCT_FIELDS.oncePerUser.default(false),
    sortOrder: PRODUCT_FIELDS.sortOrder.default(0),
    status: PRODUCT_FIELDS.status.default('ACTIVE'),
    groupIds: PRODUCT_FIELDS.groupIds.default(null),
  })
  .strict();

const ProductPatch = z
  .object({
    code: PRODUCT_FIELDS.code.optional(),
    name: PRODUCT_FIELDS.name.optional(),
    kind: PRODUCT_FIELDS.kind.optional(),
    providerId: PRODUCT_FIELDS.providerId.optional(),
    categoryId: PRODUCT_FIELDS.categoryId.optional(),
    description: PRODUCT_FIELDS.description.optional(),
    resellersOnly: PRODUCT_FIELDS.resellersOnly.optional(),
    oncePerUser: PRODUCT_FIELDS.oncePerUser.optional(),
    sortOrder: PRODUCT_FIELDS.sortOrder.optional(),
    status: PRODUCT_FIELDS.status.optional(),
    groupIds: PRODUCT_FIELDS.groupIds.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'no fields to change');

const ProductStatusBody = z.object({ status: z.enum(STATUSES) }).strict();

/**
 * A category — the shop's first screen, one button per row of this table.
 *
 * `emoji` is stored and not validated beyond a length, and the length is
 * generous on purpose: a family or a flag is several code points joined by
 * zero-width joiners, and a cap tight enough to mean «one glyph» refuses those.
 * What it is NOT is a label — that is `name`, and it is what the button says.
 *
 * `active` is the switch that takes a category's products off sale without
 * deleting anything. Deleting is what the foreign key refuses while products
 * point at it; this is the thing an operator actually wants when a tier is
 * retired for a month.
 */
const CATEGORY_FIELDS = {
  name: z.string().trim().min(1).max(80),
  emoji: z.string().trim().min(1).max(16).nullable(),
  sortOrder: z.number().int().min(0).max(10_000),
  active: z.boolean(),
};

const CategoryBody = z
  .object({
    name: CATEGORY_FIELDS.name,
    emoji: CATEGORY_FIELDS.emoji.default(null),
    sortOrder: CATEGORY_FIELDS.sortOrder.default(0),
    active: CATEGORY_FIELDS.active.default(true),
  })
  .strict();

const CategoryPatch = z
  .object({
    name: CATEGORY_FIELDS.name.optional(),
    emoji: CATEGORY_FIELDS.emoji.optional(),
    sortOrder: CATEGORY_FIELDS.sortOrder.optional(),
    active: CATEGORY_FIELDS.active.optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'no fields to change');

/**
 * An arrangement, as the browser sends it.
 *
 * The array's ORDER is the horizontal order and is the whole of what the server
 * writes into `sort_order`; `sort_order` itself is never sent. That deletes the
 * entire class of «two buttons claim position 3» bugs rather than validating
 * against it — there is no second place for the order to be written down, so
 * there is nothing for it to disagree with.
 *
 * `rowIndex` is bounded here as well as by the CHECK constraint. Reaching the
 * constraint would mean a 500 and a driver message; this is a sentence.
 */
const CatalogLayoutBody = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.number().int().positive(),
            rowIndex: z.number().int().min(0).max(MAX_CATALOG_ROWS - 1).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();

interface PlanRow {
  id: number;
  plan_name: string;
  price_irr: number;
  duration_days: number | null;
  volume_gb: number | null;
  user_limit: number | null;
  plan_status: string;
  sort_order: number;
  product_id: number;
  product_code: string;
  product_name: string;
  product_kind: string;
  product_status: string;
  product_description: string | null;
  product_sort_order: number;
  category_id: number | null;
  resellers_only: boolean;
  once_per_user: boolean;
  group_ids: number[] | null;
  provider_id: number | null;
  provider_name: string | null;
  provider_code: string | null;
  provider_status: string | null;
  category_name: string | null;
  orders_count: number;
}

function shape(r: PlanRow) {
  return {
    id: r.id,
    name: r.plan_name,
    priceIrr: Number(r.price_irr),
    durationDays: r.duration_days,
    // numeric(12,3) arrives as a number through the adapter; NULL means
    // unmetered, which is not the same as 0 and must not collapse into it.
    volumeGb: r.volume_gb === null ? null : Number(r.volume_gb),
    userLimit: r.user_limit,
    status: r.plan_status,
    sortOrder: r.sort_order,
    product: {
      id: r.product_id,
      code: r.product_code,
      name: r.product_name,
      kind: r.product_kind,
      status: r.product_status,
      description: r.product_description,
      sortOrder: r.product_sort_order,
      categoryId: r.category_id,
      resellersOnly: r.resellers_only,
      oncePerUser: r.once_per_user,
      groupIds: r.group_ids,
    },
    provider: r.provider_id
      ? {
          id: r.provider_id,
          name: r.provider_name,
          code: r.provider_code,
          status: r.provider_status,
        }
      : null,
    categoryName: r.category_name,
    ordersCount: Number(r.orders_count),
  };
}

/** One category row, as every category screen reads it. */
function shapeCategory(r: {
  id: number;
  name: string;
  emoji: string | null;
  active: boolean;
  sort_order: number;
  row_index: number | null;
  products: number;
}) {
  return {
    id: Number(r.id),
    name: r.name,
    emoji: r.emoji,
    active: r.active,
    sortOrder: r.sort_order,
    rowIndex: r.row_index,
    productsCount: Number(r.products),
  };
}

/** One service row, before its configs are hung off it. */
interface ServiceRow {
  id: number;
  code: string;
  name: string;
  kind: string;
  status: string;
  description: string | null;
  sort_order: number;
  category_id: number | null;
  resellers_only: boolean;
  once_per_user: boolean;
  group_ids: number[] | null;
  provider_id: number | null;
  provider_name: string | null;
  provider_code: string | null;
  provider_status: string | null;
  category_name: string | null;
}

interface ConfigRow {
  id: number;
  product_id: number;
  name: string;
  price_irr: number;
  duration_days: number | null;
  volume_gb: number | null;
  user_limit: number | null;
  status: string;
  sort_order: number;
  orders_count: number;
}

/**
 * Every config of the services on this page, in one statement.
 *
 * A query per service would be `pageSize` round trips for a screen that is one
 * list. The ids are spread into `?N` placeholders rather than passed as an
 * array: `packages/db` translates positional parameters and closes the
 * parameter gap, and handing it a JS array where a scalar is expected is the
 * kind of thing that works on SQLite and does not on Postgres.
 *
 * Every status comes back, ACTIVE or not. An operator looking at a service
 * needs to see the config they disabled last week — that is usually why they
 * opened it.
 */
async function configsFor(db: D1Database, productIds: number[]): Promise<ConfigRow[]> {
  const holes = productIds.map((_, i) => `?${i + 1}`).join(', ');
  const rows = await db
    .prepare(
      `SELECT pl.id, pl.product_id, pl.name, pl.price_irr, pl.duration_days, pl.volume_gb,
              pl.user_limit, pl.status, pl.sort_order,
              (SELECT COUNT(*) FROM orders o WHERE o.plan_id = pl.id) AS orders_count
         FROM product_plans pl
        WHERE pl.product_id IN (${holes})
        ORDER BY pl.sort_order, pl.price_irr, pl.id`,
    )
    .bind(...productIds)
    .all<ConfigRow>();
  return rows.results ?? [];
}

function shapeService(r: ServiceRow, configs: ConfigRow[]) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    status: r.status,
    description: r.description,
    sortOrder: r.sort_order,
    categoryId: r.category_id,
    categoryName: r.category_name,
    resellersOnly: r.resellers_only,
    oncePerUser: r.once_per_user,
    groupIds: r.group_ids,
    panel: r.provider_id
      ? {
          id: r.provider_id,
          name: r.provider_name,
          code: r.provider_code,
          status: r.provider_status,
        }
      : null,
    configs: configs
      .filter((cf) => cf.product_id === r.id)
      .map((cf) => ({
        id: cf.id,
        name: cf.name,
        priceIrr: Number(cf.price_irr),
        durationDays: cf.duration_days,
        // NULL is unmetered and 0 is a free gigabyte allowance. The flat route
        // learned this the hard way; collapsing them here would resell the
        // lesson.
        volumeGb: cf.volume_gb === null ? null : Number(cf.volume_gb),
        userLimit: cf.user_limit,
        status: cf.status,
        sortOrder: cf.sort_order,
        ordersCount: Number(cf.orders_count),
      })),
  };
}

const SELECT_PLAN = `
  SELECT pl.id, pl.name AS plan_name, pl.price_irr, pl.duration_days, pl.volume_gb,
         pl.user_limit, pl.status AS plan_status, pl.sort_order,
         p.id AS product_id, p.code AS product_code, p.name AS product_name,
         p.kind AS product_kind, p.status AS product_status,
         p.description AS product_description, p.sort_order AS product_sort_order,
         p.category_id,
         p.resellers_only, p.once_per_user,
         p.attrs->'group_ids' AS group_ids,
         pr.id AS provider_id, pr.name AS provider_name, pr.code AS provider_code,
         pr.status AS provider_status,
         cat.name AS category_name,
         (SELECT COUNT(*) FROM orders o WHERE o.plan_id = pl.id) AS orders_count
    FROM product_plans pl
    JOIN products p ON p.id = pl.product_id
    LEFT JOIN provisioning_providers pr ON pr.id = p.provider_id
    LEFT JOIN product_categories cat ON cat.id = p.category_id`;

// ---------------------------------------------------------------------------
// Deleting, and why the guard is inside the DELETE
// ---------------------------------------------------------------------------
/**
 * Remove a plan only if nothing points at it.
 *
 * The obvious shape — count the references, then delete if the count is zero —
 * is wrong here, and not subtly. An order placed between the SELECT and the
 * DELETE is deleted along with the plan's row: `orders.plan_id` is
 * `ON DELETE SET NULL`, so that order silently loses the only record of what it
 * bought and nothing anywhere reports an error. The customer's money is fine;
 * the shop simply can no longer say what was sold. Postgres evaluates the
 * `NOT EXISTS` clauses under the same row locks as the delete itself, so with
 * them inside the statement that window does not exist.
 *
 * Zero rows back therefore means "something references it" *or* "no such
 * plan" — the caller tells the two apart by having read the row first. The
 * counts are read afterwards, and only to word the refusal.
 *
 * `subscriptions.plan_id` is also SET NULL and `provisioning_stock.plan_id` is
 * NOT NULL with no ON DELETE clause — that one would raise rather than corrupt,
 * but a stocked config is still a thing the admin should be told about by name.
 */
const DELETE_PLAN = `
  DELETE FROM product_plans WHERE id = ?1
    AND NOT EXISTS (SELECT 1 FROM orders             WHERE plan_id = ?1)
    AND NOT EXISTS (SELECT 1 FROM subscriptions      WHERE plan_id = ?1)
    AND NOT EXISTS (SELECT 1 FROM provisioning_stock WHERE plan_id = ?1)
  RETURNING id`;

const COUNT_PLAN_REFS = `
  SELECT (SELECT COUNT(*) FROM orders             WHERE plan_id = ?1) AS orders,
         (SELECT COUNT(*) FROM subscriptions      WHERE plan_id = ?1) AS subscriptions,
         (SELECT COUNT(*) FROM provisioning_stock WHERE plan_id = ?1) AS stock`;

/**
 * Remove a product only if nothing points at any of its plans.
 *
 * `product_plans.product_id` and `discount_codes.product_id` are both
 * `ON DELETE CASCADE`, so deleting a product is a much larger act than deleting
 * a plan: every plan under it goes, and with the plans go the SET NULLs on
 * every order and subscription that ever named one. The guard therefore reaches
 * one join further out — a product with a single sold plan is as undeletable as
 * that plan is.
 *
 * Discount codes are counted as a reference of their own. Cascading them away
 * takes `discount_redemptions` with them, and a redemption is a record of money
 * already given.
 */
const DELETE_PRODUCT = `
  DELETE FROM products WHERE id = ?1
    AND NOT EXISTS (
      SELECT 1 FROM orders o JOIN product_plans pl ON pl.id = o.plan_id
       WHERE pl.product_id = ?1)
    AND NOT EXISTS (
      SELECT 1 FROM subscriptions s JOIN product_plans pl ON pl.id = s.plan_id
       WHERE pl.product_id = ?1)
    AND NOT EXISTS (
      SELECT 1 FROM provisioning_stock st JOIN product_plans pl ON pl.id = st.plan_id
       WHERE pl.product_id = ?1)
    AND NOT EXISTS (SELECT 1 FROM discount_codes WHERE product_id = ?1)
  RETURNING id`;

const COUNT_PRODUCT_REFS = `
  SELECT (SELECT COUNT(*) FROM orders o JOIN product_plans pl ON pl.id = o.plan_id
           WHERE pl.product_id = ?1) AS orders,
         (SELECT COUNT(*) FROM subscriptions s JOIN product_plans pl ON pl.id = s.plan_id
           WHERE pl.product_id = ?1) AS subscriptions,
         (SELECT COUNT(*) FROM provisioning_stock st JOIN product_plans pl ON pl.id = st.plan_id
           WHERE pl.product_id = ?1) AS stock,
         (SELECT COUNT(*) FROM discount_codes WHERE product_id = ?1) AS discounts`;

interface Refs {
  orders: number;
  subscriptions: number;
  stock: number;
  discounts?: number;
}

/**
 * Why the delete was refused, in the admin's own words.
 *
 * Named counts rather than "it is in use": the admin's next move differs
 * completely between "12 orders" (never delete this, archive it) and "3 stocked
 * configs" (sell or release them, then try again).
 */
function refusal(refs: Refs): string {
  const parts: string[] = [];
  if (refs.orders > 0) parts.push(`${faNum(refs.orders)} سفارش`);
  if (refs.subscriptions > 0) parts.push(`${faNum(refs.subscriptions)} سرویس فروخته‌شده`);
  if (refs.stock > 0) parts.push(`${faNum(refs.stock)} کانفیگ در انبار`);
  if (refs.discounts && refs.discounts > 0) parts.push(`${faNum(refs.discounts)} کد تخفیف`);
  if (parts.length === 0) return 'چیزی به این ردیف وصل است و حذف انجام نشد.';
  return `${parts.join(' و ')} به این ردیف وصل است؛ حذف تاریخچهٔ فروش را خالی می‌کند. «غیرفعال» همین کار را بدون از دست رفتن تاریخچه انجام می‌دهد.`;
}

/**
 * Why an arrangement was refused, in the admin's own words.
 *
 * Every one of these is a bug in the page that posted it rather than something
 * an operator typed, so the sentences name what the screen did wrong instead of
 * asking for a correction. They are still Persian and still specific: this text
 * is what gets pasted into a bug report.
 */
function catalogLayoutProblem(problem: CatalogLayoutProblem): string {
  switch (problem.kind) {
    case 'EMPTY':
      return 'چیدمان بدون دکمه فرستاده شد.';
    case 'DUPLICATE_ID':
      return `این ردیف‌ها دو بار در چیدمان آمده‌اند: ${problem.ids.map(faNum).join('، ')}`;
    case 'FOREIGN_ID':
      return `این ردیف‌ها مالِ این صفحه نیستند: ${problem.ids.map(faNum).join('، ')}`;
    case 'MISSING_ID':
      return `چیدمان باید کلِ صفحه را بفرستد؛ جای این ردیف‌ها در آن خالی است: ${problem.ids.map(faNum).join('، ')}`;
    case 'MIXED_ARRANGEMENT':
      return 'بخشی از دکمه‌ها چیده شده‌اند و بخشی نه. یا همه، یا هیچ‌کدام.';
    case 'ROW_NOT_MONOTONIC':
      return `شمارهٔ ردیف باید رو به جلو برود؛ این‌ها به عقب برمی‌گردند: ${problem.ids.map(faNum).join('، ')}`;
    case 'ROW_GAP':
      return `ردیف‌های ${problem.rows.map(faNum).join('، ')} خالی مانده‌اند و ردیف خالی وجود ندارد.`;
    case 'ROW_TOO_WIDE':
      return `ردیف ${faNum(problem.row)} بیش از ${faNum(problem.limit)} دکمه دارد و تلگرام آن را رد می‌کند.`;
    case 'TOO_MANY_ROWS':
      return `بیش از ${faNum(problem.limit)} ردیف روی یک صفحهٔ فروشگاه خوانده نمی‌شود؛ این‌جا جای دسته‌بندی تازه است.`;
  }
}

function counts(row: Record<string, unknown> | null): Refs {
  return {
    orders: Number(row?.['orders'] ?? 0),
    subscriptions: Number(row?.['subscriptions'] ?? 0),
    stock: Number(row?.['stock'] ?? 0),
    // Only the product query counts discount codes; a plan has none of its own.
    ...(row?.['discounts'] === undefined ? {} : { discounts: Number(row['discounts']) }),
  };
}

export function registerProductRoutes(
  app: Hono<{ Bindings: { DB: D1Database }; Variables: { identity: Ident } }>,
) {
  // --- the catalogue ------------------------------------------------------

  app.get('/api/v1/admin/products', async (c) => {
    const parsed = ListQuery.safeParse({
      q: c.req.query('q') || undefined,
      status: c.req.query('status') || undefined,
      providerId: c.req.query('providerId') || undefined,
      categoryId: c.req.query('categoryId') || undefined,
      resellersOnly: c.req.query('resellersOnly') || undefined,
      page: c.req.query('page') ?? undefined,
      pageSize: c.req.query('pageSize') ?? undefined,
    });
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    const { q, status, providerId, categoryId, resellersOnly, page, pageSize } = parsed.data;

    const where: string[] = [];
    const params: unknown[] = [];
    if (status) {
      params.push(status);
      where.push(`pl.status = ?${params.length}`);
    }
    if (providerId) {
      params.push(providerId);
      where.push(`p.provider_id = ?${params.length}`);
    }
    // Both of these filter the SERVICE, not the config, and both are on the
    // flat screen because that screen's columns come from both levels. They are
    // answered here rather than in the browser for the reason the panel being
    // replaced demonstrates: `panel/js/datatable.js` filters the rows already
    // loaded and loads them all, which is honest on eight rows and a lie on
    // eight hundred. This list is paged, so a browser-side filter would hide
    // matches on page two and show a total that counts them.
    if (categoryId) {
      params.push(categoryId);
      where.push(`p.category_id = ?${params.length}`);
    }
    if (resellersOnly !== undefined) {
      params.push(resellersOnly);
      where.push(`p.resellers_only = ?${params.length}`);
    }
    if (q) {
      // An admin looking for "آلمان" does not know whether that word is on the
      // product or on the plan, so both are searched.
      params.push(`%${q}%`);
      where.push(`(pl.name ILIKE ?${params.length} OR p.name ILIKE ?${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM product_plans pl JOIN products p ON p.id = pl.product_id ${whereSql}`,
    )
      .bind(...params)
      .first<{ n: number }>();

    params.push(pageSize);
    const limitParam = params.length;
    params.push((page - 1) * pageSize);
    const rows = await c.env.DB.prepare(
      `${SELECT_PLAN} ${whereSql}
        ORDER BY p.sort_order, p.id, pl.sort_order, pl.id
        LIMIT ?${limitParam} OFFSET ?${params.length}`,
    )
      .bind(...params)
      .all<PlanRow>();

    // The filter needs the panels, and there are five of them — a second
    // round trip from the browser to fetch a five-row list is not worth it.
    const providers = await c.env.DB.prepare(
      `SELECT id, code, name, status FROM provisioning_providers ORDER BY sort_order, id`,
    ).all<{ id: number; code: string; name: string; status: string }>();

    return c.json({
      ok: true,
      total: totalRow?.n ?? 0,
      page,
      pageSize,
      items: (rows.results ?? []).map(shape),
      providers: (providers.results ?? []).map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        status: p.status,
      })),
    });
  });

  // --- the catalogue, shaped the way it is sold ---------------------------

  /**
   * Services, each with its configs inside it.
   *
   * `GET /products` above answers one row per PLAN. That is the right shape for
   * a price list and the wrong one for the screen an operator builds a service
   * on: it pages by plan, so a service with five configs can be cut in half
   * across two pages, and the service itself — the thing the customer actually
   * picks first — is never a row, only a repeated sub-line.
   *
   * So this one pages by SERVICE and carries the configs along. `total` counts
   * services. Both routes stay: the flat one is what the stock shelf and the
   * discount scopes read a plan through, and collapsing them would make one of
   * the two screens lie about what it is listing.
   *
   * What is NOT here: the group's name and whether it can deliver anything.
   * Both are facts about the panel, not about our rows, and asking five panels
   * over HTTP before this route may answer would let one sleeping panel hold
   * the whole catalogue screen shut. The browser asks `/panels/:id/groups` once
   * per panel it is showing and merges — the same call the tier picker already
   * makes, and a panel that does not answer costs one column, not the page.
   */
  app.get('/api/v1/admin/catalog', async (c) => {
    const parsed = ListQuery.safeParse({
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
      // The SERVICE's status, not a config's. On the flat route the same
      // parameter means the plan's, and one screen filtering by the other's
      // would quietly drop services that have exactly one disabled config.
      params.push(status);
      where.push(`p.status = ?${params.length}`);
    }
    if (providerId) {
      params.push(providerId);
      where.push(`p.provider_id = ?${params.length}`);
    }
    if (q) {
      // Name, code, or the name of any config inside it — an operator hunting
      // «۵۰ گیگ» is looking for the service that sells it.
      params.push(`%${q}%`);
      const n = params.length;
      where.push(
        `(p.name ILIKE ?${n} OR p.code ILIKE ?${n}
          OR EXISTS (SELECT 1 FROM product_plans pl
                      WHERE pl.product_id = p.id AND pl.name ILIKE ?${n}))`,
      );
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalRow = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM products p ${whereSql}`,
    )
      .bind(...params)
      .first<{ n: number }>();

    params.push(pageSize);
    const limitParam = params.length;
    params.push((page - 1) * pageSize);
    // The customer's order, so the list on this screen reads top to bottom the
    // way the shop does. A product with no panel sorts last, which is also
    // where it belongs: it cannot be sold at all.
    const services = await c.env.DB.prepare(
      `SELECT p.id, p.code, p.name, p.kind, p.status, p.description, p.sort_order,
              p.category_id, p.resellers_only, p.once_per_user,
              p.attrs->'group_ids' AS group_ids,
              pr.id AS provider_id, pr.name AS provider_name, pr.code AS provider_code,
              pr.status AS provider_status, pr.sort_order AS provider_sort_order,
              cat.name AS category_name
         FROM products p
         LEFT JOIN provisioning_providers pr ON pr.id = p.provider_id
         LEFT JOIN product_categories cat ON cat.id = p.category_id
         ${whereSql}
        ORDER BY pr.sort_order, pr.id, p.sort_order, p.id
        LIMIT ?${limitParam} OFFSET ?${params.length}`,
    )
      .bind(...params)
      .all<ServiceRow>();

    const rows = services.results ?? [];
    const configs = rows.length === 0 ? [] : await configsFor(c.env.DB, rows.map((r) => r.id));

    const panels = await c.env.DB.prepare(
      `SELECT id, code, name, status FROM provisioning_providers ORDER BY sort_order, id`,
    ).all<{ id: number; code: string; name: string; status: string }>();

    return c.json({
      ok: true,
      total: totalRow?.n ?? 0,
      page,
      pageSize,
      items: rows.map((r) => shapeService(r, configs)),
      panels: (panels.results ?? []).map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        status: p.status,
      })),
    });
  });

  // --- edit one plan ------------------------------------------------------

  app.post('/api/v1/admin/products/plans/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = PlanPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    const before = await c.env.DB.prepare(`${SELECT_PLAN} WHERE pl.id = ?1`)
      .bind(id)
      .first<PlanRow>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    const sets: string[] = [];
    const params: unknown[] = [];
    const patch = body.data;
    const put = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = ?${params.length}`);
    };
    if (patch.name !== undefined) put('name', patch.name);
    if (patch.priceIrr !== undefined) put('price_irr', patch.priceIrr);
    if (patch.durationDays !== undefined) put('duration_days', patch.durationDays);
    if (patch.volumeGb !== undefined) put('volume_gb', patch.volumeGb);
    if (patch.userLimit !== undefined) put('user_limit', patch.userLimit);
    if (patch.sortOrder !== undefined) put('sort_order', patch.sortOrder);
    if (patch.status !== undefined) put('status', patch.status);
    params.push(id);

    await c.env.DB.prepare(
      `UPDATE product_plans SET ${sets.join(', ')}, updated_at = now() WHERE id = ?${params.length}`,
    )
      .bind(...params)
      .run();

    // Read back rather than trusting the patch: a CHECK constraint that
    // rejected a value would otherwise be reported to the admin as applied.
    const after = await c.env.DB.prepare(`${SELECT_PLAN} WHERE pl.id = ?1`)
      .bind(id)
      .first<PlanRow>();
    if (!after) return c.json({ ok: false, error: 'not_found' }, 404);

    await audit(
      c.env.DB,
      ident,
      'catalog.plan_updated',
      'PRODUCT_PLAN',
      String(id),
      {
        name: before.plan_name,
        price_irr: Number(before.price_irr),
        duration_days: before.duration_days,
        volume_gb: before.volume_gb,
        status: before.plan_status,
      },
      {
        name: after.plan_name,
        price_irr: Number(after.price_irr),
        duration_days: after.duration_days,
        volume_gb: after.volume_gb,
        status: after.plan_status,
      },
      null,
    );

    return c.json({ ok: true, plan: shape(after) });
  });

  // --- take a whole product on or off the shelf ---------------------------

  app.post('/api/v1/admin/products/:id/status', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = ProductStatusBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ ok: false, error: 'invalid_body' }, 400);

    const before = await c.env.DB.prepare(`SELECT id, name, status FROM products WHERE id = ?1`)
      .bind(id)
      .first<{ id: number; name: string; status: string }>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    await c.env.DB.prepare(`UPDATE products SET status = ?1, updated_at = now() WHERE id = ?2`)
      .bind(body.data.status, id)
      .run();

    await audit(
      c.env.DB,
      ident,
      'catalog.product_status_changed',
      'PRODUCT',
      String(id),
      { status: before.status },
      { status: body.data.status },
      null,
    );

    return c.json({ ok: true, status: body.data.status });
  });

  // --- categories ---------------------------------------------------------

  /**
   * The category list, with the number that makes switching one off a decision.
   *
   * `productsCount` is here so the screen can say «۷ محصول با این کار از فروشگاه
   * برداشته می‌شوند» BEFORE the switch is thrown, rather than afterwards. It is
   * also what the delete refusal counts, and reading it in the same shape from
   * both places is deliberate: the number in the warning and the number in the
   * refusal are the same number.
   */
  app.get('/api/v1/admin/product-categories', async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT cat.id, cat.name, cat.emoji, cat.active, cat.sort_order, cat.row_index,
              (SELECT COUNT(*) FROM products p WHERE p.category_id = cat.id) AS products
         FROM product_categories cat ORDER BY cat.sort_order, cat.id`,
    ).all<{
      id: number;
      name: string;
      emoji: string | null;
      active: boolean;
      sort_order: number;
      row_index: number | null;
      products: number;
    }>();
    return c.json({
      ok: true,
      items: (rows.results ?? []).map(shapeCategory),
    });
  });

  app.post('/api/v1/admin/product-categories', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = CategoryBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    // `product_categories.name` is UNIQUE. Letting the constraint answer rather
    // than looking first keeps two admins typing «آلمان» at once from both
    // being told they succeeded.
    const row = await c.env.DB.prepare(
      `INSERT INTO product_categories (name, emoji, active, sort_order)
            VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (name) DO NOTHING RETURNING id`,
    )
      .bind(body.data.name, body.data.emoji, body.data.active, body.data.sortOrder)
      .first<{ id: number }>();
    if (!row) {
      return c.json(
        { ok: false, error: 'duplicate_name', detail: 'این دسته‌بندی از قبل هست.' },
        409,
      );
    }

    await audit(
      c.env.DB,
      ident,
      'catalog.category_created',
      'PRODUCT_CATEGORY',
      String(row.id),
      null,
      {
        name: body.data.name,
        emoji: body.data.emoji,
        active: body.data.active,
        sort_order: body.data.sortOrder,
      },
      null,
    );
    return c.json(
      {
        ok: true,
        category: {
          id: Number(row.id),
          name: body.data.name,
          emoji: body.data.emoji,
          active: body.data.active,
          sortOrder: body.data.sortOrder,
          rowIndex: null,
          productsCount: 0,
        },
      },
      201,
    );
  });

  // --- edit a category ----------------------------------------------------

  app.post('/api/v1/admin/product-categories/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = CategoryPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    const SELECT_CATEGORY = `SELECT id, name, emoji, active, sort_order, row_index
                               FROM product_categories WHERE id = ?1`;
    const before = await c.env.DB.prepare(SELECT_CATEGORY)
      .bind(id)
      .first<Record<string, unknown>>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    const sets: string[] = [];
    const params: unknown[] = [];
    const put = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = ?${params.length}`);
    };
    const patch = body.data;
    if (patch.name !== undefined) put('name', patch.name);
    if (patch.emoji !== undefined) put('emoji', patch.emoji);
    if (patch.active !== undefined) put('active', patch.active);
    if (patch.sortOrder !== undefined) put('sort_order', patch.sortOrder);
    params.push(id);

    // `name` is UNIQUE. Letting the constraint answer rather than looking first
    // is the same choice the create above makes, for the same reason.
    const written = await c.env.DB.prepare(
      `UPDATE product_categories SET ${sets.join(', ')} WHERE id = ?${params.length}`,
    )
      .bind(...params)
      .run()
      .then(() => true)
      .catch(() => false);
    if (!written) {
      return c.json(
        { ok: false, error: 'duplicate_name', detail: 'دسته‌بندی دیگری با این نام هست.' },
        409,
      );
    }

    const after = await c.env.DB.prepare(SELECT_CATEGORY).bind(id).first<Record<string, unknown>>();
    await audit(
      c.env.DB,
      ident,
      'catalog.category_updated',
      'PRODUCT_CATEGORY',
      String(id),
      before,
      after,
      null,
    );
    return c.json({ ok: true });
  });

  // --- delete a category --------------------------------------------------

  /**
   * Remove a category only if no product names it.
   *
   * `products.category_id` is NOT NULL with `ON DELETE RESTRICT` since 0032, so
   * Postgres refuses this on its own — but it refuses it as a driver error,
   * which reaches an operator as a 500 with nothing in it they can act on. The
   * `NOT EXISTS` inside the statement turns the same refusal into a sentence
   * with a count, and it does so without opening the window a count-then-delete
   * pair would: both clauses are evaluated under the delete's own row locks.
   *
   * The foreign key stays regardless. It is what makes this true for a psql
   * session and a migration as well as for this route; the route's version is
   * the wording, not the guarantee.
   */
  app.delete('/api/v1/admin/product-categories/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const before = await c.env.DB.prepare(
      `SELECT id, name, emoji, active, sort_order FROM product_categories WHERE id = ?1`,
    )
      .bind(id)
      .first<Record<string, unknown>>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    const gone = await c.env.DB.prepare(
      `DELETE FROM product_categories WHERE id = ?1
         AND NOT EXISTS (SELECT 1 FROM products WHERE category_id = ?1)
       RETURNING id`,
    )
      .bind(id)
      .first<{ id: number }>();
    if (!gone) {
      const row = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM products WHERE category_id = ?1`,
      )
        .bind(id)
        .first<{ n: number }>();
      const n = Number(row?.n ?? 0);
      return c.json(
        {
          ok: false,
          error: 'in_use',
          detail: `${faNum(n)} محصول در این دسته‌بندی است و محصول بی‌دسته‌بندی نمی‌شود. اول آن‌ها را به دسته‌بندی دیگری ببرید، یا این دسته‌بندی را خاموش کنید — خاموش‌کردن همان کار را بدون از دست رفتن چیزی انجام می‌دهد.`,
          counts: { products: n },
        },
        409,
      );
    }

    await audit(
      c.env.DB,
      ident,
      'catalog.category_deleted',
      'PRODUCT_CATEGORY',
      String(id),
      before,
      null,
      null,
    );
    return c.json({ ok: true });
  });

  // --- where the shop breaks its rows -------------------------------------

  /**
   * Save one shop screen's arrangement — the categories, or the configs inside
   * one category.
   *
   * Two things about this route carry the whole feature.
   *
   * **The scope's real contents are read from Postgres, never taken from the
   * request.** `checkCatalogLayout` is handed that list, so a post naming a
   * config from category 7 while addressing category 3 is refused rather than
   * silently rewriting category 7's order — and a post naming only half of
   * category 3 is refused too, because the unnamed half would keep yesterday's
   * `sort_order` and interleave with the new one.
   *
   * **`sort_order` is the array index and is never sent.** The browser posts an
   * ORDERED array of `{id, rowIndex}`; horizontal position is that order. There
   * is no second place for the order to be written down, so there is nothing
   * for it to disagree with, and the whole class of «two rows claim position 3»
   * stops existing rather than being validated against.
   *
   * The write is one `batch()` — a real transaction in `packages/db` — for the
   * reason `bot-keyboard/:menu` gives: there is no moment at which the bot can
   * read half an arrangement.
   *
   * What is deliberately NOT here is the legacy panel's mechanism.
   * `faoxima/panel/product.php:68-74` moves a row by swapping PRIMARY KEYS
   * through a hardcoded sentinel id, in three un-transacted UPDATEs, over GET.
   * Every `plan:<id>` already sitting in a customer's chat then buys a
   * different product. This moves two integers that nothing points at.
   */
  app.post('/api/v1/admin/catalog-layout/:scope', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const scope = c.req.param('scope');
    const inCategory = /^category:(\d+)$/.exec(scope);
    if (scope !== 'categories' && !inCategory) {
      return c.json({ ok: false, error: 'unknown_scope' }, 404);
    }

    const body = CatalogLayoutBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    let table: 'product_categories' | 'product_plans';
    let scopeIds: number[];
    if (inCategory) {
      const categoryId = Number(inCategory[1]);
      const cat = await c.env.DB.prepare(`SELECT id FROM product_categories WHERE id = ?1`)
        .bind(categoryId)
        .first<{ id: number }>();
      if (!cat) return c.json({ ok: false, error: 'not_found' }, 404);
      table = 'product_plans';
      // Every status, not only ACTIVE: the admin arranges the screen they are
      // looking at, and that screen holds the config they disabled last week.
      // Leaving disabled configs out of the scope would make every save a
      // MISSING_ID refusal.
      const rows = await c.env.DB.prepare(
        `SELECT pl.id FROM product_plans pl
           JOIN products p ON p.id = pl.product_id
          WHERE p.category_id = ?1`,
      )
        .bind(categoryId)
        .all<{ id: number }>();
      scopeIds = (rows.results ?? []).map((r) => Number(r.id));
    } else {
      table = 'product_categories';
      const rows = await c.env.DB.prepare(`SELECT id FROM product_categories`).all<{ id: number }>();
      scopeIds = (rows.results ?? []).map((r) => Number(r.id));
    }

    const items = body.data.items;
    const problem = checkCatalogLayout(items, scopeIds);
    if (problem) {
      return c.json(
        {
          ok: false,
          error: 'invalid_layout',
          kind: problem.kind,
          detail: catalogLayoutProblem(problem),
        },
        400,
      );
    }

    // The table name is one of the two literals chosen above and never touches
    // the request; ids and positions are all parameters.
    await c.env.DB.batch(
      items.map((item, at) =>
        c.env.DB.prepare(`UPDATE ${table} SET row_index = ?2, sort_order = ?3 WHERE id = ?1`).bind(
          item.id,
          item.rowIndex,
          at,
        ),
      ),
    );

    await audit(
      c.env.DB,
      ident,
      'catalog.layout_updated',
      'CATALOG_LAYOUT',
      scope,
      null,
      { items: items.map((i, at) => ({ id: i.id, row: i.rowIndex, at })) },
      null,
    );
    return c.json({ ok: true });
  });

  // --- create a product ---------------------------------------------------

  app.post('/api/v1/admin/products', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = ProductCreate.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }
    const p = body.data;

    const row = await c.env.DB.prepare(
      `INSERT INTO products
         (code, name, kind, provider_id, category_id, description,
          resellers_only, once_per_user, sort_order, status, attrs)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
               CASE WHEN ?11::jsonb IS NULL THEN '{}'::jsonb
                    ELSE jsonb_build_object('group_ids', ?11::jsonb) END)
       ON CONFLICT (code) DO NOTHING RETURNING id`,
    )
      .bind(
        p.code,
        p.name,
        p.kind,
        p.providerId,
        p.categoryId,
        p.description,
        p.resellersOnly,
        p.oncePerUser,
        p.sortOrder,
        p.status,
        p.groupIds === null ? null : JSON.stringify(p.groupIds),
      )
      .first<{ id: number }>()
      // A provider or category id that does not exist fails the foreign key.
      // That is a 400 about the request, not a 500 about us.
      .catch(() => null);
    if (!row) {
      return c.json(
        {
          ok: false,
          error: 'rejected',
          detail: 'کد تکراری است، یا پنل/دسته‌بندی انتخاب‌شده وجود ندارد.',
        },
        409,
      );
    }

    await audit(
      c.env.DB,
      ident,
      'catalog.product_created',
      'PRODUCT',
      String(row.id),
      null,
      { code: p.code, name: p.name, kind: p.kind, status: p.status },
      null,
    );
    return c.json({ ok: true, productId: Number(row.id) }, 201);
  });

  // --- edit a product -----------------------------------------------------

  app.post('/api/v1/admin/products/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = ProductPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    const SELECT_PRODUCT = `SELECT id, code, name, kind, provider_id, category_id, description,
                                   resellers_only, once_per_user, sort_order, status,
                                   attrs->'group_ids' AS group_ids
                              FROM products WHERE id = ?1`;
    const before = await c.env.DB.prepare(SELECT_PRODUCT).bind(id).first<Record<string, unknown>>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    const sets: string[] = [];
    const params: unknown[] = [];
    const put = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = ?${params.length}`);
    };
    const patch = body.data;
    if (patch.code !== undefined) put('code', patch.code);
    if (patch.name !== undefined) put('name', patch.name);
    if (patch.kind !== undefined) put('kind', patch.kind);
    if (patch.providerId !== undefined) put('provider_id', patch.providerId);
    if (patch.categoryId !== undefined) put('category_id', patch.categoryId);
    if (patch.description !== undefined) put('description', patch.description);
    if (patch.resellersOnly !== undefined) put('resellers_only', patch.resellersOnly);
    if (patch.oncePerUser !== undefined) put('once_per_user', patch.oncePerUser);
    if (patch.sortOrder !== undefined) put('sort_order', patch.sortOrder);
    if (patch.status !== undefined) put('status', patch.status);
    if (patch.groupIds !== undefined) {
      // Not `put()`: this one writes a CASE over `attrs` rather than a column,
      // and it reads its parameter twice.
      params.push(patch.groupIds === null ? null : JSON.stringify(patch.groupIds));
      sets.push(groupIdsSql(params.length));
    }
    params.push(id);

    const written = await c.env.DB.prepare(
      `UPDATE products SET ${sets.join(', ')}, updated_at = now() WHERE id = ?${params.length}`,
    )
      .bind(...params)
      .run()
      .then(() => true)
      // UNIQUE on `code`, and foreign keys on provider and category.
      .catch(() => false);
    if (!written) {
      return c.json(
        {
          ok: false,
          error: 'rejected',
          detail: 'کد تکراری است، یا پنل/دسته‌بندی انتخاب‌شده وجود ندارد.',
        },
        409,
      );
    }

    const after = await c.env.DB.prepare(SELECT_PRODUCT).bind(id).first<Record<string, unknown>>();
    await audit(
      c.env.DB,
      ident,
      'catalog.product_updated',
      'PRODUCT',
      String(id),
      before,
      after,
      null,
    );
    return c.json({ ok: true });
  });

  // --- delete a product ---------------------------------------------------

  app.delete('/api/v1/admin/products/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const before = await c.env.DB.prepare(
      `SELECT id, code, name, status FROM products WHERE id = ?1`,
    )
      .bind(id)
      .first<{ id: number; code: string; name: string; status: string }>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    const gone = await c.env.DB.prepare(DELETE_PRODUCT).bind(id).first<{ id: number }>();
    if (!gone) {
      const refs = counts(await c.env.DB.prepare(COUNT_PRODUCT_REFS).bind(id).first());
      return c.json({ ok: false, error: 'in_use', detail: refusal(refs), counts: refs }, 409);
    }

    await audit(
      c.env.DB,
      ident,
      'catalog.product_deleted',
      'PRODUCT',
      String(id),
      { code: before.code, name: before.name, status: before.status },
      null,
      null,
    );
    return c.json({ ok: true });
  });

  // --- add a plan to a product --------------------------------------------

  app.post('/api/v1/admin/products/:id/plans', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const productId = Number(c.req.param('id'));
    if (!Number.isInteger(productId) || productId <= 0) {
      return c.json({ ok: false, error: 'invalid_id' }, 400);
    }

    const body = PlanCreate.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }
    const p = body.data;

    const exists = await c.env.DB.prepare(`SELECT id FROM products WHERE id = ?1`)
      .bind(productId)
      .first<{ id: number }>();
    if (!exists) return c.json({ ok: false, error: 'not_found' }, 404);

    const row = await c.env.DB.prepare(
      `INSERT INTO product_plans
         (product_id, name, price_irr, duration_days, volume_gb, user_limit, sort_order, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id`,
    )
      .bind(
        productId,
        p.name,
        p.priceIrr,
        p.durationDays,
        p.volumeGb,
        p.userLimit,
        p.sortOrder,
        p.status,
      )
      .first<{ id: number }>();

    const planId = Number(row!.id);
    await audit(
      c.env.DB,
      ident,
      'catalog.plan_created',
      'PRODUCT_PLAN',
      String(planId),
      null,
      {
        product_id: productId,
        name: p.name,
        price_irr: p.priceIrr,
        duration_days: p.durationDays,
        volume_gb: p.volumeGb,
        status: p.status,
      },
      null,
    );

    const created = await c.env.DB.prepare(`${SELECT_PLAN} WHERE pl.id = ?1`)
      .bind(planId)
      .first<PlanRow>();
    return c.json({ ok: true, plan: shape(created!) }, 201);
  });

  // --- delete a plan ------------------------------------------------------

  app.delete('/api/v1/admin/products/plans/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const before = await c.env.DB.prepare(
      `SELECT id, product_id, name, price_irr::bigint AS price_irr, status
         FROM product_plans WHERE id = ?1`,
    )
      .bind(id)
      .first<{ id: number; product_id: number; name: string; price_irr: number; status: string }>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    const gone = await c.env.DB.prepare(DELETE_PLAN).bind(id).first<{ id: number }>();
    if (!gone) {
      const refs = counts(await c.env.DB.prepare(COUNT_PLAN_REFS).bind(id).first());
      return c.json({ ok: false, error: 'in_use', detail: refusal(refs), counts: refs }, 409);
    }

    await audit(
      c.env.DB,
      ident,
      'catalog.plan_deleted',
      'PRODUCT_PLAN',
      String(id),
      {
        product_id: Number(before.product_id),
        name: before.name,
        price_irr: Number(before.price_irr),
        status: before.status,
      },
      null,
      null,
    );
    return c.json({ ok: true });
  });
}
