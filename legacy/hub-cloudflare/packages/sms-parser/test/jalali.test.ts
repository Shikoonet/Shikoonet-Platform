import { describe, expect, it } from 'vitest';
import { gregorianToJalali, jalaliToGregorianEpochMs } from '../src/jalali.js';

describe('Jalali conversion', () => {
  it('converts 2026-08-05 (Gregorian) to 1405/05/14', () => {
    const ms = Date.UTC(2026, 7, 5, 0, 0, 0, 0); // Aug 5, 2026 UTC
    const j = gregorianToJalali(ms);
    expect(j).toEqual({ jy: 1405, jm: 5, jd: 14 });
  });

  it('round-trips 1405/05/14 08:22:17 → 2026-08-05 08:22:17 UTC', () => {
    const expected = Date.UTC(2026, 7, 5, 8, 22, 17, 0);
    const got = jalaliToGregorianEpochMs(1405, 5, 14, 8, 22, 17);
    expect(got).toBe(expected);
  });

  it('round-trips 1405/05/14 00:23:38', () => {
    const expected = Date.UTC(2026, 7, 5, 0, 23, 38, 0);
    const got = jalaliToGregorianEpochMs(1405, 5, 14, 0, 23, 38);
    expect(got).toBe(expected);
  });

  it('round-trips 1405/05/13 23:53:14', () => {
    const expected = Date.UTC(2026, 7, 4, 23, 53, 14, 0);
    const got = jalaliToGregorianEpochMs(1405, 5, 13, 23, 53, 14);
    expect(got).toBe(expected);
  });

  it('handles a known earlier date 1400/01/01 → 2021-03-21', () => {
    const expected = Date.UTC(2021, 2, 21, 0, 0, 0, 0);
    const got = jalaliToGregorianEpochMs(1400, 1, 1);
    expect(got).toBe(expected);
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
