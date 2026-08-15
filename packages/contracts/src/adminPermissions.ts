/**
 * What a bot admin is allowed to do, one key per thing the code actually gates.
 *
 * Deliberately short. A permission that no branch reads is a promise the panel
 * makes and nothing keeps — the admin ticks a box, believes an operator has been
 * restricted, and the operator carries on. So this list grows only when a
 * `can()` call is added beside the entry, never in advance.
 *
 * `admins.permissions` is `jsonb NOT NULL DEFAULT '{}'` and has been since
 * `0005_ops.sql`; no migration adds it. An empty object means "whatever this
 * role has always meant", which is what every existing row holds.
 */

export const ADMIN_PERMISSIONS = [
  'claims.view',
  'claims.approve',
  'claims.reject',
  'claims.approve_without_tx',
  'stats.view',
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export type BotAdminRole = 'OWNER' | 'ADMIN' | 'SUPPORT';

/** What the admin panel calls each one. */
export const ADMIN_PERMISSION_FA: Record<AdminPermission, string> = {
  'claims.view': 'دیدن پرداخت‌های در انتظار',
  'claims.approve': 'تایید پرداخت با تراکنش بانکی',
  'claims.reject': 'رد کردن پرداخت',
  'claims.approve_without_tx': 'تایید پرداخت بدون تراکنش بانکی',
  'stats.view': 'دیدن آمار فروشگاه (فروش، موجودی کیف پول‌ها)',
};

/**
 * What a role means when nobody has set anything.
 *
 * These are not new rules — they are exactly what the bot did before permissions
 * were readable, so an existing `admins` row behaves tomorrow as it did today.
 * SUPPORT could already look at the queue and could already not decide on it;
 * that guard shipped as one condition over four action names and this is its
 * generalisation, not its replacement.
 *
 * OWNER is absent on purpose: an owner is not a set of permissions that could be
 * edited down to nothing. See `may()`.
 */
const ROLE_DEFAULTS: Record<'ADMIN' | 'SUPPORT', readonly AdminPermission[]> = {
  ADMIN: ADMIN_PERMISSIONS,
  // Not `stats.view`. Mirza's three tiers put the figures with `Seller` and
  // withheld them from `support`, and the money the shop took today is not a
  // support operator's business. A shop that disagrees ticks the box.
  SUPPORT: ['claims.view'],
};

export function isAdminPermission(value: unknown): value is AdminPermission {
  return typeof value === 'string' && (ADMIN_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Whether this admin may do this thing.
 *
 * The OWNER always may. That is not a convenience: the panel that edits these
 * rows is reached through the bot, so an owner who could revoke their own
 * `claims.view` would lock the shop out of its own payment queue with no way
 * back in that does not involve SQL.
 *
 * An empty `permissions` falls back to the role's meaning rather than to
 * "nothing". Every row in production holds `{}` — reading it as a deny-all
 * would silently take the admin panel away from everyone at once.
 */
export function may(
  role: BotAdminRole,
  permissions: Readonly<Record<string, unknown>>,
  permission: AdminPermission,
): boolean {
  if (role === 'OWNER') return true;
  const granted = permissions[permission];
  if (granted === true) return true;
  if (granted === false) return false;
  return ROLE_DEFAULTS[role].includes(permission);
}

/**
 * The full set for a row, for the panel to render and for the bot to filter
 * buttons with.
 */
export function permissionsOf(
  role: BotAdminRole,
  permissions: Readonly<Record<string, unknown>>,
): AdminPermission[] {
  return ADMIN_PERMISSIONS.filter((p) => may(role, permissions, p));
}

/** Keeps only the keys we know, with boolean values. Anything else is dropped. */
export function cleanPermissions(input: unknown): Record<AdminPermission, boolean> | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {} as Record<AdminPermission, boolean>;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isAdminPermission(key)) return null;
    if (typeof value !== 'boolean') return null;
    out[key] = value;
  }
  return out;
}
