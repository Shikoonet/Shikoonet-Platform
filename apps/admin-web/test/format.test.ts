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
import { count, dateOnly, dateTime, irrToToman, toman, tomanCompact } from '../src/format.js';

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
