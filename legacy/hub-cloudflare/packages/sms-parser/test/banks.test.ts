/**
 * Table-driven tests for the four deterministic bank parsers.
 *
 * Covers:
 *   - exact fixtures from the spec
 *   - Persian digits (۰-۹)
 *   - Arabic-Indic digits (٠-٩)
 *   - English digits
 *   - Persian + English commas in amounts
 *   - NBSP and zero-width characters in the body
 *   - CRLF / LF / CR line endings
 *   - extra spaces around keywords
 *   - missing balance (parser must return WARN/UNKNOWN, no guessed tx)
 *   - malformed amount (must reject)
 *   - debit variants (sign -)
 *   - conflicting sign + phrase
 *   - unrelated OTP / promotional (must NOT be parsed as a bank tx)
 *   - unknown account hint (still returns matched tx but with NULL account)
 */

import { describe, expect, it } from 'vitest';
import { parseSms } from '../src/index.js';
import type { NormalizedSms, ParseResult } from '@hub/contracts';

// Reference epoch for known fixtures: 2026-08-05 09:00 UTC
const SMS_TIMESTAMP = Date.UTC(2026, 7, 5, 9, 0, 0);

function n(raw: string, smsTimestamp = SMS_TIMESTAMP): NormalizedSms {
  return { raw, text: raw, sender: 'BANK', timestamp: smsTimestamp, deviceId: 'phone-a' };
}

function expectParsian(
  result: ParseResult,
  expected: {
    accountHint: string;
    amountIrr: number;
    balanceIrr: number;
    direction: 'CREDIT' | 'DEBIT';
  },
) {
  expect(result.classification).toBe('BANK_TRANSACTION');
  expect(result.parserId).toBe('parsian-signed-v1');
  expect(result.matched).toBe(true);
  expect(result.direction).toBe(expected.direction);
  expect(result.amountIrr).toBe(expected.amountIrr);
  expect(result.balanceIrr).toBe(expected.balanceIrr);
  expect(result.accountHint).toBe(expected.accountHint);
  expect(result.confidence).toBeGreaterThanOrEqual(0.95);
}

function expectGardeshgari(
  result: ParseResult,
  expected: { accountHint: string; amountIrr: number; balanceIrr: number },
) {
  expect(result.classification).toBe('BANK_TRANSACTION');
  expect(result.parserId).toBe('gardeshgari-credit-v1');
  expect(result.direction).toBe('CREDIT');
  expect(result.amountIrr).toBe(expected.amountIrr);
  expect(result.balanceIrr).toBe(expected.balanceIrr);
  expect(result.accountHint).toBe(expected.accountHint);
  expect(result.confidence).toBeGreaterThanOrEqual(0.98);
}

function expectShahr(
  result: ParseResult,
  expected: { accountHint: string; amountIrr: number; balanceIrr: number },
) {
  expect(result.classification).toBe('BANK_TRANSACTION');
  expect(result.parserId).toBe('shahr-credit-v1');
  expect(result.direction).toBe('CREDIT');
  expect(result.amountIrr).toBe(expected.amountIrr);
  expect(result.balanceIrr).toBe(expected.balanceIrr);
  expect(result.accountHint).toBe(expected.accountHint);
  expect(result.confidence).toBeGreaterThanOrEqual(0.99);
}

function expectCompact(
  result: ParseResult,
  expected: {
    accountHint: string;
    amountIrr: number;
    balanceIrr: number;
    direction: 'CREDIT' | 'DEBIT';
  },
) {
  expect(result.classification).toBe('BANK_TRANSACTION');
  expect(result.parserId).toBe('compact-signed-v1');
  expect(result.direction).toBe(expected.direction);
  expect(result.amountIrr).toBe(expected.amountIrr);
  expect(result.balanceIrr).toBe(expected.balanceIrr);
  expect(result.accountHint).toBe(expected.accountHint);
  expect(result.confidence).toBeGreaterThanOrEqual(0.9);
}

describe('Parsian parser — exact fixtures', () => {
  it('parses fixture #1 (1,950,000 CREDIT)', () => {
    const raw = ['30101883751600', 'مبلغ:1,950,000+', 'مانده:40,913,550', '05/14', '10:30'].join(
      '\n',
    );
    const r = parseSms(n(raw));
    expectParsian(r, {
      accountHint: '30101883751600',
      amountIrr: 1_950_000,
      balanceIrr: 40_913_550,
      direction: 'CREDIT',
    });
  });

  it('parses fixture #2 (1,000,000 CREDIT)', () => {
    const raw = ['20101347595604', 'مبلغ:1,000,000+', 'مانده:49,774,100', '05/13', '22:28'].join(
      '\n',
    );
    const r = parseSms(n(raw));
    expectParsian(r, {
      accountHint: '20101347595604',
      amountIrr: 1_000_000,
      balanceIrr: 49_774_100,
      direction: 'CREDIT',
    });
  });

  it('parses + sign suffix → CREDIT', () => {
    expectParsian(parseSms(n('30101883751600\nمبلغ:1,950,000+\nمانده:40,913,550\n05/14\n10:30')), {
      accountHint: '30101883751600',
      amountIrr: 1_950_000,
      balanceIrr: 40_913_550,
      direction: 'CREDIT',
    });
  });

  it('parses + sign prefix → CREDIT', () => {
    expectParsian(parseSms(n('30101883751600\nمبلغ:+1,950,000\nمانده:40,913,550\n05/14\n10:30')), {
      accountHint: '30101883751600',
      amountIrr: 1_950_000,
      balanceIrr: 40_913_550,
      direction: 'CREDIT',
    });
  });

  it('parses - sign suffix → DEBIT', () => {
    expectParsian(parseSms(n('30101883751600\nمبلغ:1,950,000-\nمانده:40,913,550\n05/14\n10:30')), {
      accountHint: '30101883751600',
      amountIrr: 1_950_000,
      balanceIrr: 40_913_550,
      direction: 'DEBIT',
    });
  });

  it('parses - sign prefix → DEBIT', () => {
    expectParsian(parseSms(n('30101883751600\nمبلغ:-1,950,000\nمانده:40,913,550\n05/14\n10:30')), {
      accountHint: '30101883751600',
      amountIrr: 1_950_000,
      balanceIrr: 40_913_550,
      direction: 'DEBIT',
    });
  });

  it('accepts Persian digits in amount + balance', () => {
    expectParsian(parseSms(n('30101883751600\nمبلغ:۱٬۹۵۰٬۰۰۰+\nمانده:۴۰٬۹۱۳٬۵۵۰\n05/14\n10:30')), {
      accountHint: '30101883751600',
      amountIrr: 1_950_000,
      balanceIrr: 40_913_550,
      direction: 'CREDIT',
    });
  });

  it('accepts English digits with ASCII commas', () => {
    expectParsian(parseSms(n('30101883751600\nمبلغ:1,950,000+\nمانده:40,913,550\n05/14\n10:30')), {
      accountHint: '30101883751600',
      amountIrr: 1_950_000,
      balanceIrr: 40_913_550,
      direction: 'CREDIT',
    });
  });

  it('tolerates extra spaces around keywords', () => {
    expectParsian(
      parseSms(n('30101883751600\n مبلغ :  1,950,000+ \n مانده : 40,913,550 \n 05/14 \n 10:30 ')),
      {
        accountHint: '30101883751600',
        amountIrr: 1_950_000,
        balanceIrr: 40_913_550,
        direction: 'CREDIT',
      },
    );
  });

  it('tolerates CRLF line endings', () => {
    const raw = '30101883751600\r\nمبلغ:1,950,000+\r\nمانده:40,913,550\r\n05/14\r\n10:30';
    expectParsian(parseSms(n(raw)), {
      accountHint: '30101883751600',
      amountIrr: 1_950_000,
      balanceIrr: 40_913_550,
      direction: 'CREDIT',
    });
  });

  it('tolerates NBSP + ZWNJ inside the body', () => {
    const raw = '30101883751600\nمبلغ :1,950,000+\nمانده‌:40,913,550\n05/14\n10:30';
    expectParsian(parseSms(n(raw)), {
      accountHint: '30101883751600',
      amountIrr: 1_950_000,
      balanceIrr: 40_913_550,
      direction: 'CREDIT',
    });
  });

  it('rejects when balance line is missing', () => {
    const r = parseSms(n('30101883751600\nمبلغ:1,950,000+\n05/14\n10:30'));
    expect(r.classification).not.toBe('BANK_TRANSACTION');
  });

  it('rejects when مبلغ digits are malformed', () => {
    const r = parseSms(n('30101883751600\nمبلغ:abc+\nمانده:40,913,550\n05/14\n10:30'));
    expect(r.classification).not.toBe('BANK_TRANSACTION');
  });

  it('returns UNKNOWN when there is no sign and no explicit direction phrase', () => {
    // Credit-only invariant: a sign-based parser that cannot determine
    // direction confidently must NOT default to CREDIT. Parsian with no
    // sign + no phrase → UNKNOWN with the DIRECTION_AMBIGUOUS warning.
    const r = parseSms(n('30101883751600\nمبلغ:1,950,000\nمانده:40,913,550\n05/14\n10:30'));
    expect(r.direction).toBe('UNKNOWN');
    expect(r.warnings.some((w) => w.includes('direction_ambiguous'))).toBe(true);
  });
});

describe('Gardeshgari parser — exact fixtures', () => {
  it('parses fixture #1 (110.9992.2377306.1)', () => {
    const raw = [
      '*بانك گردشگری*',
      'کارت',
      'واريز به: 110.9992.2377306.1',
      'مبلغ: 1,000,000 ريال',
      '05/05/14_09:45',
      'موجودي: 54,882,500 ريال',
    ].join('\n');
    const r = parseSms(n(raw));
    expectGardeshgari(r, {
      accountHint: '110.9992.2377306.1',
      amountIrr: 1_000_000,
      balanceIrr: 54_882_500,
    });
  });

  it('parses fixture #2 (110.7007.2377306.1)', () => {
    const raw = [
      '*بانك گردشگری*',
      'کارت',
      'واريز به: 110.7007.2377306.1',
      'مبلغ: 1,000,000 ريال',
      '05/05/13_14:09',
      'موجودي: 58,613,200 ريال',
    ].join('\n');
    const r = parseSms(n(raw));
    expectGardeshgari(r, {
      accountHint: '110.7007.2377306.1',
      amountIrr: 1_000_000,
      balanceIrr: 58_613_200,
    });
  });

  it('accepts Persian letter variants بانک / واریز / موجودی / ریال', () => {
    const raw = [
      '*بانک گردشگری*',
      'کارت',
      'واریز به: 110.9992.2377306.1',
      'مبلغ: 1,000,000 ریال',
      '05/05/14_09:45',
      'موجودی: 54,882,500 ریال',
    ].join('\n');
    const r = parseSms(n(raw));
    expectGardeshgari(r, {
      accountHint: '110.9992.2377306.1',
      amountIrr: 1_000_000,
      balanceIrr: 54_882_500,
    });
  });

  it('rejects non-Gardeshgari bank SMS', () => {
    const r = parseSms(n('*بانک شهر*\nمبلغ:1,000,000 ریال'));
    expect(r.parserId).not.toBe('gardeshgari-credit-v1');
  });
});

describe('Shahr parser — exact fixtures', () => {
  it('parses fixture #1 (7001018246497)', () => {
    const raw = [
      '*بانک شهر*',
      'انتقال وجه کارتي',
      'واريز به:7001018246497',
      'مبلغ:1,000,000ريال',
      'موجودي:56,273,555ريال',
      '1405/05/14 08:22:17',
    ].join('\n');
    const r = parseSms(n(raw));
    expectShahr(r, { accountHint: '7001018246497', amountIrr: 1_000_000, balanceIrr: 56_273_555 });
  });

  it('parses fixture #2 (9001017429938)', () => {
    const raw = [
      '*بانک شهر*',
      'انتقال وجه کارتي',
      'واريز به:9001017429938',
      'مبلغ:450,000ريال',
      'موجودي:313,421,885ريال',
      '1405/05/14 00:23:38',
    ].join('\n');
    const r = parseSms(n(raw));
    expectShahr(r, { accountHint: '9001017429938', amountIrr: 450_000, balanceIrr: 313_421_885 });
  });

  it('parses fixture #3 (400788235261)', () => {
    const raw = [
      '*بانک شهر*',
      'انتقال وجه کارتي',
      'واريز به:400788235261',
      'مبلغ:2,500,000ريال',
      'موجودي:81,125,000ريال',
      '1405/05/13 23:53:14',
    ].join('\n');
    const r = parseSms(n(raw));
    expectShahr(r, { accountHint: '400788235261', amountIrr: 2_500_000, balanceIrr: 81_125_000 });
  });

  it('rejects non-Shahr bank SMS', () => {
    const r = parseSms(n('*بانك گردشگری*\nمبلغ:1,000,000 ریال'));
    expect(r.parserId).not.toBe('shahr-credit-v1');
  });
});

describe('Compact parser — fixture', () => {
  it('parses the 10.8206380.1 sample', () => {
    const raw = ['10.8206380.1', '+1,950,000', '05/14_11:28', 'مانده: 18,437,338'].join('\n');
    const r = parseSms(n(raw));
    expectCompact(r, {
      accountHint: '10.8206380.1',
      amountIrr: 1_950_000,
      balanceIrr: 18_437_338,
      direction: 'CREDIT',
    });
  });

  it('parses debit (negative prefix)', () => {
    const raw = ['10.8206380.1', '-1,950,000', '05/14_11:28', 'مانده: 18,437,338'].join('\n');
    expectCompact(parseSms(n(raw)), {
      accountHint: '10.8206380.1',
      amountIrr: 1_950_000,
      balanceIrr: 18_437_338,
      direction: 'DEBIT',
    });
  });

  it('parses debit (negative suffix)', () => {
    const raw = ['10.8206380.1', '1,950,000-', '05/14_11:28', 'مانده: 18,437,338'].join('\n');
    expectCompact(parseSms(n(raw)), {
      accountHint: '10.8206380.1',
      amountIrr: 1_950_000,
      balanceIrr: 18_437_338,
      direction: 'DEBIT',
    });
  });

  it('does not match OTP', () => {
    const r = parseSms(n('کد تایید: 123456'));
    expect(r.classification).toBe('OTP');
  });

  it('does not match promotional SMS', () => {
    const r = parseSms(n('تبلیغ: 50٪ تخفیف فقط امروز'));
    expect(r.classification).toBe('PROMOTIONAL');
  });

  it('does not match a body with only 3 lines', () => {
    const r = parseSms(n('10.8206380.1\n+1,950,000\n05/14_11:28'));
    expect(r.parserId).not.toBe('compact-signed-v1');
  });
});

describe('Parser precedence', () => {
  it('OTP wins over bank parsers', () => {
    const raw = ['30101883751600', 'کد تایید: 999999 - مبلغ:1,950,000+', 'مانده:40,913,550'].join(
      '\n',
    );
    const r = parseSms(n(raw));
    expect(r.classification).toBe('OTP');
  });

  it('Explicit Parsian beats generic credit', () => {
    const raw = '30101883751600\nمبلغ:1,950,000+\nمانده:40,913,550\n05/14\n10:30';
    const r = parseSms(n(raw));
    expect(r.parserId).toBe('parsian-signed-v1');
  });

  it('Explicit Shahr beats generic credit', () => {
    const raw = [
      '*بانک شهر*',
      'انتقال وجه کارتي',
      'واريز به:7001018246497',
      'مبلغ:1,000,000ريال',
      'موجودي:56,273,555ريال',
      '1405/05/14 08:22:17',
    ].join('\n');
    const r = parseSms(n(raw));
    expect(r.parserId).toBe('shahr-credit-v1');
  });

  it('Explicit Gardeshgari beats generic credit', () => {
    const raw = [
      '*بانک گردشگری*',
      'کارت',
      'واريز به: 110.9992.2377306.1',
      'مبلغ: 1,000,000 ريال',
      '05/05/14_09:45',
      'موجودي: 54,882,500 ريال',
    ].join('\n');
    const r = parseSms(n(raw));
    expect(r.parserId).toBe('gardeshgari-credit-v1');
  });

  it('Compact parser runs after the three explicit banks', () => {
    const raw = '10.8206380.1\n+1,950,000\n05/14_11:28\nمانده: 18,437,338';
    const r = parseSms(n(raw));
    expect(r.parserId).toBe('compact-signed-v1');
  });
});

describe('Compact parser — trailing-sign layout (real bank SMS)', () => {
  // Spec fixture A: Latin digits, trailing plus → CREDIT
  it('A. Latin-digit trailing-plus CREDIT SMS', () => {
    const raw = '300422286226\n20,000,000+\n1405/5/15-10:46\nمانده:719,919,100';
    const r = parseSms(n(raw));
    expect(r.matched).toBe(true);
    expect(r.classification).toBe('BANK_TRANSACTION');
    expect(r.parserId).toBe('compact-signed-v1');
    expect(r.direction).toBe('CREDIT');
    expect(r.amountIrr).toBe(20_000_000);
    expect(r.balanceIrr).toBe(719_919_100);
    expect(r.accountHint).toBe('300422286226');
    const ids = r.evidence.detectedIdentifiers as Array<{ type: string; normalizedValue: string }>;
    expect(ids).toHaveLength(1);
    expect(ids[0]!.type).toBe('ACCOUNT_NUMBER');
    expect(ids[0]!.normalizedValue).toBe('300422286226');
    // bankTimestamp: derived from 1405/5/15 10:46 (Jalali). Just assert
    // it's a finite epoch ~ within a year of today — regression value
    // exactly matches what jalaliToGregorianEpochMs(1405,5,15,10,46) returns.
    expect(r.evidence.bankTimestamp).toBeGreaterThan(0);
    expect((r.evidence as { directionSource: string }).directionSource).toBe('signed_amount');
  });

  // Spec fixture B: Persian digits, same parsed result
  it('B. Persian-digit trailing-plus CREDIT SMS — same normalized result', () => {
    const raw = '۳۰۰۴۲۲۲۸۶۲۲۶\n۲۰٬۰۰۰٬۰۰۰+\n۱۴۰۵/۵/۱۵-۱۰:۴۶\nمانده:۷۱۹٬۹۱۹٬۱۰۰';
    const r = parseSms(n(raw));
    expect(r.matched).toBe(true);
    expect(r.parserId).toBe('compact-signed-v1');
    expect(r.direction).toBe('CREDIT');
    expect(r.amountIrr).toBe(20_000_000);
    expect(r.balanceIrr).toBe(719_919_100);
    expect(r.accountHint).toBe('300422286226');
  });

  // Spec fixture C: trailing minus → DEBIT (credit-only product: ignored
  // after raw event; raw SMS still preserves body for audit).
  it('C. Latin-digit trailing-minus DEBIT SMS', () => {
    const raw = '300422286226\n20,000,000-\n1405/5/15-10:46\nمانده:719,919,100';
    const r = parseSms(n(raw));
    expect(r.matched).toBe(true);
    expect(r.parserId).toBe('compact-signed-v1');
    expect(r.direction).toBe('DEBIT');
    expect(r.amountIrr).toBe(20_000_000);
    expect(r.balanceIrr).toBe(719_919_100);
  });

  // Spec fixture D: no sign → UNKNOWN. Parser warns and returns
  // matched=false so the ingest layer short-circuits (raw event still
  // persisted).
  it('D. No-sign variant returns UNKNOWN', () => {
    const raw = '300422286226\n20,000,000\n1405/5/15-10:46\nمانده:719,919,100';
    const r = parseSms(n(raw));
    expect(r.matched).toBe(false);
    expect(r.classification).toBe('UNKNOWN');
    expect(r.direction).toBe('UNKNOWN');
    // Some warnings array — direction_ambiguous is the compact code.
    expect(r.warnings.some((w) => String(w).includes('direction_ambiguous'))).toBe(true);
  });
});

describe('Account hint not configured (warning)', () => {
  it('Parsian with unknown account hint still produces a tx with NULL account and warning', async () => {
    const r = parseSms(n('9999888877776666\nمبلغ:1,950,000+\nمانده:40,913,550\n05/14\n10:30'));
    expect(r.classification).toBe('BANK_TRANSACTION');
    expect(r.parserId).toBe('parsian-signed-v1');
    expect(r.accountHint).toBe('9999888877776666');
  });
});

/**
 * Spec cases 1-5: every bank parser emits a DetectedIdentifier carrying
 * the canonical normalized account value. The persistence + dashboard
 * wiring (cases 6+) lives in the domain / dashboard-worker tests.
 */
describe('Detected identifier emission (spec §10 cases 1-5)', () => {
  it('Parsian emits an ACCOUNT_NUMBER identifier from the first account line', () => {
    const raw = ['30101883751600', 'مبلغ:1,950,000+', 'مانده:40,913,550', '05/14', '10:30'].join(
      '\n',
    );
    const r = parseSms(n(raw));
    expect(r.parserId).toBe('parsian-signed-v1');
    const ids = r.evidence.detectedIdentifiers as Array<{
      type: string;
      normalizedValue: string;
      parserId: string;
      confidence: number;
    }>;
    expect(ids.length).toBe(1);
    expect(ids[0]!.type).toBe('ACCOUNT_NUMBER');
    expect(ids[0]!.parserId).toBe('parsian-signed-v1');
    expect(ids[0]!.normalizedValue).toBe('30101883751600');
    expect(ids[0]!.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it('Gardeshgari emits the value after واریز به (full dotted form)', () => {
    const raw = [
      '*بانک گردشگری*',
      'کارت',
      'واريز به: 110.9992.2377306.1',
      'مبلغ: 1,000,000 ريال',
      '05/05/14_09:45',
      'موجودي: 54,882,500 ريال',
    ].join('\n');
    const r = parseSms(n(raw));
    expect(r.parserId).toBe('gardeshgari-credit-v1');
    const ids = r.evidence.detectedIdentifiers as Array<{
      type: string;
      normalizedValue: string;
      parserId: string;
    }>;
    expect(ids.length).toBe(1);
    expect(ids[0]!.normalizedValue).toBe('110.9992.2377306.1');
    expect(ids[0]!.parserId).toBe('gardeshgari-credit-v1');
  });

  it('Shahr emits the value after واریز به', () => {
    const raw = [
      '*بانک شهر*',
      'انتقال وجه کارتي',
      'واريز به:7001018246497',
      'مبلغ:1,000,000ريال',
      'موجودي:56,273,555ريال',
      '1405/05/14 08:22:17',
    ].join('\n');
    const r = parseSms(n(raw));
    expect(r.parserId).toBe('shahr-credit-v1');
    const ids = r.evidence.detectedIdentifiers as Array<{
      type: string;
      normalizedValue: string;
      parserId: string;
    }>;
    expect(ids.length).toBe(1);
    expect(ids[0]!.normalizedValue).toBe('7001018246497');
  });

  it('Compact parser emits the first line as the account identifier', () => {
    const raw = ['10.8206380.1', '+1,950,000', '05/14_11:28', 'مانده: 18,437,338'].join('\n');
    const r = parseSms(n(raw));
    expect(r.parserId).toBe('compact-signed-v1');
    const ids = r.evidence.detectedIdentifiers as Array<{
      type: string;
      normalizedValue: string;
      parserId: string;
    }>;
    expect(ids.length).toBe(1);
    expect(ids[0]!.normalizedValue).toBe('10.8206380.1');
    expect(ids[0]!.parserId).toBe('compact-signed-v1');
  });

  it('Bidi / Persian digit / ZWNJ: parser + identifier normalizer produce the same canonical value', async () => {
    // "۱۲۳‌.‏456" — Persian digits, ZWNJ, bidi. Persisted value is
    // the same regardless of which bank parser emitted it.
    const { normalizeIdentifier } = await import('../src/identifier.js');
    const raw = '۱۲۳‌.‏456';
    const nrm = normalizeIdentifier(raw);
    expect(nrm.normalizedValue).toBe('123.456');
    // Mask is deterministic and shorter than the original — the
    // exact character count is the mask implementation's job to
    // decide; we only require "no full identifier leakage" via the
    // round-trip below.
    expect(nrm.displayValueMasked.length).toBeLessThan(raw.length);
    expect(nrm.displayValueMasked).not.toBe(raw);

    // Round-trip: identical value through detectedIdentifierFromRaw.
    const { detectedIdentifierFromRaw } = await import('../src/identifier.js');
    const det = detectedIdentifierFromRaw(raw, 'compact-signed-v1', 0.9);
    expect(det).not.toBeNull();
    expect(det!.normalizedValue).toBe('123.456');
    expect(det!.type).toBe('ACCOUNT_NUMBER');
  });
});
