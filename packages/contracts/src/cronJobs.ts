/**
 * The sweeps the bot runs, described once so a person can see them.
 *
 * Until this file existed there was no list. The sweeps are called in a
 * hardcoded order inside the poll loop (`poll.ts`, one cycle every ~25s), and
 * the only way to learn that a shop warns about expiry — or on what threshold —
 * was to read TypeScript. An operator asking «چه چیزهایی خودکار اجرا می‌شوند؟»
 * had nowhere to look.
 *
 * ## Why a registry in code and not a table
 *
 * Faoxima keeps `cron_runtime_state`, one row per job with a schedule («every N
 * minutes»), because a crontab has to be told when to call them. Ours do not
 * need that: the loop already turns, every sweep runs every cycle, and what
 * decides whether a customer is due is a THRESHOLD, not a schedule. «three days
 * after purchase» is a number, not a cadence. A scheduler in front of a loop
 * that already spins is a layer with no question to answer.
 *
 * So a job's identity, its name, and which settings rows it reads live here in
 * code — where they are typechecked and cannot drift from the sweep — and only
 * the VALUES an operator changes live in the database, as ordinary `settings`
 * rows.
 *
 * ## The texts are not here
 *
 * Every message these jobs send is already editable under «متن‌های ربات»
 * («هشدارهای خودکار» screen). This registry NAMES those keys and the panel
 * links to them. Copying the strings here would make two doors onto one
 * sentence, and two doors onto one sentence is two versions of it a year from
 * now.
 */

import type { TextKey } from './botTexts.js';

/** Every sweep an operator can see, switch, or tune. */
export type CronJobKey =
  | 'warn_time'
  | 'warn_volume'
  | 'warn_unused'
  | 'expire_orders'
  | 'remove_expired'
  | 'remove_volume'
  | 'nudge_never_bought';

/**
 * A setting an operator may type a number into.
 *
 * `scope` and `key` address the `settings` row exactly as `SHOP_SETTING_KEYS`
 * does in the bot; `min`/`max` are the same bounds the bot's own reader
 * enforces, restated here so the panel can refuse a value before it is stored
 * rather than storing one the bot will silently ignore.
 *
 * That restatement is the one duplication this file accepts, and there is a
 * test that holds the two ends together — a bound that only the panel knows is
 * a bound the bot does not have.
 */
export interface CronJobNumber {
  scope: 'bot' | 'shop' | 'pay';
  key: string;
  /** What the number means, in the operator's words. */
  label: string;
  unit: 'روز' | 'گیگابایت' | 'ساعت';
  min: number;
  max: number;
}

export interface CronJob {
  key: CronJobKey;
  /** The job's name on the panel. */
  name: string;
  /** What it does, and to whom. One or two sentences. */
  what: string;
  /**
   * The `settings` row that turns it on and off, or null when it has none.
   *
   * Null is not «always on by accident». Three of these jobs are the shop's
   * oldest behaviour — telling a customer their service is ending — and giving
   * them an off switch is a decision, not a refactor. Where the switch exists
   * it is named here and the sweep reads it.
   */
  toggle: { scope: 'bot'; key: string } | null;
  /** The numbers this job reads. Empty when it has none to tune. */
  numbers: CronJobNumber[];
  /** Its messages, by key, so the panel can link to «متن‌های ربات». */
  texts: TextKey[];
  /**
   * True when the job can delete or take something away from a customer.
   *
   * The panel draws these differently and their switches default to off. There
   * are exactly two, they are the only things in this project that remove a
   * customer's account from a panel, and a removal cannot be undone.
   */
  destructive: boolean;
}

/**
 * The switch keys, named once.
 *
 * `cron_status` in the legacy is ONE column holding a JSON object
 * (`{"day":true,"volume":true,...}`). It is split into rows here because the
 * panel edits one key at a time and `settingsRoutes` refuses to invent rows —
 * an admin flipping one switch must not rewrite a blob that carries six others.
 * The migration reads the legacy blob and writes the rows.
 */
export const CRON_TOGGLES = {
  warn_time: { scope: 'bot', key: 'cron_warn_time' },
  warn_volume: { scope: 'bot', key: 'cron_warn_volume' },
  warn_unused: { scope: 'bot', key: 'cron_warn_unused' },
  remove_expired: { scope: 'bot', key: 'cron_remove_expired' },
  remove_volume: { scope: 'bot', key: 'cron_remove_volume' },
  nudge_never_bought: { scope: 'bot', key: 'cron_nudge_never_bought' },
} as const satisfies Partial<Record<CronJobKey, { scope: 'bot'; key: string }>>;

/**
 * The report-only switch the legacy does not have.
 *
 * Both removal jobs run in this mode until it is turned off: they select
 * exactly what they would delete, write it to `app_events`, tell nobody, and
 * delete nothing. It exists because a wrong deletion here takes a paying
 * customer's account off a panel and we cannot put it back — so the shop gets
 * a week of «this is what I would have removed» before it removes anything.
 */
export const CRON_DRY_RUN = { scope: 'bot', key: 'cron_remove_dry_run' } as const;

export const CRON_JOBS: readonly CronJob[] = [
  {
    key: 'warn_time',
    name: 'هشدار نزدیک‌شدن انقضا',
    what: 'به مشتری می‌گوید سرویسش تا چند روز دیگر تمام می‌شود. هر سرویس یک بار، و تمدید دوباره فعالش می‌کند.',
    toggle: CRON_TOGGLES.warn_time,
    numbers: [
      {
        scope: 'bot',
        key: 'daywarn',
        label: 'چند روز مانده به انقضا هشدار داده شود',
        unit: 'روز',
        min: 1,
        max: 365,
      },
    ],
    texts: ['WARN_TIME_TITLE', 'WARN_TIME_DAYS'],
    destructive: false,
  },
  {
    key: 'warn_volume',
    name: 'هشدار اتمام حجم',
    what: 'به مشتری می‌گوید چقدر از حجم سرویسش مانده. سرویسی که حجمش تمام شده هشدار نمی‌گیرد — دیگر تمام شده است.',
    toggle: CRON_TOGGLES.warn_volume,
    numbers: [
      {
        scope: 'bot',
        key: 'volumewarn',
        label: 'با چند گیگابایت باقی‌مانده هشدار داده شود',
        unit: 'گیگابایت',
        min: 1,
        max: 365,
      },
    ],
    texts: ['WARN_VOLUME_TITLE', 'WARN_VOLUME_REMAINING'],
    destructive: false,
  },
  {
    key: 'warn_unused',
    name: 'خرید کرد و وصل نشد',
    what: 'به مشتری‌ای که سرویس خریده و هرگز به آن وصل نشده یادآوری می‌کند، همراه با آیدی پشتیبانی.',
    toggle: CRON_TOGGLES.warn_unused,
    numbers: [
      {
        scope: 'bot',
        key: 'on_hold_day',
        label: 'چند روز بعد از خرید، اگر وصل نشده بود',
        unit: 'روز',
        min: 1,
        max: 365,
      },
    ],
    texts: ['WARN_UNUSED_TITLE', 'WARN_UNUSED_DAYS', 'WARN_UNUSED_SUPPORT'],
    destructive: false,
  },
  {
    key: 'expire_orders',
    name: 'بستن سفارش پرداخت‌نشده',
    what: 'سفارشی که فاکتور گرفته و پول برایش نیامده، بعد از مهلتش بسته می‌شود تا ظرفیت و شمارهٔ پیگیری آزاد شود.',
    // No switch, and deliberately: an invoice that is never closed holds a
    // reservation for ever. Turning this off does not stop customers from
    // ordering, it stops the shop from ever tidying up after them.
    toggle: null,
    numbers: [
      {
        scope: 'bot',
        key: 'order_ttl_hours',
        label: 'مهلت پرداخت فاکتور',
        unit: 'ساعت',
        min: 1,
        max: 720,
      },
    ],
    texts: [],
    destructive: false,
  },
  {
    key: 'remove_expired',
    name: 'حذف سرویس منقضی از پنل',
    what: 'سرویسی که پنل هم منقضی/محدودش کرده و از انقضایش این‌قدر روز گذشته، از پنل پاک می‌شود. برگشت‌ناپذیر.',
    toggle: CRON_TOGGLES.remove_expired,
    numbers: [
      {
        scope: 'bot',
        key: 'removedayc',
        label: 'چند روز بعد از انقضا حذف شود',
        unit: 'روز',
        min: 1,
        max: 365,
      },
    ],
    texts: ['CRON_SERVICE_REMOVED'],
    destructive: true,
  },
  {
    key: 'remove_volume',
    name: 'حذف سرویس حجم‌تمام‌شده از پنل',
    what: 'سرویسی که حجمش تمام شده و از آخرین اتصالش این‌قدر روز گذشته، از پنل پاک می‌شود. برگشت‌ناپذیر.',
    toggle: CRON_TOGGLES.remove_volume,
    numbers: [
      {
        scope: 'bot',
        key: 'cronvolumere',
        label: 'چند روز بعد از آخرین اتصال حذف شود',
        unit: 'روز',
        min: 1,
        max: 365,
      },
    ],
    texts: ['CRON_SERVICE_REMOVED_VOLUME'],
    destructive: true,
  },
  {
    key: 'nudge_never_bought',
    name: 'استارت کرد و نخرید',
    what: 'به کسی که ربات را استارت کرده و بعد از این‌قدر روز هیچ خریدی نکرده، یک بار یادآوری می‌فرستد.',
    toggle: CRON_TOGGLES.nudge_never_bought,
    numbers: [
      {
        scope: 'bot',
        key: 'nudge_after_days',
        label: 'چند روز بعد از استارت',
        unit: 'روز',
        min: 1,
        max: 365,
      },
    ],
    // Empty until the sweep that sends it exists. `bot-text-lines.test.ts`
    // refuses a TEXTS key no source file renders — an edit box that saves a
    // sentence nobody will ever see — so the text and its reader land in the
    // same commit, not this one.
    texts: [],
    // Sends a message to somebody who has never paid us anything. It takes
    // nothing away, so it is not in the same class as the two above it.
    destructive: false,
  },
];

export const CRON_JOB_KEYS = CRON_JOBS.map((j) => j.key);

/** Every `settings` row this registry owns, for the migration and the bot. */
export const CRON_SETTING_KEYS: readonly (readonly ['bot' | 'shop' | 'pay', string])[] = [
  ...CRON_JOBS.flatMap((j) => (j.toggle ? [[j.toggle.scope, j.toggle.key] as const] : [])),
  ...CRON_JOBS.flatMap((j) => j.numbers.map((n) => [n.scope, n.key] as const)),
  [CRON_DRY_RUN.scope, CRON_DRY_RUN.key] as const,
];

export function cronJob(key: CronJobKey): CronJob {
  const job = CRON_JOBS.find((j) => j.key === key);
  if (!job) throw new Error(`unknown cron job: ${key}`);
  return job;
}
