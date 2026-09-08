/**
 * The two conversions this panel does at its edge.
 *
 * Both are checked against outside truth rather than against themselves:
 * the Toman figure against the arithmetic the money rule states
 * (`amountToman * 10 === amountIrr`), and the Tehran date against `Intl`
 * evaluating the same instant in the same zone. A test that compared
 * `dateTime()` to another call of `dateTime()` would agree with a seven-hour
 * offset — which is exactly the bug this project has already shipped once.
 */

import { describe, expect, it } from 'vitest';
import {
  actorFa,
  count,
  dateOnly,
  dateTime,
  endOfTehranDay,
  entryNoteFa,
  gigabytes,
  irrToToman,
  planDisplayName,
  toman,
  tomanCompact,
} from '../src/format.js';

describe('IRR to Toman', () => {
  it('is the platform rule, in the one direction this panel needs', () => {
    // The rule the bot edge uses is `amountToman * 10 = amountIrr`. Reading it
    // back has to be its exact inverse for whole Toman.
    for (const t of [0, 1, 999, 50_000, 1_234_567]) {
      expect(irrToToman(t * 10)).toBe(t);
    }
  });

  it('truncates toward zero rather than flooring, so a debit is not deepened', () => {
    // -15 Rial is -1.5 Toman. Flooring would make it -2 and quietly report a
    // customer as owing more than they do.
    expect(irrToToman(-15)).toBe(-1);
    expect(irrToToman(15)).toBe(1);
  });

  it('keeps the sign on a debit', () => {
    // fa-IR uses U+2212 MINUS SIGN, not ASCII hyphen. Both are accepted so the
    // test does not break on an ICU version that picks the other one — what it
    // must never accept is an unsigned string.
    const rendered = toman(-2_500_000);
    expect(rendered).toMatch(/[-−]/);
    expect(rendered).toContain('تومان');
  });

  it('renders nothing rather than zero for a missing value', () => {
    expect(toman(null)).toBe('—');
    expect(tomanCompact(undefined)).toBe('—');
    expect(count(null)).toBe('—');
  });

  it('shortens large sums without changing their magnitude', () => {
    // 3,500,000,000 IRR is 350,000,000 Toman — "میلیون", not "هزار".
    expect(tomanCompact(3_500_000_000)).toContain('میلیون');
    expect(tomanCompact(35_000_000_000)).toContain('میلیارد');
    expect(tomanCompact(50_000)).toContain('هزار');
  });
});

describe('Tehran time', () => {
  it('formats in Asia/Tehran, not in whatever zone the runner is in', () => {
    // 2026-08-14T20:30:00Z is 2026-08-15 00:00 in Tehran (+03:30): a different
    // calendar day. The assertion is against Intl computing the same instant
    // in the same zone — the outside authority, not this module.
    const iso = '2026-08-14T20:30:00.000Z';
    const expected = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(Date.parse(iso));
    expect(dateOnly(iso)).toBe(expected);

    // And it is genuinely the next day there, so the test would catch a
    // formatter left on UTC.
    const utcDay = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(Date.parse(iso));
    expect(dateOnly(iso)).not.toBe(utcDay);
  });

  it('hands back an unparseable value instead of showing "Invalid Date"', () => {
    expect(dateTime('not a date')).toBe('not a date');
    expect(dateTime(null)).toBe('—');
  });
});

describe('traffic consumed', () => {
  const GB = 1024 ** 3;

  it('is written in the same digits as every other number on this panel', () => {
    // The bug this closes was invisible to every test and obvious on the screen:
    // «مصرف» rendered `0 گیگ` in Latin digits in the cell beside «حجم» rendering
    // `۱۰ گیگ` in Persian, because the rounding rule was copied from the bot
    // together with the bot's `toLocaleString('en-US')`.
    //
    // Measured against `Intl` directly rather than against `count()`, so this
    // cannot pass by two of our own functions agreeing with each other.
    const fa = new Intl.NumberFormat('fa-IR');
    expect(gigabytes(3 * GB)).toBe(`${fa.format(3)} گیگ`);
    expect(gigabytes(0)).toBe(`${fa.format(0)} گیگ`);
    // And the digits really are Persian, not merely equal to another call.
    expect(gigabytes(3 * GB)).toContain('۳');
    expect(gigabytes(3 * GB)).not.toMatch(/[0-9]/);
  });

  it("keeps the bot's rounding, so a quoted figure matches", () => {
    const fa = new Intl.NumberFormat('fa-IR');
    // One decimal normally, and the trailing zero dropped — `menu.ts` runs its
    // `toFixed(1)` back through `Number()`, which does the same.
    expect(gigabytes(3.5 * GB)).toBe(`${fa.format(3.5)} گیگ`);
    expect(gigabytes(3.04 * GB)).toBe(`${fa.format(3)} گیگ`);
    // Two decimals below a tenth of a gigabyte: a customer who has just started
    // is not shown "nothing".
    expect(gigabytes(0.05 * GB)).toBe(`${fa.format(0.05)} گیگ`);
    expect(gigabytes(0.05 * GB)).not.toBe(gigabytes(0));
  });

  it('says nothing at all when no panel has answered', () => {
    // Distinct from zero on purpose: a service the sweep has never reached and
    // a customer who has used nothing look identical otherwise.
    expect(gigabytes(null)).toBe('—');
    expect(gigabytes(undefined)).toBe('—');
  });
});

describe('when a dated code stops working', () => {
  it('lands on the first instant of the next Tehran day', () => {
    // Measured against `Intl` on Asia/Tehran, not against a copied offset: the
    // point of the helper is that there is no second definition of where
    // Tehran's midnight is.
    const at = (iso: string) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tehran',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(iso));

    // A code «until 2026-09-01» is refused when `expires_at <= now`, so the
    // instant it carries has to be the next day's midnight — otherwise the code
    // dies a day early and nobody but the customer finds out.
    expect(at(endOfTehranDay('2026-09-01'))).toBe('2026-09-02, 00:00:00');
    // Across a month end and a year end, where a naive +1 on the day breaks.
    expect(at(endOfTehranDay('2026-09-30'))).toBe('2026-10-01, 00:00:00');
    expect(at(endOfTehranDay('2026-12-31'))).toBe('2027-01-01, 00:00:00');
  });

  it('is a real instant, not the date it was handed', () => {
    // The failure mode if the helper ever gives up and returns its input: the
    // column is a timestamptz and a bare date would be read as UTC midnight,
    // which is 03:30 Tehran — three and a half hours of a day the admin meant
    // to include.
    const out = endOfTehranDay('2026-09-01');
    expect(out).not.toBe('2026-09-01');
    expect(out.endsWith('Z')).toBe(true);
  });
});

/**
 * The wallet ledger's own words.
 *
 * Three English sentences are written into `wallet_entries.note` at the moment
 * the row is created — by `packages/migrate` for every migrated opening
 * balance, and by `apps/bot` for renewal cashback and referral commission. The
 * panel printed them verbatim, so «تراکنش‌ها» read
 * «legacy balance carried over unchanged» and «5% of a renewal» in a Persian
 * table, and the actor column said «SYSTEM».
 *
 * Translated on the way out rather than in the database: `kind` already carries
 * the whole meaning, the note only adds a percentage, and rewriting an
 * append-only ledger to fix its wording is not a trade anybody should take.
 */
describe('the ledger, in Persian', () => {
  it('names the three notes the system writes', () => {
    expect(entryNoteFa('OPENING', 'legacy balance carried over unchanged')).toBe(
      'موجودی اولیه، همان‌طور که از ربات قدیمی منتقل شد',
    );
    // The percentage is the only thing the note adds to `kind`, so it survives
    // — in Persian digits, like every other number on the screen.
    expect(entryNoteFa('RENEWAL_CASHBACK', '5% of a renewal')).toBe('۵٪ هدیهٔ تمدید');
    expect(entryNoteFa('REFERRAL_BONUS', '10% of a first purchase')).toBe(
      '۱۰٪ پورسانت اولین خرید زیرمجموعه',
    );
  });

  it('leaves a note an operator typed alone', () => {
    // `ADMIN_ADJUST` notes are typed by a person and are already Persian; a
    // mapping that swallowed them would erase the reason a balance changed.
    expect(entryNoteFa('ADMIN_ADJUST', 'بابت خرابی سرویس')).toBe('بابت خرابی سرویس');
    // An unrecognised note is shown rather than hidden: a row whose reason the
    // panel cannot translate still has a reason.
    expect(entryNoteFa('TOPUP', 'something new from a later build')).toBe(
      'something new from a later build',
    );
    expect(entryNoteFa('TOPUP', null)).toBe(null);
  });

  it('names the system as the system', () => {
    expect(actorFa('SYSTEM')).toBe('سیستم');
    // An operator's email is who they are; it is not translated.
    expect(actorFa('sam@samsos.org')).toBe('sam@samsos.org');
    expect(actorFa(null)).toBe(null);
  });
});

/**
 * A plan name that already contains its price.
 *
 * Every product migrated from Mirzabot has the Toman price inside its name —
 * «1ماهه-20گیگ-چند کاربر-200.000» — because the legacy bot had no price column
 * on the button. Beside a «مبلغ» column that says «۲۰۰٬۰۰۰ تومان» the row reads
 * the number twice, and the second one is not even formatted like the first.
 *
 * Only the trailing price goes. `plan_name_at_sale` is frozen at the moment of
 * sale and is not touched; this is what the table draws.
 */
describe('a plan name with its price baked in', () => {
  it('drops the price the amount column already shows', () => {
    expect(planDisplayName('1ماهه-20گیگ-چند کاربر-200.000')).toBe('1ماهه-20گیگ-چند کاربر');
    expect(planDisplayName('2ماهه-50گیگ-329.000ت')).toBe('2ماهه-50گیگ');
    expect(planDisplayName('6ماهه-300گیگ-چند کاربر-1.300.000ت')).toBe('6ماهه-300گیگ-چند کاربر');
    expect(planDisplayName('نامحدود - تک لوکیشن - 250.000 تومان')).toBe('نامحدود - تک لوکیشن');
  });

  it('leaves a name that is not a price alone', () => {
    expect(planDisplayName('سرویس تست')).toBe('سرویس تست');
    expect(planDisplayName('۱ ماهه')).toBe('۱ ماهه');
    // A number that is part of what is being sold, not its price.
    expect(planDisplayName('سرویس طلایی - بدون محدودیت یوزر و زمان')).toBe(
      'سرویس طلایی - بدون محدودیت یوزر و زمان',
    );
    // Three digits with no thousands group is a volume or a duration, not a
    // price: «1ماهه-100گیگ» must not lose its size.
    expect(planDisplayName('1ماهه-100گیگ')).toBe('1ماهه-100گیگ');
    expect(planDisplayName(null)).toBe(null);
  });
});
