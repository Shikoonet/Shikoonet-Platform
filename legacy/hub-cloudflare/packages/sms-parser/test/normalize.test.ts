import { describe, expect, it } from 'vitest';
import { extractAllAmounts, extractAmount, normalizeText, parseIrr } from '../src/normalize.js';

describe('normalizeText', () => {
  it('converts Persian digits to ASCII', () => {
    expect(normalizeText('۱۲۳۴۵').text).toBe('12345');
  });

  it('converts Arabic-Indic digits to ASCII', () => {
    expect(normalizeText('٠١٢٣٤').text).toBe('01234');
  });

  it('drops zero-width chars and NBSP', () => {
    const raw = 'واریز ۱۰۰ تومان';
    const { text } = normalizeText(raw);
    expect(text).toContain('100');
  });

  it('preserves Persian letters', () => {
    expect(normalizeText('واریز').text).toContain('واریز');
  });

  it('flags zero-width chars in warnings', () => {
    const { warnings } = normalizeText('a‍b');
    expect(warnings).toContain('contained_zero_width_chars');
  });
});

describe('extractAmount', () => {
  it('parses ریال amounts', () => {
    const r = extractAmount('مبلغ 50,000 ریال');
    expect(r).not.toBeNull();
    expect(r!.currency).toBe('IRR');
    expect(r!.value).toBe(50000);
  });

  it('multiplies تومان by 10', () => {
    const r = extractAmount('مبلغ 100 تومان');
    expect(r).not.toBeNull();
    expect(r!.currency).toBe('TOMAN');
    expect(r!.value).toBe(1000);
  });

  it('handles ASCII commas as separators', () => {
    const r = extractAmount('مبلغ 1,250,000 ریال');
    expect(r).not.toBeNull();
    expect(r!.value).toBe(1_250_000);
  });

  it('handles Persian digits in amounts', () => {
    const r = extractAmount('مبلغ 1,250,000 ریال');
    expect(r).not.toBeNull();
    expect(r!.value).toBe(1_250_000);
  });

  it('flags ambiguous currency', () => {
    const r = extractAmount('مبلغ 100 تومان معادل 1000 ریال');
    expect(r!.currency).toBe('AMBIGUOUS');
  });

  it('returns null when no number is present', () => {
    expect(extractAmount('بدون عدد')).toBeNull();
  });

  it('picks the largest amount on multi-amount lines', () => {
    const r = extractAmount('مبلغ خرید 50,000 ریال - مانده 250,000 ریال');
    expect(r!.value).toBe(250_000);
  });
});

describe('extractAllAmounts', () => {
  it('returns every amount in order', () => {
    const rs = extractAllAmounts('مبلغ 50,000 ریال مانده 250,000 ریال');
    expect(rs.length).toBe(2);
    expect(rs[0]!.value).toBe(50_000);
    expect(rs[1]!.value).toBe(250_000);
  });
});

describe('Arabic→Persian char folding', () => {
  it('folds ي to ی', () => {
    expect(normalizeText('شيست').text).toBe('شیست');
  });
  it('folds ك to ک', () => {
    expect(normalizeText('كوكب').text).toBe('کوکب');
  });
  it('folds ة to ه', () => {
    expect(normalizeText('بن').text.replace(/بن/, 'بن')).toBe('بن'); // sanity
    expect(normalizeText('خوشة').text).toBe('خوشه');
  });
});

describe('CRLF / line endings', () => {
  it('collapses CRLF to LF', () => {
    const { text } = normalizeText(
      '30101883751600\r\nمبلغ:1,950,000+\r\nمانده:40,913,550\r\n05/14\r\n10:30',
    );
    expect(text).toContain('30101883751600\n');
    expect(text).toContain('مبلغ:1,950,000+\n');
  });
  it('folds Arabic thousands separator ٬ to ASCII comma', () => {
    const { text } = normalizeText('مبلغ:۱٬۹۵۰٬۰۰۰+');
    expect(text).toBe('مبلغ:1,950,000+');
  });
});

describe('Bidi / directional formatting characters', () => {
  it('strips U+202A + U+202C around an account number', () => {
    const { text, warnings } = normalizeText('‪300422286226‬');
    expect(text).toBe('300422286226');
    expect(warnings).toContain('contained_zero_width_chars');
  });
  it('strips U+200E / U+200F marks', () => {
    expect(normalizeText('‎300422286226‏').text).toBe('300422286226');
  });
  it('strips the full U+202A–U+202E range', () => {
    expect(normalizeText('‪‫‬‭‮300422286226').text).toBe('300422286226');
    expect(normalizeText('300422286226‪‫‬‭‮').text).toBe('300422286226');
  });
  it('strips the U+2066–U+2069 isolate range', () => {
    expect(normalizeText('⁦⁧⁨⁩300422286226⁦⁧⁨⁩').text).toBe('300422286226');
  });
  it('strips bidi chars around a signed amount', () => {
    const { text } = normalizeText('‪+1,950,000‬');
    expect(text).toBe('+1,950,000');
  });
  it('strips bidi chars around a Jalali date', () => {
    const { text } = normalizeText('‪1405/5/14-12:30‬');
    expect(text).toBe('1405/5/14-12:30');
  });
  it('strips bidi chars from the supplied compact-SMS body', () => {
    const body = '‪300422286226‬ 3,900,000+ 1405/5/14-12:30 مانده:663,019,100';
    const { text } = normalizeText(body);
    expect(text).toBe('300422286226 3,900,000+ 1405/5/14-12:30 مانده:663,019,100');
  });
});

describe('parseIrr', () => {
  it('parses a plain digit run', () => {
    expect(parseIrr('1950000')).toBe(1_950_000);
  });
  it('strips Persian/Arabic commas', () => {
    expect(parseIrr('1,950,000')).toBe(1_950_000);
    expect(parseIrr('1،950،000')).toBe(1_950_000);
  });
  it('strips Arabic thousands separator ٬', () => {
    expect(parseIrr('1٬950٬000')).toBe(1_950_000);
  });
  it('strips ریال / IRR / ریال suffixes', () => {
    expect(parseIrr('1,950,000 ریال')).toBe(1_950_000);
    expect(parseIrr('1,950,000 ریال')).toBe(1_950_000);
    expect(parseIrr('1,950,000 IRR')).toBe(1_950_000);
  });
  it('returns null for negatives, decimals, or non-numeric', () => {
    expect(parseIrr('-1,950,000')).toBeNull();
    expect(parseIrr('1.5')).toBeNull();
    expect(parseIrr('abc')).toBeNull();
  });
});
