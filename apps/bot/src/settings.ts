/**
 * The admin's settings, read from the table the migration filled.
 *
 * Until now nothing read `settings` — it existed so the migration had somewhere
 * to put 51 columns of a single-row MySQL table, and `docs/STATUS.md` said so
 * plainly. This is the first reader, and it exists because the alternative is
 * hard-coding the admin's own support handle into our source.
 *
 * Values are stored as JSON, and what MySQL handed over was text — so `10` is
 * the string `"10"` and a missing setting is the JSON `null`. Both are handled
 * here rather than at every call site.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';

type Db = D1Database | D1DatabaseSession;

export type SettingScope = 'bot' | 'shop' | 'pay' | 'panel';

/** The raw value, or null when the row is missing or holds JSON null. */
async function read(db: Db, scope: SettingScope, key: string): Promise<unknown> {
  const row = await db
    .prepare(`SELECT value FROM settings WHERE scope = ?1 AND key = ?2`)
    .bind(scope, key)
    .first<{ value: unknown }>();
  return row?.value ?? null;
}

/**
 * A setting as text, or null.
 *
 * An empty string is null too: the legacy row uses `''` for "not set" in
 * several places, and a support handle of `''` would render as `@`.
 */
export async function settingText(
  db: Db,
  scope: SettingScope,
  key: string,
): Promise<string | null> {
  const value = await read(db, scope, key);
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : String(value);
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * A setting as a number, or null when it is missing or not a number.
 *
 * Never throws and never guesses: a percentage that cannot be read is not a
 * percentage of zero, it is a percentage that must not be applied.
 */
export async function settingNumber(
  db: Db,
  scope: SettingScope,
  key: string,
): Promise<number | null> {
  const text = await settingText(db, scope, key);
  if (text === null) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** Whether a switch-shaped setting holds exactly the value that means "on". */
export async function settingIs(
  db: Db,
  scope: SettingScope,
  key: string,
  on: string,
): Promise<boolean> {
  return (await settingText(db, scope, key)) === on;
}

// ---------------------------------------------------------------------------
// The shop's own switches
// ---------------------------------------------------------------------------

/**
 * What the shop has turned on, and the numbers it charges by.
 *
 * The migration moved 51 columns of MySQL settings into this table and nothing
 * read the `shop` or `pay` scopes at all, so the bot offered buttons the admin
 * had switched off years ago. Three of them are off in production right now:
 * customers were being shown «افزودن حجم», «افزودن زمان» and the on/off switch
 * on a shop that does not sell any of them.
 *
 * Every field here has a default that is what the code did before it could
 * read the setting. A database that cannot be reached therefore behaves as the
 * last release did, rather than silently closing the shop.
 */
export interface ShopSettings {
  /** «افزودن حجم» — `shopSetting.statusextra`. */
  sellsExtraVolume: boolean;
  /** «افزودن زمان» — `shopSetting.statustimeextra`. */
  sellsExtraTime: boolean;
  /** The customer may turn their own service off and on — `statuschangeservice`. */
  allowsServiceSwitch: boolean;
  /** Referral commission on a referred customer's first purchase, in percent. */
  commissionPercent: number;
  /** Card-to-card deposit floor and ceiling, in IRR. */
  topupMinIrr: number;
  topupMaxIrr: number;
}

/**
 * The values as the code ships them.
 *
 * The three switches default to ON because that is what the bot did before it
 * read them: a shop whose settings row is missing keeps selling what it sold
 * yesterday. The numbers are production's own, verified against the dump on
 * 2026-08-15 — see `wallet.ts` for how the two card limits were established.
 */
export const DEFAULT_SHOP_SETTINGS: ShopSettings = {
  sellsExtraVolume: true,
  sellsExtraTime: true,
  allowsServiceSwitch: true,
  commissionPercent: 10,
  topupMinIrr: 800_000,
  topupMaxIrr: 100_000_000,
};

const CACHE_MS = 30_000;
let cached: { at: number; value: ShopSettings } | null = null;
let warned = false;

/** Drops the cache. For tests, and after an admin edit that must be seen now. */
export function invalidateShopSettings(): void {
  cached = null;
  warned = false;
}

/**
 * A legacy switch, which is off only when it holds exactly its "off" word.
 *
 * Deliberately not "on when it equals the on word". The `shopSetting` rows are
 * free text an old PHP admin panel wrote, and a value nobody recognises must
 * leave the feature as it was rather than turn it off — closing a shop because
 * of a typo is the worse failure.
 */
function isOff(value: string | null, offWord: string): boolean {
  return value === offWord;
}

/**
 * A percentage that may be applied.
 *
 * Refuses anything outside 0–100 rather than clamping. This multiplies real
 * money into a customer's wallet, and a row holding `1000` is a broken row, not
 * an instruction to pay ten times the purchase.
 */
function percent(value: number | null, fallback: number): number {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 100 ? value : fallback;
}

/**
 * A Toman limit from `PaySetting`, in IRR.
 *
 * The legacy column is Toman, like every customer-facing number in that
 * schema. `amountToman * 10` is the project's one conversion and it happens
 * here, at the edge, exactly once.
 */
function tomanLimit(value: number | null, fallback: number): number {
  if (value === null || !Number.isSafeInteger(value) || value <= 0) return fallback;
  return value * 10;
}

/**
 * The shop's switches, read once and cached.
 *
 * Cached for the same reason `botContent` is: the bot long-polls, these change
 * a few times a year, and thirty seconds is short enough that an admin who
 * flips a switch sees it on the next screen.
 *
 * A failed read returns the defaults and is not cached, so the setting takes
 * effect as soon as the database answers again.
 */
export async function loadShopSettings(db: Db, now = Date.now()): Promise<ShopSettings> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  try {
    const [extra, timeExtra, switchService, commission, min, max] = await Promise.all([
      settingText(db, 'shop', 'statusextra'),
      settingText(db, 'shop', 'statustimeextra'),
      settingText(db, 'shop', 'statuschangeservice'),
      settingNumber(db, 'bot', 'affiliatespercentage'),
      settingNumber(db, 'pay', 'minbalancecart'),
      settingNumber(db, 'pay', 'maxbalancecart'),
    ]);
    const value: ShopSettings = {
      // The "off" words are the legacy schema's, typos included:
      // `offtimeextraa` really does carry two a's in production.
      sellsExtraVolume: !isOff(extra, 'offextra'),
      sellsExtraTime: !isOff(timeExtra, 'offtimeextraa'),
      allowsServiceSwitch: !isOff(switchService, 'offstatus'),
      commissionPercent: percent(commission, DEFAULT_SHOP_SETTINGS.commissionPercent),
      topupMinIrr: tomanLimit(min, DEFAULT_SHOP_SETTINGS.topupMinIrr),
      topupMaxIrr: tomanLimit(max, DEFAULT_SHOP_SETTINGS.topupMaxIrr),
    };
    // A floor above the ceiling would leave no amount a customer could deposit.
    // Two rows edited one at a time can pass through that state, so the pair is
    // taken or refused together rather than half-applied.
    if (value.topupMinIrr > value.topupMaxIrr) {
      value.topupMinIrr = DEFAULT_SHOP_SETTINGS.topupMinIrr;
      value.topupMaxIrr = DEFAULT_SHOP_SETTINGS.topupMaxIrr;
    }
    cached = { at: now, value };
    warned = false;
    return value;
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn('[bot] could not load the shop settings, using defaults', err);
    }
    return DEFAULT_SHOP_SETTINGS;
  }
}
