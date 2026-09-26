/**
 * Every read of a row that belongs to one customer.
 *
 * This file exists so that "did we check the owner?" has one answer instead of
 * one per handler. Each query below carries `AND user_id = $caller`, and the
 * signatures make the caller impossible to omit — it is the first argument, not
 * an option. A handler cannot reach an order except through here.
 *
 * Mirzabot's shape is the counter-example: `config_` checks the owner,
 * `extend_`, `changestatus_` and the `subscriptionurl_` button path do not. The
 * check was a habit applied by hand at each call site, and four call sites
 * later somebody's attention ran out. BUGS-FOR-ADMIN.md item 8.
 *
 * Catalog rows — panels, products, plans — are NOT here. They belong to nobody
 * and every customer may read them, so scoping them by user would be
 * cargo-culting the rule rather than applying it. What a customer may not do is
 * read another customer's ORDER, which is what this file guards.
 */

import { randomUUID } from 'node:crypto';
import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import { AUTOMATED_KINDS_SQL } from '@shikoo/domain';

type Db = D1Database | D1DatabaseSession;

export interface OwnedOrder {
  id: number;
  public_id: string;
  status: string;
  total_irr: number;
  plan_id: number | null;
  /** The invoice deadline as an ISO timestamp; null for a trial or a pre-0057 row. */
  expires_at: string | null;
  /**
   * What the order IS, so a caller cannot act on one kind as if it were
   * another.
   *
   * Added because `wpay` did exactly that: it locked any order this customer
   * owned and spent the balance on it, including a `WALLET_TOPUP`. Nothing
   * downstream catches that — `creditTopup` runs only from the card
   * settlement, and the provisioning sweep skips deposits by name — so the
   * money left the wallet and never came back.
   */
  kind: string;
}

/**
 * Loads one order, and only if it belongs to `userId`.
 *
 * Returns null both when the order does not exist and when it belongs to
 * somebody else. The caller cannot tell those apart, which is deliberate: a
 * different answer for "not yours" turns this into an enumeration oracle.
 */
const ORDER_FOR_USER = `SELECT id, public_id, status, total_irr, plan_id, kind, expires_at
     FROM orders
    WHERE id = ?1 AND user_id = ?2`;

export async function orderForUser(
  db: Db,
  userId: number,
  orderId: number,
): Promise<OwnedOrder | null> {
  return db.prepare(ORDER_FOR_USER).bind(orderId, userId).first<OwnedOrder>();
}

/**
 * The same row, held until the transaction ends.
 *
 * For the callers about to act on `status` — spend a balance, open a claim — a
 * plain read is count-then-act: the expiry sweep can close the order in the gap
 * and the decision is made against a status that is no longer true. The lock is
 * what makes the status the caller reads still the status when it writes.
 *
 * One statement, not a read followed by a lock, and one SQL string shared with
 * the unlocked version: ownership has to be proved in the same snapshot the
 * lock is taken in, and two copies of this query would drift.
 */
export async function lockOrderForUser(
  db: Db,
  userId: number,
  orderId: number,
): Promise<OwnedOrder | null> {
  return db.prepare(`${ORDER_FOR_USER} FOR UPDATE`).bind(orderId, userId).first<OwnedOrder>();
}

export interface OwnedSubscription {
  id: number;
  public_id: string;
  status: string;
  plan_name_at_sale: string;
  provider_name_at_sale: string | null;
  remote_username: string | null;
  subscription_url: string | null;
  /** `numeric` and `int8` both come back as numbers — packages/db sets the
   *  type parsers, and refuses any value a JS number would round. */
  volume_gb: number | null;
  used_bytes: number | null;
  duration_days: number | null;
  expires_at: string | null;
  last_synced_at: string | null;
  purchased_at: string;
}

/**
 * Whether a service is still usable — the SQL half of `menu.serviceState`.
 *
 * It exists because `status` alone is the wrong thing to sort on, and looking
 * at the real screen is what showed it: three services, all `status = 'ACTIVE'`,
 * one of them four days past its date, and the expired one sat at the top of
 * the customer's list. Sorting on `status` had looked right in a test, because
 * that test used a DISABLED row — the one case where `status` does move.
 *
 * The predicate is duplicated, not shared, because one side is SQL and the
 * other is TypeScript. If one changes the other must: the glyph beside a row
 * and the position of that row have to agree, or the list reads as sorted by
 * nothing.
 *
 * Which is exactly why the clock is a PARAMETER and not `now()`.
 *
 * It was `now()` until 2026-08-23, and that quietly gave the two halves two
 * different clocks — Postgres's for the position, the bot process's for the
 * glyph. `services.test.ts` pins `Date.now()` and its fixture expired at
 * 2026-08-23T12:00:00Z, so at noon UTC that day the suite went red on a run
 * that had been green twenty-seven minutes earlier, with no commit in between:
 * SQL had moved past the date and TypeScript had not. A test tied to a fixed
 * date over code reading the real clock is the house's own rule 5, and this is
 * what it looks like when it goes off.
 *
 * The customer-visible half is smaller and real: the two clocks are on two
 * machines. While they disagree, a service can carry ⌛ and still sit at the
 * top of the list, or carry no glyph and sit at the bottom. Binding one clock
 * makes that impossible rather than unlikely.
 */
const USABLE = `(
  status = 'ACTIVE'
  AND (expires_at IS NULL OR expires_at > to_timestamp(?4 / 1000.0))
  AND (volume_gb IS NULL OR volume_gb <= 0 OR used_bytes IS NULL
       OR used_bytes < volume_gb * 1073741824)
)`;

const SUBSCRIPTION_COLUMNS = `
  id, public_id, status, plan_name_at_sale, provider_name_at_sale,
  remote_username, subscription_url, volume_gb, used_bytes,
  duration_days, expires_at, last_synced_at, purchased_at
`;

/**
 * Everything this customer owns, newest first, with the live ones on top.
 *
 * `PENDING_PAYMENT` rows are excluded. They are the shell of a purchase that
 * was never completed — there is nothing to show and nothing to tap, and
 * listing them next to real services is how a customer comes to support asking
 * why a service they never paid for does not work.
 *
 * Paged rather than capped. Four customers in production have more than ten
 * services and one has forty-five, and they are the resellers — showing them
 * the first eight and silently dropping the rest would hit exactly the people
 * who use this screen most.
 */
export async function subscriptionsForUser(
  db: Db,
  userId: number,
  limit: number,
  offset = 0,
): Promise<OwnedSubscription[]> {
  const rows = await db
    .prepare(
      `SELECT ${SUBSCRIPTION_COLUMNS}
         FROM subscriptions
        WHERE user_id = ?1 AND status <> 'PENDING_PAYMENT' AND hidden_at IS NULL
        ORDER BY ${USABLE} DESC, purchased_at DESC, id DESC
        LIMIT ?2 OFFSET ?3`,
    )
    .bind(userId, limit, offset, Date.now())
    .all<OwnedSubscription>();
  return rows.results;
}

/** How many rows the list above can page through. */
export async function countSubscriptionsForUser(db: Db, userId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*)::int AS n FROM subscriptions
        WHERE user_id = ?1 AND status <> 'PENDING_PAYMENT' AND hidden_at IS NULL`,
    )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * A service that can be extended, together with the panel it lives on.
 *
 * `provider_config` comes along because two of the admin's own settings live
 * in it — whether this panel may be renewed at all, and whether a renewal adds
 * to what is there or resets it. Both were set in the old bot and both are
 * honoured (`renewAllowed`, `renewModeFor`).
 */
export interface RenewableSubscription {
  id: number;
  public_id: string;
  status: string;
  plan_name_at_sale: string;
  /** The «لوکیشن» — the tier the list names beside the username. */
  provider_name_at_sale: string | null;
  remote_username: string;
  expires_at: string | null;
  volume_gb: number | null;
  used_bytes: number | null;
  /**
   * What the service remembers of its sale, for `matchingRenewalPlan`. NULL
   * `plan_id` on every migrated row; `duration_days` survived the import.
   */
  plan_id: number | null;
  duration_days: number | null;
  /**
   * What KIND of thing this is — `products.kind`: vpn, spotify, ai_account…
   *
   * Read through the plan it was sold under when that is still known, and
   * from the panel's own kind when it is not (every migrated row, every
   * trial): a PasarGuard panel sells VPN, a `spotify` panel sells Spotify.
   * Renewal offers only plans of the same kind — Sam, 2026-09-13: «سرویس
   * VPN می‌خواد تمدید کنه، یک دفعه نفرسته به بخش spotify».
   */
  family: string;
  provider_id: number;
  provider_name: string;
  provider_kind: string;
  provider_config: Record<string, unknown> | null;
}

/**
 * Which of this customer's services can be extended.
 *
 * The plan they originally bought is deliberately not part of the condition.
 * Half the live services were sold under a product that no longer exists —
 * 1,687 of 3,139 match a current product by name, and `subscriptions.plan_id`
 * is NULL for every migrated row — so requiring the original plan would tell
 * most customers their service cannot be renewed. What is required is an
 * account on a panel that is still there; the plan is chosen at the next step.
 *
 * `status = 'ACTIVE'` includes services whose date has passed. Those are the
 * ones most in need of renewal, and the row's status does not move on its own
 * (see `menu.serviceState`).
 *
 * ON_HOLD too — a paid account nobody has connected to yet (`send_on_hold` in
 * the PHP, which lists it for renewal beside `active`, `index.php:6355`). The
 * import brought 707 of them, and until 2026-09-17 every one was on «سرویس‌های
 * من» and missing from «تمدید سرویس».
 *
 * And DISABLED (#366). The PHP never wrote that word for a customer's own
 * switch-off — `confirmaccountdisable_` (`index.php:1458`) touches the panel
 * and leaves `invoice.Status` at `active`, so the service stayed renewable.
 * `actions.ts` records the same tap as DISABLED, and this list then lost it.
 * The renewal sends `status: active` back to the panel (`marzban.ts`, `renew`),
 * so paying does switch it on.
 *
 * Not a DISABLED the import brought: `disabledn` is «the panel no longer has
 * this account» (`index.php:935`), `disablebyadmin` is the admin's word
 * (`admin.php:10374`), and the PHP renewed neither. `legacy_status` keeps the
 * spelling, and a row our own bot switched off has none — or `active`.
 */
const RENEWABLE = `
  s.hidden_at IS NULL
  AND (s.status IN ('ACTIVE', 'ON_HOLD')
   OR (s.status = 'DISABLED'
       AND COALESCE(s.legacy_status, '') NOT IN ('disabled', 'disabledn', 'disablebyadmin')))
  AND s.remote_username IS NOT NULL
  -- «A panel that is still there» is an ACTIVE row at the service's address,
  -- not necessarily its own: since #271 the rows sharing an address are tiers
  -- of one panel, and renewalPanelsFor already offers every ACTIVE sibling.
  -- The list used to ask the service's OWN row to be ACTIVE, so an account on
  -- a tier the admin had retired from sale read «سرویسی برای تمدید ندارید»
  -- while the panel next to it could have renewed it. The PHP list asked the
  -- panel nothing at all (index.php:6355).
  AND EXISTS (
        SELECT 1 FROM provisioning_providers x
         WHERE x.status = 'ACTIVE'
           AND (x.id = pv.id OR NULLIF(x.base_url, '') = NULLIF(pv.base_url, ''))
      )
  -- An account from the shelf is bought, not extended: there is no panel to
  -- add days to, and «renewing» it used to take the money and put the order
  -- in a queue nobody could see. Sam, 2026-09-15: «اکانتها یک بار مصرف هستن و
  -- قابلیت تمدید ندارن» — the customer buys the next one from the shelf.
  AND pv.kind IN (${AUTOMATED_KINDS_SQL})
`;

const RENEWABLE_COLUMNS = `
  s.id, s.public_id, s.status, s.plan_name_at_sale, s.provider_name_at_sale,
  s.remote_username, s.expires_at,
  s.volume_gb, s.used_bytes, s.plan_id, s.duration_days,
  COALESCE(
    (SELECT p.kind FROM product_plans pl JOIN products p ON p.id = pl.product_id
      WHERE pl.id = s.plan_id),
    CASE WHEN pv.kind IN ('ai_account', 'spotify', 'manual') THEN pv.kind ELSE 'vpn' END
  ) AS family,
  pv.id AS provider_id, pv.name AS provider_name, pv.kind AS provider_kind,
  pv.config AS provider_config
`;

export async function renewableForUser(
  db: Db,
  userId: number,
  limit: number,
  offset = 0,
): Promise<RenewableSubscription[]> {
  const rows = await db
    .prepare(
      `SELECT ${RENEWABLE_COLUMNS}
         FROM subscriptions s
         JOIN provisioning_providers pv ON pv.id = s.provider_id
        WHERE s.user_id = ?1 AND ${RENEWABLE}
        ORDER BY s.expires_at NULLS LAST, s.id
        LIMIT ?2 OFFSET ?3`,
    )
    .bind(userId, limit, offset)
    .all<RenewableSubscription>();
  return rows.results;
}

export async function countRenewableForUser(db: Db, userId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*)::int AS n
         FROM subscriptions s
         JOIN provisioning_providers pv ON pv.id = s.provider_id
        WHERE s.user_id = ?1 AND ${RENEWABLE}`,
    )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** One renewable service, and only if it is this customer's. */
export async function renewableForUserById(
  db: Db,
  userId: number,
  subscriptionId: number,
): Promise<RenewableSubscription | null> {
  return db
    .prepare(
      `SELECT ${RENEWABLE_COLUMNS}
         FROM subscriptions s
         JOIN provisioning_providers pv ON pv.id = s.provider_id
        WHERE s.id = ?1 AND s.user_id = ?2 AND ${RENEWABLE}`,
    )
    .bind(subscriptionId, userId)
    .first<RenewableSubscription>();
}

/**
 * The lookup Mirzabot gets wrong. `subscriptionurl_<id>` there loads by id
 * alone and returns the subscription URL to whoever asked; here the row simply
 * does not exist for anyone but its owner.
 */
export async function subscriptionForUser(
  db: Db,
  userId: number,
  subscriptionId: number,
): Promise<OwnedSubscription | null> {
  return db
    .prepare(
      `SELECT ${SUBSCRIPTION_COLUMNS}
         FROM subscriptions
        WHERE id = ?1 AND user_id = ?2 AND status <> 'PENDING_PAYMENT' AND hidden_at IS NULL`,
    )
    .bind(subscriptionId, userId)
    .first<OwnedSubscription>();
}

/** A service together with the panel it lives on — for the buttons that call it. */
export interface OwnedSubscriptionOnPanel extends OwnedSubscription {
  provider_id: number | null;
  provider_code: string | null;
  provider_name: string | null;
  provider_kind: string | null;
  provider_base_url: string | null;
  provider_secret_ref: string | null;
  provider_sealed: string | null;
  provider_config: Record<string, unknown> | null;
}

/**
 * The same row, plus its panel.
 *
 * A second function rather than more columns on `subscriptionForUser`, because
 * the panel's `config` carries a shared secret (see migrations/0002) and the
 * detail screen has no use for it. Reading it only where a panel call is about
 * to happen keeps it out of every other query's result.
 *
 * The panel is the one the ACCOUNT was sold on — `subscriptions.provider_id` —
 * not the one its plan points at today. They can differ: a config from the
 * shelf, or a plan moved between panels after the sale.
 */
export async function subscriptionOnPanelForUser(
  db: Db,
  userId: number,
  subscriptionId: number,
): Promise<OwnedSubscriptionOnPanel | null> {
  return db
    .prepare(
      `SELECT ${SUBSCRIPTION_COLUMNS.split(',')
        .map((c) => `s.${c.trim()}`)
        .join(', ')},
              pv.id         AS provider_id,
              pv.code       AS provider_code,
              pv.name       AS provider_name,
              pv.kind       AS provider_kind,
              pv.base_url   AS provider_base_url,
              pv.secret_ref AS provider_secret_ref,
              -- Carried by the join that was already here rather than
              -- fetched separately, so credentialsFor stays synchronous and
              -- no call site grows a second round trip. (No backticks in a
              -- SQL comment that lives inside a template literal: they end
              -- the string, which is exactly what happened writing this.)
              ps.sealed     AS provider_sealed,
              pv.config     AS provider_config
         FROM subscriptions s
         LEFT JOIN provisioning_providers pv ON pv.id = s.provider_id
         LEFT JOIN provider_secrets ps ON ps.provider_id = pv.id
        WHERE s.id = ?1 AND s.user_id = ?2 AND s.status <> 'PENDING_PAYMENT'
          AND s.hidden_at IS NULL`,
    )
    .bind(subscriptionId, userId)
    .first<OwnedSubscriptionOnPanel>();
}

/**
 * «🗑 حذف از فهرست» — take a dead service off this customer's list.
 *
 * The one write in this file, here because it is scoped the same way as every
 * read: `AND user_id = ?2`. It sets `hidden_at` and nothing else — the panel is
 * not called, the row is not deleted, and `remove.ts` still sweeps the panel.
 *
 * «Dead» is decided HERE, not by the button. The button is only drawn when
 * `menu.canHide` says so, but it stays pressable after a renewal brings the
 * service back, and callback data can be forged. The predicate is `USABLE`
 * negated, plus the two statuses that never come back — the same four states
 * `canHide` names (EXPIRED, EXHAUSTED, REMOVED, FAILED), on Postgres's clock.
 *
 * Returns false for someone else's row, a live one, or one already hidden.
 */
export async function hideDeadServiceForUser(
  db: Db,
  userId: number,
  subscriptionId: number,
  telegramUserId: number,
  now: number,
): Promise<boolean> {
  const hidden = await db
    .prepare(
      `UPDATE subscriptions
          SET hidden_at = to_timestamp(?3 / 1000.0)
        WHERE id = ?1 AND user_id = ?2 AND hidden_at IS NULL
          AND (status IN ('REMOVED', 'FAILED') OR (status = 'ACTIVE' AND NOT ${USABLE}))
        RETURNING id`,
    )
    // `now` twice: `USABLE` reads its clock from ?4, as it does in the list.
    .bind(subscriptionId, userId, now, now)
    .first<{ id: number }>();
  if (!hidden) return false;
  // SYSTEM, as every row this bot writes: the CHECK on actor_role has no word
  // for a customer, and who pressed the button is in after_json.
  await db
    .prepare(
      `INSERT INTO audit_logs
         (id, actor_email, actor_role, action, entity_type, entity_id,
          before_json, after_json, reason, created_at)
       VALUES (?1, NULL, 'SYSTEM', 'subscription.hidden', 'SUBSCRIPTION', ?2,
               NULL, ?3::text, ?4, ?5)`,
    )
    .bind(
      randomUUID(),
      String(subscriptionId),
      JSON.stringify({ hiddenByCustomer: true, telegramUserId: String(telegramUserId) }),
      'the customer pressed «حذف از فهرست» on a dead service',
      now,
    )
    .run();
  return true;
}

/**
 * A reseller's franchise (#474) — the row that makes somebody the owner of a
 * PasarGuard admin on one of our panels, with what the panel screen and the
 * sale need to know about that panel.
 *
 * Here for the reason this file exists: «🏢 پنل نمایندگی» carries the row's id
 * in `callback_data`, which anybody can post, and the id of another reseller's
 * row must find nothing. CLOSED rows are over and find nothing either.
 */
export interface OwnedResellerAccount {
  id: number;
  name: string;
  /** PENDING (no panel admin yet), ACTIVE or SUSPENDED — never CLOSED. */
  status: string;
  panel_admin_username: string;
  /** Our ledger of what they bought, bytes. NULL: not bought through us yet. */
  data_limit_bytes: string | number | null;
  expires_at: string | null;
  provider_id: number;
  provider_code: string;
  provider_name: string;
  provider_kind: string;
  provider_base_url: string | null;
  provider_secret_ref: string | null;
  provider_sealed: string | null;
  provider_config: Record<string, unknown> | null;
  /** The meter's latest reading of the panel's own counter, and when. */
  used_bytes: string | number | null;
  read_at: string | null;
}

const RESELLER_ACCOUNT_SELECT = `
  SELECT ra.id, ra.name, ra.status, ra.panel_admin_username, ra.data_limit_bytes,
         ra.expires_at::text AS expires_at,
         pv.id AS provider_id, pv.code AS provider_code, pv.name AS provider_name,
         pv.kind AS provider_kind, pv.base_url AS provider_base_url,
         pv.secret_ref AS provider_secret_ref, ps.sealed AS provider_sealed,
         pv.config AS provider_config,
         snap.used_bytes, snap.taken_at::text AS read_at
    FROM reseller_accounts ra
    JOIN provisioning_providers pv ON pv.id = ra.provider_id
    LEFT JOIN provider_secrets ps ON ps.provider_id = pv.id
    LEFT JOIN LATERAL (
      SELECT s.used_bytes, s.taken_at FROM reseller_usage_snapshots s
       WHERE s.reseller_id = ra.id
       ORDER BY s.taken_at DESC, s.id DESC
       LIMIT 1
    ) snap ON TRUE
   WHERE ra.user_id = ?1 AND ra.status <> 'CLOSED'`;

export async function resellerAccountsForUser(
  db: Db,
  userId: number,
): Promise<OwnedResellerAccount[]> {
  const { results } = await db
    .prepare(`${RESELLER_ACCOUNT_SELECT} ORDER BY ra.id`)
    .bind(userId)
    .all<OwnedResellerAccount>();
  return results ?? [];
}

export async function resellerAccountForUser(
  db: Db,
  userId: number,
  accountId: number,
): Promise<OwnedResellerAccount | null> {
  return db
    .prepare(`${RESELLER_ACCOUNT_SELECT} AND ra.id = ?2`)
    .bind(userId, accountId)
    .first<OwnedResellerAccount>();
}
