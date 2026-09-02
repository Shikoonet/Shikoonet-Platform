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
import { invalidateBotContent } from './botContent.js';
import { createLogger } from '@shikoo/domain';
import { checkPlanLabel, PLAN_LABEL_SETTING } from '@shikoo/contracts';

const log = createLogger('bot');

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
  /**
   * Whether the shop is open to customers at all — `setting.Bot_Status`.
   *
   * The admin's closed sign. Admins keep full access while it is down, which is
   * what makes it usable: `index.php:405` exempts them for the same reason, and
   * it is exactly the tool the cutover window needs — an announced pause where
   * the shop stops selling and the people running it can still walk the screens.
   */
  open: boolean;
  /** «افزودن حجم» — `shopSetting.statusextra`. */
  sellsExtraVolume: boolean;
  /** «افزودن زمان» — `shopSetting.statustimeextra`. */
  sellsExtraTime: boolean;
  /** The customer may turn their own service off and on — `statuschangeservice`. */
  allowsServiceSwitch: boolean;
  /**
   * The two clipboard buttons under the invoice — `setting.statuscopycart`.
   *
   * The bot has drawn them unconditionally since they were built; production
   * has the switch on, so nothing changes today. What changes is that an admin
   * who turns it off is now obeyed.
   */
  showsCopyButtons: boolean;
  /** The app-download button under the tutorials — `setting.linkappstatus`. */
  showsAppLink: boolean;
  /**
   * The QR button on a service — `shopSetting.configshow`.
   *
   * The legacy's button hands over the raw configs and ours hands over a QR of
   * the subscription link. Same question either way: may the customer be given
   * the thing they paste into their app from this screen.
   */
  showsConfigButton: boolean;
  /**
   * Where the shop's own reports go — `setting.Channel_Report`.
   *
   * One field, because for a while there were two answers to this question:
   * the nightly report read `REPORT_CHAT_ID` from the environment and the
   * flood guard read this column, and nothing made them agree. Two readers of
   * "the report channel" that can disagree is a bug waiting for the day
   * somebody changes one of them.
   *
   * The shop's row wins when it has one. `REPORT_CHAT_ID` is the fallback for
   * a database whose settings have never been migrated — which is exactly the
   * practice box — and it is applied by the caller, not here, because this
   * file describes what the SHOP says and knows nothing about the process it
   * is running in.
   *
   * Null means the shop has not configured one, which is not an error: the
   * legacy skips the send the same way on `strlen(...) > 0`.
   */
  reportChatId: number | null;
  /** Referral commission on a referred customer's first purchase, in percent. */
  commissionPercent: number;
  /**
   * What a renewal pays back into the customer's wallet, in percent —
   * `shopSetting.chashbackextend`, which is 5 in production.
   *
   * Its default is 0 while every other field's default is what production does,
   * and the difference is deliberate: the others describe behaviour the bot
   * already had, this one moves money out of the shop. A settings read that
   * fails must not start paying a percentage nobody could confirm.
   *
   * But a zero that means "we could not ask" is not a zero the shop chose, and
   * spending it costs the customer their cashback. `fromDatabase` separates the
   * two, and the renewal path refuses to run on the guess rather than pay it.
   */
  renewCashbackPercent: number;
  /** Card-to-card deposit floor and ceiling, in IRR. */
  topupMinIrr: number;
  topupMaxIrr: number;
  /**
   * When the two «running out» warnings fire — `setting.daywarn` and
   * `setting.volumewarn`, both 2 and 1 in production.
   *
   * These were constants carrying exactly the production values, with a comment
   * saying where they came from. That is the same shape as every other setting
   * this bot used to ignore: right on the day it was written, and silently wrong
   * the first time the admin moves the number.
   */
  warnDays: number;
  warnVolumeGb: number;
  /**
   * How many free accounts one customer may ever take -
   * `setting.limit_usertest_all`, which is 1 in production.
   *
   * Shop-wide, not per panel, because that is where legacy keeps it and
   * because the thing being rationed is the customer rather than the panel:
   * `users.test_quota_used` counts every trial they have taken anywhere. The
   * per-panel settings say how BIG a trial is, not how many.
   *
   * Zero switches trials off everywhere, and is honoured: an admin who sets
   * it to zero has said something clear.
   */
  trialQuotaPerUser: number;
  /**
   * How many days a service may sit unused before the customer is nudged —
   * `setting.on_hold_day`.
   *
   * Its default here is **1**, not the 4 that `table.php` creates the column
   * with. The shop's own row says 1, and the rule every other fallback in this
   * object follows is "a failed read behaves as the last release did" — not
   * "a failed read behaves as an unconfigured install would". The schema
   * default is what a new shop gets; this is what THIS shop does.
   *
   * Same shape as the two above otherwise: a whole count of days, refused
   * rather than clamped, so a broken row keeps the shop nudging on the last
   * good number instead of either never nudging or nudging on day zero.
   */
  onHoldDays: number;
  /**
   * Whether a customer must accept the shop's rules before anything else —
   * `setting.roll_Status`, which is `rolleon` in production.
   *
   * Off by default, and the reason is the same shape as `renewCashbackPercent`'s:
   * every other switch here defaults to what the bot already did, and the bot
   * has never had a rules gate. A settings read that fails must not put a screen
   * in front of 11,241 customers that only an admin can take back down.
   *
   * The gate's own text has a placeholder default, so turning this on before
   * writing the rules shows a screen that says so. That is the shop's mistake to
   * see, not ours to guess at.
   */
  requiresRules: boolean;
  /**
   * Whether admin-written text may carry Telegram custom emoji.
   *
   * Ours to invent — there is no legacy column for it. Off unless the row says
   * `true`, because it only works when the bot's *owner* has Telegram Premium
   * and nothing can check that in advance; the bot finds out by being refused.
   */
  customEmoji: boolean;
  /**
   * How a plan's button is written — `shop.plan_button_template`.
   *
   * Null is «the way it has always been written», not «empty»: see
   * `planLabel.ts`. A template that fails validation is treated as null too,
   * because a shop whose row was hand-edited into nonsense should draw the old
   * label rather than «{prise}» to a customer.
   */
  planButtonTemplate: string | null;
  /**
   * Whether these values came from the database or from the fallback below.
   *
   * Every other field here is safe to guess at: a switch the bot cannot read
   * keeps the shop selling exactly what it sold yesterday, which is why the
   * defaults are what they are. The percentages are not like that. A failed
   * read hands the caller `renewCashbackPercent: 0`, which is indistinguishable
   * from an admin who pays no cashback — and one of those two is a customer
   * quietly losing money they were owed.
   *
   * So the loader still answers, and this bit is how a money path can tell the
   * difference and decline to compute from a guess. `provision.ts` is the one
   * caller that checks it today, before it does anything irreversible.
   */
  fromDatabase: boolean;
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
  open: true,
  sellsExtraVolume: true,
  sellsExtraTime: true,
  allowsServiceSwitch: true,
  showsCopyButtons: true,
  showsAppLink: true,
  showsConfigButton: true,
  // No guess. A chat id is not a thing that has a sensible default — sending
  // the shop's daily takings to a channel nobody chose is worse than silence.
  reportChatId: null,
  commissionPercent: 10,
  renewCashbackPercent: 0,
  topupMinIrr: 800_000,
  topupMaxIrr: 100_000_000,
  warnDays: 2,
  trialQuotaPerUser: 1,
  warnVolumeGb: 1,
  onHoldDays: 1,
  requiresRules: false,
  customEmoji: false,
  // Null, and deliberately not a template. `planLabel.ts` says why: every
  // migrated product has its price typed into its name, so any default that
  // appended `{price}` would put the number on the button twice for all of
  // them on the day this shipped.
  planButtonTemplate: null,
  fromDatabase: false,
};

/**
 * A whole count of days or gigabytes that a warning may be scheduled on.
 *
 * Refused rather than clamped, like `percent`. Zero would mean the warning
 * never fires, and a negative one means the row is broken — neither is an
 * instruction to stop warning customers their service is about to end.
 */
/**
 * The trial allowance, where zero means «none» rather than «unset».
 *
 * Capped at 10 for the same reason every other limit here is capped: a
 * mistyped row must not become an unbounded giveaway of accounts on a panel
 * that costs real money to run.
 */
function trialQuota(value: number | null): number {
  if (value === null || !Number.isSafeInteger(value) || value < 0) {
    return DEFAULT_SHOP_SETTINGS.trialQuotaPerUser;
  }
  return Math.min(value, 10);
}

function wholeCount(value: number | null, fallback: number): number {
  return value !== null && Number.isSafeInteger(value) && value > 0 && value <= 365
    ? value
    : fallback;
}

/**
 * A Telegram chat id, or null.
 *
 * Refused rather than coerced, like every other number here. Zero is not a
 * chat and a fractional value is a broken row; either would make the sweep
 * post into nowhere every night while looking configured. Channel ids are
 * large and negative, which is well inside the safe-integer range.
 */
function chatId(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value !== 0 ? value : null;
}

/** Where the custom emoji switch lives, named once so nothing mistypes it. */
export const CUSTOM_EMOJI_SETTING = { scope: 'bot', key: 'custom_emoji' } as const;



/**
 * Every row `loadShopSettings` consults, in one place.
 *
 * The reads are driven off this list rather than described by it, which is the
 * difference between a comment and a guarantee. A test that resets the shop's
 * configuration clears exactly these — before this existed, `shop-settings
 * .test.ts` cleared two scopes by hand, three `bot` keys were added over time,
 * and the leftovers from one describe block closed the shop for the next.
 *
 * Keys are unique across scopes, and there is a test that says so: the lookup
 * below matches on the key alone.
 */
export const SHOP_SETTING_KEYS = [
  ['bot', 'Bot_Status'],
  ['shop', 'statusextra'],
  ['shop', 'statustimeextra'],
  ['shop', 'statuschangeservice'],
  // `setting` is one row of 51 columns and every column lands in scope `bot`;
  // every `shopSetting` row lands in scope `shop`. That is `migrateSettings`,
  // not a convention — reading either from the wrong scope finds nothing and
  // silently keeps the default for ever.
  ['bot', 'statuscopycart'],
  ['bot', 'linkappstatus'],
  ['shop', 'configshow'],
  ['bot', 'Channel_Report'],
  ['bot', 'affiliatespercentage'],
  // Misspelled in the legacy schema and matched as it is actually written,
  // like `offtimeextraa` above.
  ['shop', 'chashbackextend'],
  ['pay', 'minbalancecart'],
  ['pay', 'maxbalancecart'],
  [CUSTOM_EMOJI_SETTING.scope, CUSTOM_EMOJI_SETTING.key],
  ['bot', 'daywarn'],
  ['bot', 'volumewarn'],
  ['bot', 'on_hold_day'],
  ['bot', 'limit_usertest_all'],
  ['bot', 'roll_Status'],
  // Ours, not a migrated legacy column — there was nothing in the PHP schema
  // that composed a button label, which is the whole reason this exists.
  [PLAN_LABEL_SETTING.scope, PLAN_LABEL_SETTING.key],
] as const satisfies readonly (readonly [SettingScope, string])[];

type ShopSettingKey = (typeof SHOP_SETTING_KEYS)[number][1];

/**
 * A stored template, or null when it cannot be drawn.
 *
 * Never throws and never logs a template body: this runs on the read path of
 * every shop screen, and a shop with a broken row should keep selling with the
 * old label rather than stop.
 */
function usableTemplate(value: string | null): string | null {
  if (value === null) return null;
  const t = value.trim();
  if (t === '') return null;
  return checkPlanLabel(t) === null ? t : null;
}

const CACHE_MS = 30_000;
let cached: { at: number; value: ShopSettings } | null = null;
let warned = false;

/** Drops the cache. For tests, and after an admin edit that must be seen now. */
export function invalidateShopSettings(): void {
  cached = null;
  warned = false;
}

/**
 * Switches custom emoji off because Telegram refused one.
 *
 * Called from the send path's fallback, so it must not throw: the customer's
 * message has already gone out plain and the only thing left is to stop trying.
 * A shop that turns this on without the owner having Premium loses the emoji,
 * not the bot.
 */
export async function disableCustomEmoji(db: Db): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO settings (scope, key, value) VALUES (?1, ?2, 'false'::jsonb)
         ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_at = now()`,
      )
      .bind(CUSTOM_EMOJI_SETTING.scope, CUSTOM_EMOJI_SETTING.key)
      .run();
    log.warn('settings.custom_emoji_disabled');
  } catch (err) {
    log.error('settings.custom_emoji_write_failed', {}, err);
  }
  invalidateShopSettings();
  // The wording is cached with the stripping decision baked in, so both caches
  // have to go or the next thirty seconds keep sending the markup that was
  // just refused.
  invalidateBotContent();
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
 * A failed read falls back to the LAST GOOD READ, however old, and only to the
 * shipped defaults when there has never been one. That distinction is the whole
 * point of this paragraph.
 *
 * It used to fall straight to `DEFAULT_SHOP_SETTINGS`, and exactly one caller
 * in the repository checked `fromDatabase` before acting on the result
 * (`provision.ts`). So a single failed SELECT — one connection reset, on a
 * bot that has been reading these rows all day — made the shop OPEN if the
 * admin had closed it, paid referral commission at the shipped ten per cent
 * instead of the five the admin set, and moved the deposit floor and ceiling.
 * All of it committed, with one warning in the log.
 *
 * The shipped constants are what the shop looked like the day this code was
 * written. The last good read is what the shop looks like. When the database
 * cannot be asked, the second is the better answer to every question, and it
 * needs no caller to remember anything.
 *
 * Nothing is cached on failure, so the real settings take effect as soon as the
 * database answers again.
 */
/**
 * What `Channel_Report` falls back to when the shop has not set one.
 *
 * Set once at boot from `REPORT_CHAT_ID`, and resolved HERE rather than by each
 * reader, which is the whole point. It used to be a parameter of
 * `sweepDailyReport` and nothing else, so the nightly report fell back to the
 * environment and the flood-block report did not — two readers of "the shop's
 * report channel" that answered differently on any box where the settings row
 * is missing and the variable is set, which is exactly the practice box. The
 * comment claiming there was "one answer" was written about the column and was
 * true only about the column.
 *
 * What is still ambiguous, said out loud rather than papered over: a row that
 * exists but is empty reads the same as no row at all, so an admin who CLEARS
 * the channel gets the environment's, not silence. Distinguishing them needs
 * `read()` to report presence, and nothing needs it yet.
 */
let reportFallback: number | null = null;

export function setReportChatIdFallback(chatId: number | null): void {
  reportFallback = chatId;
  invalidateShopSettings();
}

export async function loadShopSettings(db: Db, now = Date.now()): Promise<ShopSettings> {
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  try {
    // Read from the one list, so nothing can consult a row this file has not
    // declared and no test can clear a set that has fallen behind the reads.
    const raw = await Promise.all(
      SHOP_SETTING_KEYS.map(([scope, key]) => settingText(db, scope, key)),
    );
    const text = (key: ShopSettingKey): string | null =>
      raw[SHOP_SETTING_KEYS.findIndex(([, k]) => k === key)] ?? null;
    // Every numeric setting arrived from MySQL as text, so there is one
    // conversion here rather than a second query shape.
    const num = (key: ShopSettingKey): number | null => {
      const value = text(key);
      if (value === null) return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };

    const value: ShopSettings = {
      // Closed only on the exact word. Anything unrecognised leaves the shop
      // open, which is the same rule as the switches below and matters more
      // here: an unreadable value must never be what stops the shop selling.
      open: !isOff(text('Bot_Status'), 'botstatusoff'),
      // The "off" words are the legacy schema's, typos included:
      // `offtimeextraa` really does carry two a's in production.
      sellsExtraVolume: !isOff(text('statusextra'), 'offextra'),
      sellsExtraTime: !isOff(text('statustimeextra'), 'offtimeextraa'),
      allowsServiceSwitch: !isOff(text('statuschangeservice'), 'offstatus'),
      // Off only on the exact `'0'`, which is a DELIBERATE difference from the
      // PHP: `index.php:4790` draws the buttons only when the column reads
      // exactly `"1"`, so anything unexpected there hides them. Here anything
      // unexpected leaves them, for the same reason as the three switches
      // above — a value we failed to understand must not be what takes a
      // working affordance away from a customer mid-payment.
      //
      // Both columns are `varchar(45)` holding `1`, so `settingText` hands
      // over the string `'1'` whether the driver gives us a string or a
      // number. Comparing a number against `'0'` is exactly how `roll_Status`
      // read 963 customers wrong.
      showsCopyButtons: !isOff(text('statuscopycart'), '0'),
      showsAppLink: !isOff(text('linkappstatus'), '0'),
      showsConfigButton: !isOff(text('configshow'), 'offconfig'),
      // The shop's own column first, then the boot fallback. Applied here so
      // that every reader — the nightly report and the flood-block report —
      // gets the same answer without either of them knowing there is a
      // fallback at all.
      reportChatId: chatId(num('Channel_Report')) ?? reportFallback,
      commissionPercent: percent(
        num('affiliatespercentage'),
        DEFAULT_SHOP_SETTINGS.commissionPercent,
      ),
      // `chashbackextend_agent` holds a per-reseller override — `{"n":"5","n2":0}`
      // in production — and is deliberately not read: the reseller panel is a
      // later round, and both live tiers are already covered by the shop rate
      // (5) or by paying nothing (0).
      renewCashbackPercent: percent(
        num('chashbackextend'),
        DEFAULT_SHOP_SETTINGS.renewCashbackPercent,
      ),
      topupMinIrr: tomanLimit(num('minbalancecart'), DEFAULT_SHOP_SETTINGS.topupMinIrr),
      topupMaxIrr: tomanLimit(num('maxbalancecart'), DEFAULT_SHOP_SETTINGS.topupMaxIrr),
      warnDays: wholeCount(num('daywarn'), DEFAULT_SHOP_SETTINGS.warnDays),
      // `wholeCount` refuses zero, and zero is a real answer here - it is how
      // an admin turns trials off shop-wide - so this one is read on its own.
      trialQuotaPerUser: trialQuota(num('limit_usertest_all')),
      warnVolumeGb: wholeCount(num('volumewarn'), DEFAULT_SHOP_SETTINGS.warnVolumeGb),
      onHoldDays: wholeCount(num('on_hold_day'), DEFAULT_SHOP_SETTINGS.onHoldDays),
      // On only for the exact word, like `customEmoji` and unlike the three
      // legacy switches above. Those describe selling the shop has been doing
      // for years, so an unreadable value leaves it alone; this one puts a wall
      // in front of every customer, so an unreadable value must not build it.
      requiresRules: text('roll_Status') === 'rolleon',
      // Opt-in, and only on the exact word — the opposite of the legacy
      // switches above, which stay ON unless they hold their own off-word.
      // The difference is deliberate: those describe a shop that has been
      // selling for years, this one describes a Premium subscription the bot
      // cannot verify it has.
      customEmoji: text(CUSTOM_EMOJI_SETTING.key) === 'true',
      // Validated on the way OUT as well as on the way in. The panel refuses a
      // bad template, but this row is reachable by hand and by a restore, and
      // the failure mode of trusting it is «{prise}» drawn on a button to a
      // customer. An unusable value reads as «not configured».
      planButtonTemplate: usableTemplate(text(PLAN_LABEL_SETTING.key)),
      // The database answered. An empty `settings` table still counts: "the
      // admin has configured nothing" is a fact, and it is not the same fact
      // as "we could not ask".
      fromDatabase: true,
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
      log.warn(
        'settings.read_failed',
        { using: cached ? 'the last good read' : 'the shipped defaults' },
        err,
      );
    }
    // Stale on purpose. `cached.at` is not consulted here: an hour-old copy of
    // what the admin actually configured beats a fresh copy of what somebody
    // configured at release time.
    //
    // `fromDatabase: false` regardless, because the flag means "read from the
    // database just now" and a money path is entitled to know it is looking at
    // a copy. The VALUES are the admin's; only the freshness is in doubt.
    return cached ? { ...cached.value, fromDatabase: false } : DEFAULT_SHOP_SETTINGS;
  }
}
