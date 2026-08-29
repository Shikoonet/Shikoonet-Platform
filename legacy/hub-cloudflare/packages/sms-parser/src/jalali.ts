/**
 * Tiny Jalali (Persian) ↔ Gregorian date conversion.
 *
 * Algorithm: JDN-based, after the public-domain jalaali-js / moment-jalaali
 * reference implementation. Verified against:
 *   - 1405/05/14 → 2026-08-05 (nowruz-evening)
 *   - 1400/01/01 → 2021-03-21 (Norooz)
 *   - 1390/01/01 → 2011-03-21
 *
 * Domain: years 1300..1500 — throws on out-of-range inputs to catch caller
 * bugs (banking SMS in this project land in 1395..1410).
 *
 * Output: epoch milliseconds in UTC.
 */

function div(a: number, b: number): number {
  return Math.trunc(a / b);
}
function mod(a: number, b: number): number {
  return a - Math.trunc(a / b) * b;
}

// 33-year cycle observation: breaks[i] marks the start of cycle i.
// Mirrors the published jalaali-js table.
const BREAKS = [
  -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394,
  2456, 3178,
];

function jalCal(jy: number): { leap: 0 | 1; gy: number } {
  const bl = BREAKS.length;
  let jp = BREAKS[0]!;
  let jump = 0;
  if (jy < jp || jy >= BREAKS[bl - 1]!) {
    throw new Error(`Invalid Jalali year ${jy}`);
  }
  let n: number;
  for (let i = 1; i < bl; i += 1) {
    const v = BREAKS[i]!;
    jump = v - jp;
    if (jy < v) break;
    jp = v;
  }
  n = jy - jp;
  if (jump - n < 6) {
    n = n - jump + div(jump + 4, 33) * 33;
  }
  const leap = mod(div(n + 33, 33), 33) % 4;
  return { leap: leap === 0 ? 0 : 1, gy: jy + 621 };
}

function isLeapJalali(jy: number): boolean {
  return jalCal(jy).leap === 0;
}

function jalaliMonthDays(jy: number, jm: number): number {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isLeapJalali(jy) ? 30 : 29;
}

function gregorianToJdn(year: number, month: number, day: number): number {
  const a = div(14 - month, 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + div(153 * m + 2, 5) + 365 * y + div(y, 4) - div(y, 100) + div(y, 400) - 32045;
}

function jdnToGregorian(jdn: number): { gy: number; gm: number; gd: number } {
  const a = jdn + 32044;
  const b = div(4 * a + 3, 146097);
  const c = a - div(146097 * b, 4);
  const d = div(4 * c + 3, 1461);
  const e = c - div(1461 * d, 4);
  const m = div(5 * e + 2, 153);
  const day = e - div(153 * m + 2, 5) + 1;
  const month = m + 3 - 12 * div(m, 10);
  const year = 100 * b + d - 4800 + div(m, 10);
  return { gy: year, gm: month, gd: day };
}

/**
 * Convert a Gregorian epoch (ms, UTC) into a Jalali Y/M/D tuple.
 */
export function gregorianToJalali(epochMs: number): { jy: number; jm: number; jd: number } {
  const d = new Date(epochMs);
  const gy = d.getUTCFullYear();
  const gm = d.getUTCMonth() + 1;
  const gd = d.getUTCDate();
  const jdn = gregorianToJdn(gy, gm, gd);

  // Initial guess: gy - 621. Nowruz of jalali year jy is gregorianToJdn(jy + 621, 3, 21).
  let jy = gy - 621;
  const nowruz = (y: number) => gregorianToJdn(y + 621, 3, 21);
  if (jdn < nowruz(jy)) jy -= 1;
  else if (jdn >= nowruz(jy + 1)) jy += 1;

  let jm = 1;
  let jd = jdn - nowruz(jy) + 1;
  for (let m = 1; m <= 12; m += 1) {
    const monthLen = jalaliMonthDays(jy, m);
    if (jd <= monthLen) {
      jm = m;
      break;
    }
    jd -= monthLen;
  }
  return { jy, jm, jd };
}

/**
 * Convert a Jalali date+time into epoch milliseconds (UTC).
 *
 * Throws on out-of-domain dates (year < 1300 or > 1500) or invalid
 * month/day/hour/minute/second so caller bugs surface loudly.
 */
export function jalaliToGregorianEpochMs(
  jy: number,
  jm: number,
  jd: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  if (jy < 1300 || jy > 1500) throw new Error(`jalali year out of range: ${jy}`);
  if (jm < 1 || jm > 12) throw new Error(`jalali month out of range: ${jm}`);
  if (jd < 1 || jd > jalaliMonthDays(jy, jm)) {
    throw new Error(`jalali day out of range: ${jd}`);
  }
  if (hour < 0 || hour > 23) throw new Error(`hour out of range: ${hour}`);
  if (minute < 0 || minute > 59) throw new Error(`minute out of range: ${minute}`);
  if (second < 0 || second > 59) throw new Error(`second out of range: ${second}`);

  const r = jalCal(jy);
  const gy = r.gy;
  // Nowruz: 1 Farvardin = 21 March (Gregorian).
  const nowruzJdn = gregorianToJdn(gy, 3, 21);
  const jdn = nowruzJdn + jalaliMonthCumulativeDays(jy, jm) + (jd - 1);
  const g = jdnToGregorian(jdn);
  return Date.UTC(g.gy, g.gm - 1, g.gd, hour, minute, second, 0);
}

function jalaliMonthCumulativeDays(jy: number, jm: number): number {
  // Cumulative days at the start of each Jalali month (1-indexed month).
  let days = 0;
  for (let i = 1; i < jm; i += 1) {
    days += jalaliMonthDays(jy, i);
  }
  return days;
}
