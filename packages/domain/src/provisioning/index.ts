/**
 * Choosing an adapter, and naming the remote account.
 */

import { marzbanAdapter } from './marzban.js';
import { manualAdapter } from './manual.js';
import type { ProvisioningAdapter, RenewMode } from './types.js';

export * from './types.js';
export * from './schemaCheck.js';
export { marzbanAdapter, groupIdsFor } from './marzban.js';
export { manualAdapter } from './manual.js';

/**
 * The kinds we can actually deliver.
 *
 * `provisioning_providers.kind` allows nine values because the schema was
 * written for the product model, not for what is built. Seven of them —
 * marzban, marzneshin, hiddify, xui, wireguard, ai_account, spotify — have no
 * adapter and every one of them falls to `manual` below, which puts the order
 * in a human's queue instead of pretending.
 *
 * That is not a placeholder to be embarrassed about: all five panels in
 * production are `pasarguard`, so this covers every live provider today.
 *
 * `marzban` being on the unbuilt list is deliberate, not an oversight. Every
 * live panel is PasarGuard filed under Marzban's name (see the header of
 * `marzban.ts`), and PasarGuard's field names are not Marzban's. A classic
 * Marzban panel routed to this adapter would be sent `group_ids` and
 * `proxy_settings`, drop both without an error, and hand the customer an
 * account with no inbounds. Falling to manual is the loud failure.
 */
const ADAPTERS = new Map<string, ProvisioningAdapter>([
  [marzbanAdapter.kind, marzbanAdapter],
  [manualAdapter.kind, manualAdapter],
]);

/**
 * The adapter for a provider kind, falling back to manual.
 *
 * Never throws and never returns null. An unknown kind is a product we can sell
 * but not yet deliver automatically, and the safe reading of that is "a person
 * finishes this" — not an exception in the middle of a sweep that has already
 * taken the customer's money.
 */
export function adapterFor(kind: string): ProvisioningAdapter {
  return ADAPTERS.get(kind) ?? manualAdapter;
}

/** True when `kind` has a real adapter rather than falling back to manual. */
export function isAutomated(kind: string): boolean {
  return ADAPTERS.has(kind) && kind !== manualAdapter.kind;
}

/**
 * Renewal is per panel, and the setting arrived with the migration.
 *
 * `provisioning_providers.config` keeps every legacy column the schema did not
 * claim a place for, so the two the admin set in the old bot are already there:
 *
 *     status_extend  'on_extend' | 'off_extend'   — may this panel be renewed
 *     Methodextend   a Persian phrase             — how
 *
 * Matching on a Persian phrase from a settings table is not something to build
 * on, so `renew_mode` is read first and is what an admin sets from here on. The
 * legacy key is only the fallback that makes the five live panels work on the
 * day this ships, and 'ADD' is spelled out rather than defaulted to: getting
 * this wrong the other way — RESET on a panel meant to accumulate — silently
 * deletes volume a customer already paid for.
 */
const LEGACY_ADD_METHOD = 'اضافه شدن زمان و حجم به ماه بعد';

export function renewModeFor(config: Record<string, unknown>): RenewMode {
  const explicit = config['renew_mode'];
  if (typeof explicit === 'string' && explicit.toUpperCase() === 'ADD') return 'ADD';
  if (typeof explicit === 'string' && explicit.toUpperCase() === 'RESET') return 'RESET';
  return config['Methodextend'] === LEGACY_ADD_METHOD ? 'ADD' : 'RESET';
}

/**
 * Whether this panel may be renewed at all.
 *
 * One production panel is `off_extend`, and honouring that is the difference
 * between "the admin turned this off" and "the admin's setting was ignored by
 * the new bot".
 */
export function renewAllowed(config: Record<string, unknown>): boolean {
  const explicit = config['renew_enabled'];
  if (typeof explicit === 'boolean') return explicit;
  return config['status_extend'] !== 'off_extend';
}

/**
 * What one extra gigabyte and one extra day cost on this panel, in IRR.
 *
 * The admin has been setting these for years, per panel and per customer tier,
 * and they are already in `config` — the migration carried the whole legacy row
 * across. Production, on the VIP panel: `{"f":"50000","n":"5000","n2":"5000"}`
 * for volume, `{"f":"15000","n":"4000","n2":"4000"}` for time.
 *
 *   f    ordinary customer
 *   n    reseller
 *   n2   reseller, second tier
 *
 * Stored in TOMAN, like every other price in the old database, so it is
 * multiplied here — this is the edge the toman rule talks about, and nothing
 * downstream sees anything but IRR.
 *
 * The units come from the PHP and not from a reading of the field names:
 * `index.php:2702` divides the paid amount by the rate to get days
 * (`priceـper_day`), and `index.php:2116` multiplies the rate by gigabytes.
 *
 * Null means "not for sale here" — an unreadable value, a missing tier, zero,
 * or a panel the admin set to `off_extend`. It is never a guess.
 */
export interface ExtraPricing {
  volumeIrrPerGb: number | null;
  timeIrrPerDay: number | null;
}

export type CustomerTier = 'f' | 'n' | 'n2';

export function extraPricingFor(config: Record<string, unknown>, tier: CustomerTier): ExtraPricing {
  if (!renewAllowed(config)) return { volumeIrrPerGb: null, timeIrrPerDay: null };
  return {
    volumeIrrPerGb: tomanRate(config['priceextravolume'], tier),
    timeIrrPerDay: tomanRate(config['priceextratime'], tier),
  };
}

/** `{"f":"50000",…}` → 500000 IRR, or null for anything that is not a price. */
function tomanRate(raw: unknown, tier: CustomerTier): number | null {
  // The column is text in the legacy database and jsonb here, so both shapes
  // arrive. A string that is not JSON is a setting nobody can act on, not a
  // reason to fail a customer's screen.
  let table: unknown = null;
  if (typeof raw === 'string') {
    try {
      table = JSON.parse(raw);
    } catch {
      return null;
    }
  } else if (typeof raw === 'object' && raw !== null) {
    table = raw;
  }
  if (table === null || typeof table !== 'object') return null;
  const value = (table as Record<string, unknown>)[tier];
  const toman = typeof value === 'number' ? value : Number(value);
  // A rate of zero would make an add-on free and an unbounded one — the
  // customer types the gigabytes, so zero times anything is a giveaway.
  if (!Number.isFinite(toman) || toman <= 0) return null;
  return Math.round(toman) * 10;
}

/**
 * The account name on the remote panel.
 *
 * Shaped like the ones already in production — `369469521_ce4c`,
 * `5633385607_ff620a55` — because support staff and the admin read these in the
 * panel every day and a new shape would be a new thing to learn. Three of the
 * five live panels are set to "numeric id + random letters and digits", which
 * is exactly this.
 *
 * The one change is that the suffix is not random. It is the order's public id,
 * which is already unique, so the same order always produces the same username.
 * That is what makes provisioning idempotent: a sweep that created the account
 * and then died before writing the row asks for the same name next time and
 * finds what it made, instead of creating a second account the customer never
 * hears about and nobody bills for.
 *
 * The WHOLE public id, not a prefix of it. Truncating to eight characters — the
 * length the production suffixes happen to have — made two of this user's
 * orders collide once every few billion pairs, and the failure mode is not a
 * clash: the adapter finds the existing account and reports success, so the
 * customer pays for a second service and receives their first one again.
 * Uniqueness is already guaranteed one column over; throwing it away to match a
 * cosmetic length was not a trade worth making.
 */
export function remoteUsernameFor(
  telegramId: number,
  orderPublicId: string,
  shape?: UsernameShape,
): string {
  const suffix = orderPublicId.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return `${usernamePrefix(telegramId, shape)}_${suffix}`;
}

/**
 * Which of the three shapes a panel gives the part BEFORE the suffix.
 *
 * Legacy offers eight (`function.php:687`) and five of them cannot be built
 * here, because five of them are random or counted:
 *
 *     ...+ عدد رندوم       rand(1000000, 9999999)
 *     ...+ عدد ترتیبی      user.number_username / setting.numbercount, ++
 *
 * A name that is random is a name a retry cannot reproduce, and reproducing it
 * is the whole reason `remoteUsernameFor` exists: the sweep that created an
 * account and died before writing the row asks for the same name next time and
 * finds what it made. With a random suffix it asks for a different one, makes a
 * SECOND account on the panel, and the customer is billed once for two - or,
 * worse on renewal, keeps paying into an account nobody is watching. Legacy
 * knows: `index.php:3057` re-checks the panel and prepends another random
 * number on a hit, then does not re-check THAT. And its counters are
 * read-modify-write in PHP (`index.php:4100`), so two purchases in the same
 * second get the same number.
 *
 * So the suffix stays `orderPublicId` - already unique, already stable - and
 * only the PREFIX is configurable. That keeps every mode idempotent by
 * construction rather than by a retry that hopes.
 *
 * The two «customer types their own name» modes are not here either, and that
 * is not an oversight: they need a prompt this shop does not have, and
 * `setting.statusnamecustom` is `offnamecustom` in production - the shop turned
 * them off. They fall to TELEGRAM_ID with everything else unrecognised.
 */
export type UsernameMode = 'TELEGRAM_ID' | 'PANEL_TEXT' | 'TELEGRAM_USERNAME';

export interface UsernameShape {
  mode: UsernameMode;
  /** `config.username_text`, legacy `namecustom`. */
  panelText?: string | null;
  /** The customer's Telegram @username, when they have one. */
  telegramUsername?: string | null;
}

/**
 * Legacy `MethodUsername`, which stores the Persian UI LABEL rather than a code.
 *
 * That is why this map exists and why it is exhaustive about the shapes
 * production actually carries: `lang/fa.php` is what the old bot compares
 * against, so a single character changed in a translation file silently
 * repoints every panel. Reading it once, here, and writing `username_mode`
 * from then on is how that stops being true of us.
 *
 * Measured in the production dump, 2026-09-02 - panel 1 «آیدی عددی+عدد ترتیبی»
 * (note: no spaces around the +, unlike its siblings, and that is the real
 * stored value), panels 8/12/13 «آیدی عددی + حروف و عدد رندوم», panel 14
 * «متن دلخواه + عدد رندوم». All five land on a mode below.
 */
const LEGACY_USERNAME_MODES: Record<string, UsernameMode> = {
  'آیدی عددی + حروف و عدد رندوم': 'TELEGRAM_ID',
  'آیدی عددی+عدد ترتیبی': 'TELEGRAM_ID',
  'متن دلخواه + عدد رندوم': 'PANEL_TEXT',
  'متن دلخواه + عدد ترتیبی': 'PANEL_TEXT',
  'متن دلخواه نماینده + عدد ترتیبی': 'PANEL_TEXT',
  'نام کاربری + عدد به ترتیب': 'TELEGRAM_USERNAME',
};

const USERNAME_MODES: readonly UsernameMode[] = [
  'TELEGRAM_ID',
  'PANEL_TEXT',
  'TELEGRAM_USERNAME',
];

export function usernameShapeFor(
  config: Record<string, unknown>,
  telegramUsername?: string | null,
): UsernameShape {
  const explicit = config['username_mode'];
  const legacy = config['MethodUsername'];
  const mode =
    typeof explicit === 'string' && (USERNAME_MODES as readonly string[]).includes(explicit)
      ? (explicit as UsernameMode)
      : typeof legacy === 'string'
        ? (LEGACY_USERNAME_MODES[legacy] ?? 'TELEGRAM_ID')
        : 'TELEGRAM_ID';
  // PRESENCE, not `??`.
  //
  // The route writes `username_text: null` when an admin clears the field,
  // and `null ?? config['namecustom']` hands back the legacy value — which is
  // the literal string `none` on two production panels. So clearing the text
  // would have named every account on those panels `none_...`, which is the
  // exact opposite of what clearing it means.
  const text = has(config, 'username_text') ? config['username_text'] : config['namecustom'];
  return {
    mode,
    panelText: typeof text === 'string' ? text : null,
    telegramUsername: telegramUsername ?? null,
  };
}

/**
 * The prefix, and the reason every branch can fall back to the Telegram id.
 *
 * A prefix that is not usable must not become an empty one: `_inv3f9a` is a
 * name the panel accepts and no human can trace to a customer. The numeric id
 * always exists, is always valid, and is what three of the five live panels
 * already produce - so it is the floor rather than an error.
 *
 * Legacy's `namecustom` default is the literal string `none`, which is what two
 * production panels carry; it sanitises to `none` and would name every account
 * on them `none_...`. That is why the route refuses to save PANEL_TEXT without
 * a deliberate text; here it is merely survivable.
 */
function usernamePrefix(telegramId: number, shape?: UsernameShape): string {
  const fallback = String(telegramId);
  if (shape?.mode === 'PANEL_TEXT') return sanitiseUsernamePart(shape.panelText) ?? fallback;
  if (shape?.mode === 'TELEGRAM_USERNAME') {
    return sanitiseUsernamePart(shape.telegramUsername) ?? fallback;
  }
  return fallback;
}

/**
 * Down to what a panel will accept, or null.
 *
 * The charset is legacy's own (`index.php:3030`) - must start with a letter,
 * three characters at least, `[a-z0-9_]` only. The CAP is not legacy's: it has
 * none anywhere, so a custom text plus seven random digits plus a collision
 * retry's own prefix can pass forty characters, and the panel answers 422 in
 * the middle of a paid order.
 */
const USERNAME_PART_MAX = 32;

function sanitiseUsernamePart(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, USERNAME_PART_MAX);
  return cleaned.length >= 3 ? cleaned : null;
}

/**
 * The free account a panel may hand out, and the two numbers behind it.
 *
 * Legacy carries three per-panel columns and every one of them is a trap:
 *
 *     TestAccount     'ONTestAccount' | 'OFFTestAccount'   the switch
 *     val_usertest    MEGABYTES, not gigabytes  (x 1048576, index.php:3064)
 *     time_usertest   HOURS, not days           (+N hours,  index.php:3063)
 *
 * The units are read from the code, not from the field names, and the old bot's
 * own message disagrees with itself - `index.php:3120` renders `time_usertest`
 * into a `{day}` placeholder. Our keys say what they hold.
 *
 * `enabled` is false unless BOTH numbers are usable, which is stricter than
 * legacy and deliberately so: a panel switched on with nothing to give answers
 * a customer's tap with a failed provision. And there is a reason to distrust
 * the stored numbers rather than assume them - `admin.php:751` binds
 * `:val_usertest` where the column list says `time_usertest` and vice versa, so
 * every panel added through the old bot has the two the wrong way round. The
 * five production panels read 1000 MB / 12 h and 1 MB / 100 h from that bug,
 * and all five are `OFFTestAccount`, so none of it has ever reached a customer.
 */
export interface TrialSettings {
  enabled: boolean;
  volumeGb: number | null;
  durationHours: number | null;
}

export function trialFor(config: Record<string, unknown>): TrialSettings {
  const explicit = config['trial_enabled'];
  const on = typeof explicit === 'boolean' ? explicit : config['TestAccount'] === 'ONTestAccount';
  // Megabytes in the legacy column. 1024, not 1000: the PHP multiplies by
  // 1048576 to get bytes, so the panel is being told binary gigabytes.
  const legacyMb = positiveNumber(config['val_usertest']);
  // Presence again, for the reason spelled out in `usernameShapeFor`: an
  // admin who clears the gigabytes is saying «this panel gives nothing», and
  // `??` would answer with the megabytes underneath instead. `enabled` then
  // stays true and a customer spends their one free account on a size nobody
  // chose.
  const volumeGb = has(config, 'trial_volume_gb')
    ? positiveNumber(config['trial_volume_gb'])
    : legacyMb === null
      ? null
      : legacyMb / 1024;
  const durationHours = has(config, 'trial_duration_hours')
    ? positiveNumber(config['trial_duration_hours'])
    : positiveNumber(config['time_usertest']);
  return {
    enabled: on && volumeGb !== null && durationHours !== null,
    volumeGb,
    durationHours,
  };
}

/**
 * Where an account goes when its service ends, instead of simply stopping.
 *
 * Legacy calls this «اینباند اکانت غیرفعال» and stores `<protocol>*<tag>` in
 * `inbound_deactive` - a Marzban inbound tag, chosen from a live
 * `GET /api/inbounds` listing. That shape is NOT carried forward, and the
 * reason is the one the whole `marzban.ts` header is about: every live panel is
 * PasarGuard, where the unit an account belongs to is a GROUP, not an inbound
 * tag. Translating a tag into a group id would be a guess.
 *
 * There is also nothing to translate. Measured 2026-09-02: `inbound_deactive`
 * is the string `1` on all five production panels - the value `admin.php:766`
 * binds from `$inboundid` when a panel is created, never the `proto*tag` the
 * menu writes. Panel 8 has `inboundstatus = oninbounddisable`, so the feature
 * is SWITCHED ON there with a value `explode('*', '1')` turns into a
 * one-element array whose `[1]` does not exist. It has never worked on any
 * panel this shop runs.
 *
 * Null means «leave the account alone», which is what happens today.
 */
export function downgradeGroupsFor(config: Record<string, unknown>): number[] | null {
  const raw = config['downgrade_group_ids'];
  if (!Array.isArray(raw)) return null;
  const ids = raw
    .map((v) => (typeof v === 'number' ? v : Number(v)))
    .filter((v) => Number.isSafeInteger(v) && v > 0);
  return ids.length > 0 ? ids : null;
}

/**
 * Whether the panel has an opinion about this key at all.
 *
 * `jsonb` keeps a stored `null` as a key that exists holding null, so this is
 * the only way to tell «the admin cleared it» from «the admin never touched
 * it». Every reader that has a legacy fallback needs it; `??` cannot.
 */
function has(config: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(config, key);
}

/** A setting that must be a number above zero, or nothing. */
function positiveNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
