/**
 * Layout-faithful fixtures for the six real Iranian bank SMS samples.
 *
 * Bodies are synthesized to match the parser layouts with the expected
 * values listed in the plan's "Expected outcome" table. The 6 raw bodies
 * are also exercised end-to-end via scripts/verify-six-samples.ts against
 * the deployed ingest endpoint.
 *
 * Reference SMS timestamp ≈ 2026-08-05 09:00 UTC (Jalali 1405/05/14).
 */

import { describe, expect, it } from 'vitest';
import { parseSms } from '../src/index.js';
import type { NormalizedSms, ParseResult } from '@shikoo/contracts';

const SMS_TIMESTAMP = Date.UTC(2026, 7, 5, 9, 0, 0); // 2026-08-05 09:00 UTC

function n(raw: string, smsTimestamp = SMS_TIMESTAMP): NormalizedSms {
  return { raw, text: raw, sender: 'BANK', timestamp: smsTimestamp, deviceId: 'phone-a' };
}

function identifiers(result: ParseResult) {
  return result.evidence.detectedIdentifiers as Array<{
    type: string;
    normalizedValue: string;
    parserId: string;
  }>;
}

describe('Sample 1 — account-transfer-signed-v1', () => {
  it('parses انتقال اینترنت layout with حساب:310057795083', () => {
    const raw = [
      'انتقال اینترنت',
      'حساب:310057795083',
      'مبلغ:5,500,000+',
      'مانده:82,791,067',
      '05/14-11:30',
    ].join('\n');
    const r = parseSms(n(raw));
    expect(r.matched).toBe(true);
    expect(r.classification).toBe('BANK_TRANSACTION');
    expect(r.parserId).toBe('account-transfer-signed-v1');
    expect(r.direction).toBe('CREDIT');
    expect(r.amountIrr).toBe(5_500_000);
    expect(r.balanceIrr).toBe(82_791_067);
    expect(r.accountHint).toBe('310057795083');
    const ids = identifiers(r);
    expect(ids.length).toBe(1);
    expect(ids[0]!.type).toBe('ACCOUNT_NUMBER');
    expect(ids[0]!.normalizedValue).toBe('310057795083');
  });
});

describe('Sample 2 — compact-signed-v1 (777.888.21654304.1)', () => {
  it('parses the dotted-account layout', () => {
    const raw = ['777.888.21654304.1', '+2,000,000', '05/14_17:04', 'مانده: 134,760,000'].join(
      '\n',
    );
    const r = parseSms(n(raw));
    expect(r.matched).toBe(true);
    expect(r.parserId).toBe('compact-signed-v1');
    expect(r.direction).toBe('CREDIT');
    expect(r.amountIrr).toBe(2_000_000);
    expect(r.balanceIrr).toBe(134_760_000);
    expect(r.accountHint).toBe('777.888.21654304.1');
  });
});

describe('Sample 3 — compact-signed-v1 (10.5718857.1)', () => {
  it('parses the dotted-account layout', () => {
    const raw = ['10.5718857.1', '+1,000,000', '05/14_20:30', 'مانده: 1,070,374,127'].join('\n');
    const r = parseSms(n(raw));
    expect(r.matched).toBe(true);
    expect(r.parserId).toBe('compact-signed-v1');
    expect(r.direction).toBe('CREDIT');
    expect(r.amountIrr).toBe(1_000_000);
    expect(r.balanceIrr).toBe(1_070_374_127);
    expect(r.accountHint).toBe('10.5718857.1');
  });
});

describe('Sample 4 — melli-transfer-v1', () => {
  it('parses بانك ملي layout with حساب:17000', () => {
    const raw = [
      'بانك ملي',
      'انتقال:+1,500,000',
      'حساب:17000',
      'مانده:78,159,809',
      '05/14-16:30',
    ].join('\n');
    const r = parseSms(n(raw));
    expect(r.matched).toBe(true);
    expect(r.parserId).toBe('melli-transfer-v1');
    expect(r.direction).toBe('CREDIT');
    expect(r.amountIrr).toBe(1_500_000);
    expect(r.balanceIrr).toBe(78_159_809);
    expect(r.accountHint).toBe('17000');
    const ids = identifiers(r);
    expect(ids.length).toBe(1);
    expect(ids[0]!.type).toBe('ACCOUNT_HINT');
    expect(ids[0]!.normalizedValue).toBe('17000');
  });
});

describe('Sample 5 — compact-signed-v1 (trailing-sign layout)', () => {
  it('parses 300432401476 with bare 2,800,000+ amount and 1405/5/14-18:01 date', () => {
    const raw = ['300432401476', '2,800,000+', 'مانده:16,234,550', '1405/5/14-18:01'].join('\n');
    const r = parseSms(n(raw));
    expect(r.matched).toBe(true);
    expect(r.parserId).toBe('compact-signed-v1');
    expect(r.direction).toBe('CREDIT');
    expect(r.amountIrr).toBe(2_800_000);
    expect(r.balanceIrr).toBe(16_234_550);
    expect(r.accountHint).toBe('300432401476');
  });

  it('also accepts the YYYY/MM/DD-HH:mm and YYYY/MM/DD HH:mm variants', () => {
    const raw1 = ['30101883751600', '2,800,000+', 'مانده:40,913,550', '1405/05/14-18:01'].join(
      '\n',
    );
    const raw2 = ['30101883751600', '2,800,000+', 'مانده:40,913,550', '1405/05/14 18:01'].join(
      '\n',
    );
    const raw3 = ['30101883751600', '2,800,000+', 'مانده:40,913,550', '1405/05/14_18:01'].join(
      '\n',
    );
    for (const raw of [raw1, raw2, raw3]) {
      const r = parseSms(n(raw));
      expect(r.parserId, raw).toBe('compact-signed-v1');
      expect(r.amountIrr, raw).toBe(2_800_000);
      expect(r.balanceIrr, raw).toBe(40_913_550);
    }
  });
});

describe('Sample 6 — shahr-credit-v1', () => {
  it('parses *بانک شهر* layout with account 4003537814', () => {
    const raw = [
      '*بانک شهر*',
      'انتقال وجه کارتی',
      'واریز به:4003537814',
      'مبلغ:1,950,000 ریال',
      'موجودی:112,686,500 ریال',
      '1405/05/14 02:02:14',
    ].join('\n');
    const r = parseSms(n(raw));
    expect(r.matched).toBe(true);
    expect(r.parserId).toBe('shahr-credit-v1');
    expect(r.direction).toBe('CREDIT');
    expect(r.amountIrr).toBe(1_950_000);
    expect(r.balanceIrr).toBe(112_686_500);
    expect(r.accountHint).toBe('4003537814');
  });
});

describe('Generic parsers do NOT steal the 6 bank samples', () => {
  // Confirm precedence: the generic creditParser / balanceParser must not
  // out-compete the explicit bank parsers for these fixtures.
  const fixtures: Array<{ name: string; raw: string; expectedParser: string }> = [
    {
      name: 'sample 1',
      raw: [
        'انتقال اینترنت',
        'حساب:310057795083',
        'مبلغ:5,500,000+',
        'مانده:82,791,067',
        '05/14-11:30',
      ].join('\n'),
      expectedParser: 'account-transfer-signed-v1',
    },
    {
      name: 'sample 2',
      raw: ['777.888.21654304.1', '+2,000,000', '05/14_17:04', 'مانده: 134,760,000'].join('\n'),
      expectedParser: 'compact-signed-v1',
    },
    {
      name: 'sample 4',
      raw: ['بانك ملي', 'انتقال:+1,500,000', 'حساب:17000', 'مانده:78,159,809', '05/14-16:30'].join(
        '\n',
      ),
      expectedParser: 'melli-transfer-v1',
    },
    {
      name: 'sample 5',
      raw: ['300432401476', '2,800,000+', 'مانده:16,234,550', '1405/5/14-18:01'].join('\n'),
      expectedParser: 'compact-signed-v1',
    },
    {
      name: 'sample 6',
      raw: [
        '*بانک شهر*',
        'انتقال وجه کارتی',
        'واریز به:4003537814',
        'مبلغ:1,950,000 ریال',
        'موجودی:112,686,500 ریال',
        '1405/05/14 02:02:14',
      ].join('\n'),
      expectedParser: 'shahr-credit-v1',
    },
  ];

  for (const fx of fixtures) {
    it(`${fx.name} → ${fx.expectedParser}`, () => {
      const r = parseSms(n(fx.raw));
      expect(r.parserId, fx.name).toBe(fx.expectedParser);
      expect(r.classification, fx.name).toBe('BANK_TRANSACTION');
      expect(['CREDIT', 'DEBIT'], fx.name).toContain(r.direction);
      expect(r.amountIrr, fx.name).not.toBeNull();
    });
  }
});
