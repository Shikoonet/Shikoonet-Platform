/**
 * Selling a reseller their own panel's volume — the rules both the bot and the
 * dashboard read, so the screen and the shop cannot disagree (#474).
 *
 * A reseller owns an ADMIN account on one of our PasarGuard panels
 * (`reseller_accounts`, 0060). The panel enforces that admin's `data_limit`
 * itself; what the shop sells is more of it, in whole terabytes, priced by
 * tier. Everything here is pure: it reads a panel's `config`, prices an order,
 * and says whether an admin the panel reported may be written to.
 */

/**
 * A tebibyte. PasarGuard counts in bytes and `marzban.ts` sells gigabytes as
 * 1024³, so a terabyte is 1024 of those — the same unit the panel's own screen
 * shows.
 */
export const TIB = 1024 ** 4;

/**
 * The most terabytes one order may carry, whatever the price cap allows.
 *
 * Far above anything a shop sells in one transfer, and far below the real
 * ceiling, which is JavaScript's: a byte count past 2^53 — 8192 TiB — is no
 * longer an exact number here, and the ledger is read back into one.
 */
export const RESELLER_MAX_TB = 1000;

/**
 * The most a reseller's ledger may hold, in bytes: the largest exact integer
 * JavaScript has. The delivery sweep refuses an order that would pass it
 * rather than write a total it can no longer read back exactly.
 */
export const RESELLER_MAX_TOTAL_BYTES = Number.MAX_SAFE_INTEGER;

/** One step of the price table: from this many terabytes, this much each. */
export interface ResellerTier {
  fromTb: number;
  /** IRR, per terabyte. */
  pricePerTbIrr: number;
}

export interface ResellerSale {
  /** Ascending by `fromTb`, never empty. The first `fromTb` is the minimum order. */
  tiers: ResellerTier[];
  /** The PasarGuard role a panel the bot creates is given. Null: the bot creates none. */
  roleId: number | null;
  /** Days a panel the bot creates may run before its deadline. Null: no deadline. */
  termDays: number | null;
  /**
   * The most one order may cost, IRR. Null: the shop's card-to-card ceiling.
   * One order is one transfer, because auto-verification matches exactly one.
   */
  maxOrderIrr: number | null;
}

/** The `config` key, one object so the four settings travel together. */
export const RESELLER_SALE_KEY = 'reseller_sale';

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * What a panel sells to resellers, or null when it sells nothing.
 *
 * Defensive rather than trusting: `config` is operator-edited jsonb, and a
 * malformed table must read as «not for sale», never as a price of zero or a
 * tier out of order. The dashboard validates on the way in; this is the check
 * on the way out, for a row restored or edited by hand.
 */
export function resellerSaleFor(config: Record<string, unknown>): ResellerSale | null {
  const raw = config[RESELLER_SALE_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const sale = raw as Record<string, unknown>;
  if (!Array.isArray(sale['tiers']) || sale['tiers'].length === 0) return null;
  const tiers: ResellerTier[] = [];
  for (const entry of sale['tiers'] as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null;
    const fromTb = positiveInt((entry as Record<string, unknown>)['from_tb']);
    const pricePerTbIrr = positiveInt((entry as Record<string, unknown>)['price_per_tb_irr']);
    if (fromTb === null || pricePerTbIrr === null || fromTb > RESELLER_MAX_TB) return null;
    const last = tiers[tiers.length - 1];
    if (last !== undefined && fromTb <= last.fromTb) return null;
    tiers.push({ fromTb, pricePerTbIrr });
  }
  const roleId = positiveInt(sale['role_id']);
  return {
    tiers,
    // Role 1 is PasarGuard's owner and the panel refuses to assign it; reading
    // it as «not configured» keeps the bot from ever trying.
    roleId: roleId !== null && roleId > 1 ? roleId : null,
    termDays: positiveInt(sale['term_days']),
    maxOrderIrr: positiveInt(sale['max_order_irr']),
  };
}

/**
 * The price of `tb` terabytes: the WHOLE order at the rate of the tier its
 * total falls into (Sam, 2026-09-26). Null below the first tier.
 *
 * So a bigger order can cost less than a smaller one — with tiers from 1 at 3M
 * and from 3 at 2M, three terabytes cost 6M and two cost 6M as well. That is
 * the rule Sam chose over graduated pricing, knowingly.
 */
export function resellerPrice(
  tiers: readonly ResellerTier[],
  tb: number,
): { unitIrr: number; totalIrr: number } | null {
  if (!Number.isSafeInteger(tb) || tb <= 0 || tb > RESELLER_MAX_TB) return null;
  let rate: number | null = null;
  for (const tier of tiers) if (tb >= tier.fromTb) rate = tier.pricePerTbIrr;
  if (rate === null) return null;
  const totalIrr = rate * tb;
  return Number.isSafeInteger(totalIrr) ? { unitIrr: rate, totalIrr } : null;
}

/**
 * The largest order that fits under the cap, or null when not even the
 * smallest does.
 *
 * Walked rather than solved, because whole-order pricing is not monotonic: a
 * tier boundary can make a larger order cheaper, so «the first size over the
 * cap» is not the end of the sizes under it. `RESELLER_MAX_TB` bounds the walk.
 */
export function maxOrderTb(tiers: readonly ResellerTier[], capIrr: number): number | null {
  let best: number | null = null;
  for (let tb = 1; tb <= RESELLER_MAX_TB; tb++) {
    const price = resellerPrice(tiers, tb);
    if (price !== null && price.totalIrr <= capIrr) best = tb;
  }
  return best;
}

/**
 * The role a panel admin must carry before the bot writes to it.
 *
 * `role` as `GET /api/admins` reports it. The bot raises this admin's limit and
 * may set its password, so the role must not let its holder manage anything but
 * their own users: an admin that can edit admins can raise its own limit or
 * zero its own usage and never pay, and one that can touch nodes, hosts or
 * settings reaches every other customer on the panel.
 *
 * Every action is `true` (allowed, no scope), `{ scope: n }`, or absent/null
 * (denied). Allowed:
 *   - on `users`: actions scoped to their own (`scope <= 1`), and never
 *     `set_owner`, which moves somebody else's customer under them;
 *   - anywhere else: reading (`read`, `read_simple`, `read_general`, `stats`,
 *     `logs`) — a reseller's own dashboard lists groups and hosts to use them.
 * Anything else, or a shape this does not recognise, is refused.
 */
const READ_ACTIONS = new Set(['read', 'read_simple', 'read_general', 'stats', 'logs']);

export function isSafeResellerRole(
  role: { isOwner: boolean; permissions: unknown } | null,
): boolean {
  if (role === null || role.isOwner) return false;
  const permissions = role.permissions;
  if (permissions === null || permissions === undefined) return true;
  if (typeof permissions !== 'object' || Array.isArray(permissions)) return false;
  for (const [resource, actions] of Object.entries(permissions as Record<string, unknown>)) {
    if (actions === null || actions === undefined) continue;
    if (typeof actions !== 'object' || Array.isArray(actions)) return false;
    for (const [action, value] of Object.entries(actions as Record<string, unknown>)) {
      if (value === null || value === undefined || value === false) continue;
      if (resource === 'users') {
        if (action === 'set_owner') return false;
        const scope =
          typeof value === 'object' && value !== null
            ? (value as Record<string, unknown>)['scope']
            : undefined;
        if (typeof scope !== 'number' || scope > 1) return false;
        continue;
      }
      if (!READ_ACTIONS.has(action)) return false;
    }
  }
  return true;
}

/**
 * A panel admin name the bot may create: what PasarGuard's own user names
 * allow, and no longer than the admin column holds (`String(34)`). The panel
 * validates admin names not at all — a 35-character one was accepted on SQLite
 * in the #474 probe — so this is the only check there is.
 */
export const RESELLER_USERNAME = /^[A-Za-z0-9_.-]{3,34}$/;

/** What the bot writes into the `note` of an admin it created for reseller `id`. */
export function resellerNote(id: number): string {
  return `shikoo:reseller:${id}`;
}

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
/**
 * PasarGuard's own special set minus `<`, `>`, `&`, `"` and the backtick:
 * the bot sends the password inside an HTML `<code>` span, where the first
 * three need escaping and the panel refuses the quote.
 */
const SPECIAL = '!@#$%^*()-_=+[]{}|;:,.?/~';
const ALPHABET = LOWER + UPPER + DIGITS + SPECIAL;

function pick(set: string, random: (n: number) => number): string {
  return set[random(set.length)]!;
}

/** An unbiased index in [0, n), from Web Crypto. */
function cryptoIndex(n: number): number {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % n;
  }
}

/**
 * A password PasarGuard 5.2.1 accepts: at least 12 characters and 72 bytes at
 * most, two digits, two upper-case, two lower-case, one special, no `"`.
 * Twenty characters with the classes guaranteed and the rest drawn from all of
 * them, then shuffled so the guaranteed ones are not always at the front.
 * Look-alikes (`l`, `I`, `O`, `0`, `1`) are left out: this is read off a phone.
 */
export function generatePanelPassword(random: (n: number) => number = cryptoIndex): string {
  const chars = [
    pick(LOWER, random),
    pick(LOWER, random),
    pick(UPPER, random),
    pick(UPPER, random),
    pick(DIGITS, random),
    pick(DIGITS, random),
    pick(SPECIAL, random),
  ];
  while (chars.length < 20) chars.push(pick(ALPHABET, random));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
