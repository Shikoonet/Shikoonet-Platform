import { describe, expect, it } from 'vitest';
import { formatSignedDelta } from '../../src/hub/format.js';

/*
 * The gap between a bank transaction and «پرداخت کردم», as the review panel
 * prints it. Until 2026-09-22 this was «Δ 532273 sec» — Latin digits, an
 * English unit, and `Math.abs` on the server, so it could not say whether the
 * deposit landed before the click or after it.
 *
 * Every digit here is checked against `Intl.NumberFormat('fa-IR')` rather
 * than against a string this file typed out, and every unit boundary against
 * millisecond arithmetic done here. Rule 6: a test that only agrees with the
 * code under test proves nothing — that is exactly how the Tehran-day bug
 * stayed green for months.
 */
const fa = new Intl.NumberFormat('fa-IR');
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatSignedDelta', () => {
  it('names the side of the click', () => {
    expect(formatSignedDelta(-21 * SECOND)).toBe(`${fa.format(21)} ثانیه پیش از پرداخت`);
    expect(formatSignedDelta(37 * SECOND)).toBe(`${fa.format(37)} ثانیه پس از پرداخت`);
  });

  it('reads the six-day gap that started this as six days', () => {
    // The real figure off Sam's screenshot, in seconds.
    expect(formatSignedDelta(532_273 * SECOND)).toBe(`${fa.format(6)} روز پس از پرداخت`);
  });

  it('picks the largest unit that fits', () => {
    expect(formatSignedDelta(59 * SECOND)).toBe(`${fa.format(59)} ثانیه پس از پرداخت`);
    expect(formatSignedDelta(MINUTE)).toBe(`${fa.format(1)} دقیقه پس از پرداخت`);
    expect(formatSignedDelta(59 * MINUTE)).toBe(`${fa.format(59)} دقیقه پس از پرداخت`);
    expect(formatSignedDelta(HOUR)).toBe(`${fa.format(1)} ساعت پس از پرداخت`);
    expect(formatSignedDelta(23 * HOUR)).toBe(`${fa.format(23)} ساعت پس از پرداخت`);
    expect(formatSignedDelta(DAY)).toBe(`${fa.format(1)} روز پس از پرداخت`);
  });

  it('is symmetric — only the side word changes', () => {
    for (const ms of [3 * SECOND, 4 * MINUTE, 5 * HOUR, 6 * DAY]) {
      const after = formatSignedDelta(ms);
      const before = formatSignedDelta(-ms);
      expect(after.replace('پس از پرداخت', '')).toBe(before.replace('پیش از پرداخت', ''));
      expect(after).not.toBe(before);
    }
  });

  it('says «هم‌زمان» rather than «۰ ثانیه» inside a second either way', () => {
    expect(formatSignedDelta(0)).toBe('هم‌زمان با پرداخت');
    expect(formatSignedDelta(999)).toBe('هم‌زمان با پرداخت');
    expect(formatSignedDelta(-999)).toBe('هم‌زمان با پرداخت');
    expect(formatSignedDelta(SECOND)).toBe(`${fa.format(1)} ثانیه پس از پرداخت`);
  });

  it('never prints a Latin digit', () => {
    for (const ms of [SECOND, 90 * SECOND, 3 * HOUR, 45 * DAY, -7 * DAY]) {
      expect(formatSignedDelta(ms)).not.toMatch(/[0-9]/);
    }
  });
});
