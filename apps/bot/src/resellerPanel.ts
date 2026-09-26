/**
 * «🏢 پنل نمایندگی» — what the bot checks before a reseller pays, and the
 * password button (#474).
 *
 * A reseller owns an admin on one of our PasarGuard panels (`reseller_accounts`,
 * 0060) and buys more of its `data_limit` here. Delivery is `provision.ts`'s,
 * like every other paid order; this file is everything that happens while the
 * reseller is still looking at the screen.
 *
 * ## Why the panel is asked BEFORE the order exists
 *
 * Card money cannot be given back by the bot — `fail()` refunds only what the
 * wallet paid, and a reseller order takes nothing from the wallet. So every
 * reason a delivery would fail after the transfer (the admin is not theirs, the
 * role can do too much, the name is taken, the panel sells nothing) is asked
 * here first, while nothing has been paid, and the reseller hears «not ready»
 * instead of transferring millions into a refund. The same checks run again at
 * delivery: this is the cheap place to be told, not the only guard.
 */

import type { D1DatabaseSession } from '@shikoo/database';
import {
  adapterFor,
  generatePanelPassword,
  isSafeResellerRole,
  maxOrderTb,
  RESELLER_CARDS,
  resellerSaleFor,
  type PanelAdmin,
  type ProviderContext,
  type ProvisioningAdapter,
  type ResellerSale,
} from '@shikoo/domain';
import type { OwnedResellerAccount } from './owned.js';
import { credentialsFor } from './provision.js';

/** The adapter calls a sale needs, all four present — or null when this panel kind cannot sell. */
export type ResellerAdapter = Required<
  Pick<
    ProvisioningAdapter,
    'getPanelAdmin' | 'getPanelRole' | 'createPanelAdmin' | 'setPanelAdmin' | 'listPanelAdmins'
  >
>;

export function resellerAdapterFor(kind: string): ResellerAdapter | null {
  const a = adapterFor(kind);
  if (!a.getPanelAdmin || !a.getPanelRole || !a.createPanelAdmin) return null;
  if (!a.setPanelAdmin || !a.listPanelAdmins) return null;
  return a as ResellerAdapter;
}

export function resellerProvider(
  account: Pick<
    OwnedResellerAccount,
    | 'provider_id'
    | 'provider_code'
    | 'provider_name'
    | 'provider_base_url'
    | 'provider_secret_ref'
    | 'provider_sealed'
    | 'provider_config'
  >,
  fetchImpl: typeof globalThis.fetch,
): ProviderContext {
  return {
    id: account.provider_id,
    code: account.provider_code,
    name: account.provider_name,
    baseUrl: account.provider_base_url,
    credentials: credentialsFor(account.provider_secret_ref, account.provider_sealed),
    config: account.provider_config ?? {},
    fetch: fetchImpl,
  };
}

/**
 * Whether this panel admin is provably this reseller's, and safe to write to.
 *
 * All four, every time:
 *   - its Telegram id is the reseller's. PasarGuard keeps Telegram ids unique
 *     across admins, the bot sets it on an admin it creates, and an operator
 *     sets it by hand on one that existed before — that is the operator saying
 *     «this admin is theirs». A typo in the dashboard that names somebody
 *     else's admin fails here, because that admin carries somebody else's id;
 *   - it carries the reseller role the panel config names, and
 *   - that role manages nothing but its own users (`isSafeResellerRole`) — a
 *     role that can edit admins could raise its own limit and never pay;
 *   - it is not the bot's own login. An owner may edit itself, so without this
 *     a row naming the shop's own admin would let a reseller reset its password.
 */
export function ownsPanelAdmin(
  admin: PanelAdmin,
  telegramId: number,
  sale: ResellerSale,
  botLogin: string | null,
): boolean {
  return (
    admin.telegramId === telegramId &&
    sale.roleId !== null &&
    admin.role !== null &&
    admin.role.id === sale.roleId &&
    isSafeResellerRole(admin.role) &&
    admin.username !== botLogin
  );
}

export type Readiness =
  | {
      ok: true;
      sale: ResellerSale;
      /** Terabytes: the smallest order, and the largest one transfer can pay. */
      minTb: number;
      maxTb: number;
      capIrr: number;
    }
  /** `reason` is for the operator's report; the reseller is told one sentence. */
  | { ok: false; reason: string };

function number(value: string | number | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Can this reseller buy right now? Asked of the panel itself.
 *
 * Also the one place a reseller's ledger is SEEDED: a panel admin that existed
 * before the bot sold to it has a limit we never recorded, and the first sale
 * must add to that limit, not to zero. Seeded only while the column is still
 * NULL, from the panel's own figure. After that the ledger is ours, and a
 * panel that disagrees with it — somebody raised the limit by hand — is
 * refused rather than silently absorbed: the operator settles it on the
 * dashboard first.
 */
export async function checkReady(
  tx: D1DatabaseSession,
  account: OwnedResellerAccount,
  telegramId: number,
  shopCapIrr: number,
  fetchImpl: typeof globalThis.fetch,
): Promise<Readiness> {
  const sale = resellerSaleFor(account.provider_config ?? {});
  if (sale === null) return { ok: false, reason: 'this panel has no reseller price table' };
  const adapter = resellerAdapterFor(account.provider_kind);
  if (adapter === null) return { ok: false, reason: 'this panel kind cannot sell reseller volume' };

  const capIrr = sale.maxOrderIrr ?? shopCapIrr;
  const maxTb = maxOrderTb(sale.tiers, capIrr);
  if (maxTb === null) return { ok: false, reason: 'the smallest order costs more than the order cap' };

  const card = await tx
    .prepare(
      `SELECT 1 AS ok FROM payment_cards pc
         JOIN financial_accounts fa ON fa.id = pc.financial_account_id
        WHERE pc.status = 'ACTIVE' AND fa.active = 1 AND fa.status = 'ACTIVE'
          AND fa.customer_visible = ?1
        LIMIT 1`,
    )
    .bind(RESELLER_CARDS)
    .first<{ ok: number }>();
  if (!card) return { ok: false, reason: 'no active card is kept for resellers' };

  const provider = resellerProvider(account, fetchImpl);
  const username = account.panel_admin_username;

  if (account.status === 'PENDING') {
    if (sale.roleId === null) return { ok: false, reason: 'no reseller role is configured on this panel' };
    const role = await adapter.getPanelRole(provider, sale.roleId);
    if (!role.ok) return { ok: false, reason: role.reason };
    if (role.role === null) return { ok: false, reason: `role ${sale.roleId} does not exist on the panel` };
    if (!isSafeResellerRole(role.role)) {
      return { ok: false, reason: `role ${sale.roleId} may do more than manage its own users` };
    }
    // A listing rather than an exact lookup, for the two things it answers at
    // once: the name is free — compared without case, because a panel on MySQL
    // treats «Ali» and «ali» as one — and this Telegram id owns no admin yet,
    // which PasarGuard would refuse with the same 409.
    const all = await adapter.listPanelAdmins(provider);
    if (!all.ok) return { ok: false, reason: all.reason };
    if (all.admins.some((a) => a.username.toLowerCase() === username.toLowerCase())) {
      return { ok: false, reason: `the panel already has an admin named ${username}` };
    }
    const holder = all.admins.find((a) => a.telegramId === telegramId);
    if (holder) return { ok: false, reason: `this Telegram id already owns admin ${holder.username}` };
    return { ok: true, sale, minTb: sale.tiers[0]!.fromTb, maxTb, capIrr };
  }

  const found = await adapter.getPanelAdmin(provider, username);
  if (!found.ok) return { ok: false, reason: found.reason };
  if (found.admin === null) return { ok: false, reason: `the panel has no admin named ${username}` };
  if (!ownsPanelAdmin(found.admin, telegramId, sale, provider.credentials?.username ?? null)) {
    return {
      ok: false,
      reason: `admin ${username} is not provably this reseller's — its Telegram id and role must be set on the panel`,
    };
  }
  const panelLimit = found.admin.dataLimitBytes;
  if (panelLimit === null || panelLimit <= 0) {
    return { ok: false, reason: `admin ${username} is unlimited on the panel` };
  }
  const ours = number(account.data_limit_bytes);
  if (ours === null) {
    await tx
      .prepare(
        `UPDATE reseller_accounts SET data_limit_bytes = ?2, updated_at = now()
          WHERE id = ?1 AND data_limit_bytes IS NULL`,
      )
      .bind(account.id, panelLimit)
      .run();
  } else if (ours !== panelLimit) {
    // A sale still on its way explains a difference by itself: the ledger moves
    // before the panel does. Only with nothing in flight is it somebody's hand.
    const inFlight = await tx
      .prepare(
        `SELECT 1 AS n FROM orders
          WHERE target_reseller_id = ?1 AND status IN ('PAID', 'PROVISIONING')
          LIMIT 1`,
      )
      .bind(account.id)
      .first<{ n: number }>();
    if (!inFlight) {
      return {
        ok: false,
        reason: `the panel limit of ${username} (${panelLimit} bytes) is not the ${ours} this shop sold`,
      };
    }
  }
  return { ok: true, sale, minTb: sale.tiers[0]!.fromTb, maxTb, capIrr };
}

export type PasswordResult = { ok: true; password: string } | { ok: false; reason: string };

/**
 * «🔑 رمز جدید»: a new password on the reseller's own admin.
 *
 * Generated here, after the reseller confirmed, and handed straight back — it
 * never touches `bot_sessions`, the outbox or a log, and the caller sends it
 * as a message of its own (see `handle.ts`). The panel call is the last step,
 * so a refusal anywhere before it changes nothing.
 */
export async function resetPanelPassword(
  account: OwnedResellerAccount,
  telegramId: number,
  fetchImpl: typeof globalThis.fetch,
): Promise<PasswordResult> {
  if (account.status === 'PENDING') return { ok: false, reason: 'the panel admin does not exist yet' };
  const sale = resellerSaleFor(account.provider_config ?? {});
  const adapter = resellerAdapterFor(account.provider_kind);
  if (sale === null || adapter === null) return { ok: false, reason: 'this panel does not sell to resellers' };
  const provider = resellerProvider(account, fetchImpl);
  const found = await adapter.getPanelAdmin(provider, account.panel_admin_username);
  if (!found.ok) return { ok: false, reason: found.reason };
  if (found.admin === null) return { ok: false, reason: 'the panel has no such admin' };
  if (!ownsPanelAdmin(found.admin, telegramId, sale, provider.credentials?.username ?? null)) {
    return { ok: false, reason: 'the admin is not provably this reseller\'s' };
  }
  const password = generatePanelPassword();
  const set = await adapter.setPanelAdmin(provider, account.panel_admin_username, { password });
  return set.ok ? { ok: true, password } : { ok: false, reason: set.reason };
}

/**
 * Where the reseller signs in: the panel's address plus its dashboard path —
 * the same rule as `panelUserUrl` on the dashboard (`/dashboard` unless the
 * operator moved it with «مسیر داشبورد»), without the user deep link.
 */
export function panelLoginUrl(
  account: Pick<OwnedResellerAccount, 'provider_base_url' | 'provider_config'>,
): string | null {
  const base = account.provider_base_url?.replace(/\/+$/, '');
  if (!base) return null;
  const raw = (account.provider_config ?? {})['dashboard_path'];
  const configured = typeof raw === 'string' ? raw.trim() : '';
  const path = (configured || '/dashboard').replace(/^\/*/, '/').replace(/\/+$/, '');
  return `${base}${path}/`;
}
