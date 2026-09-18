import { describe, expect, it } from 'vitest';
import { gregorianToJalali, jalaliToGregorianEpochMs } from '../src/jalali.js';

/** What a clock on the wall in Tehran reads at that instant — Intl's word, not ours. */
function tehranWallClock(epochMs: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(epochMs));
}

describe('Jalali conversion', () => {
  it('converts 2026-08-05 (Gregorian) to 1405/05/14', () => {
    const ms = Date.UTC(2026, 7, 5, 0, 0, 0, 0); // Aug 5, 2026 UTC
    const j = gregorianToJalali(ms);
    expect(j).toEqual({ jy: 1405, jm: 5, jd: 14 });
  });

  it('reads 1405/05/14 08:22:17 as a Tehran clock: 2026-08-05 08:22:17 in Asia/Tehran', () => {
    const got = jalaliToGregorianEpochMs(1405, 5, 14, 8, 22, 17);
    expect(tehranWallClock(got)).toBe('05/08/2026, 08:22:17');
    expect(got).toBe(Date.UTC(2026, 7, 5, 4, 52, 17, 0));
  });

  it('keeps the date across Tehran midnight, where UTC is still the day before', () => {
    const got = jalaliToGregorianEpochMs(1405, 5, 14, 0, 23, 38);
    expect(tehranWallClock(got)).toBe('05/08/2026, 00:23:38');
    expect(new Date(got).getUTCDate()).toBe(4);
  });

  it('round-trips 1405/05/13 23:53:14', () => {
    const got = jalaliToGregorianEpochMs(1405, 5, 13, 23, 53, 14);
    expect(tehranWallClock(got)).toBe('04/08/2026, 23:53:14');
  });

  it('handles a known earlier date 1400/01/01 → 2021-03-21 (Tehran)', () => {
    const got = jalaliToGregorianEpochMs(1400, 1, 1);
    expect(tehranWallClock(got)).toBe('21/03/2021, 00:00:00');
  });

  it('is the bank line on the Melli SMS of 2026-09-18: «0627-20:35» is 20:35 Tehran, 17:05 UTC', () => {
    const got = jalaliToGregorianEpochMs(1405, 6, 27, 20, 35);
    expect(tehranWallClock(got)).toBe('18/09/2026, 20:35:00');
    expect(got).toBe(Date.UTC(2026, 8, 18, 17, 5, 0, 0));
  });

  it('throws on out-of-range year', () => {
    expect(() => jalaliToGregorianEpochMs(900, 1, 1)).toThrow();
    expect(() => jalaliToGregorianEpochMs(2000, 1, 1)).toThrow();
  });

  it('throws on bad month/day/hour', () => {
    expect(() => jalaliToGregorianEpochMs(1405, 13, 1)).toThrow();
    expect(() => jalaliToGregorianEpochMs(1405, 0, 1)).toThrow();
    expect(() => jalaliToGregorianEpochMs(1405, 1, 0)).toThrow();
    expect(() => jalaliToGregorianEpochMs(1405, 1, 1, 24)).toThrow();
  });
});
