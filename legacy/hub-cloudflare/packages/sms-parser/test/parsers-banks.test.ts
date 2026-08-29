/**
 * Fixture tests for the four deterministic Iranian-bank SMS formats:
 *
 *   1. Internet transfer (4-line, header+amount on one line)
 *   2. Melli transfer variant (header, MMDD-HH:mm date, leading-zero hint)
 *   3. Saman deposit (6-line, واريز مبلغ on amount line, separate date+time)
 *   4. Compact credit notification (existing layout)
 *
 * Each section asserts the canonical parse result, then exercises the
 * normalization variants spelled out in the user spec:
 *   - Persian digits / Arabic-Indic digits
 *   - CRLF / LF line endings
 *   - extra whitespace around keywords
 *   - English / Persian thousands separators
 *   - RTL sign position (leading "+" and trailing "+")
 *   - leading zero preservation in account hints
 *   - hyphen preservation in account hints
 */

import { describe, expect, it } from 'vitest';
import { parseSms } from '../src/index.js';
import type { NormalizedSms, ParseResult } from '@hub/contracts';

// Reference epoch for known fixtures: 2026-08-05 09:00 UTC.
// All Jalali dates map to 1405/05/14..15.
const SMS_TIMESTAMP = Date.UTC(2026, 7, 5, 9, 0, 0);

function n(raw: string, smsTimestamp = SMS_TIMESTAMP): NormalizedSms {
  return { raw, text: raw, sender: 'BANK', timestamp: smsTimestamp, deviceId: 'phone-banks' };
}

function expectBankTx(
  result: ParseResult,
  expected: {
    parserId: string;
    bank: string;
    accountHint: string;
    amountIrr: number;
    balanceIrr: number;
    direction: 'CREDIT' | 'DEBIT';
    directionSource?: string;
    minConfidence?: number;
  },
) {
  expect(result.matched).toBe(true);
  expect(result.classification).toBe('BANK_TRANSACTION');
  expect(result.parserId).toBe(expected.parserId);
  expect(result.direction).toBe(expected.direction);
  expect(result.amountIrr).toBe(expected.amountIrr);
  expect(result.balanceIrr).toBe(expected.balanceIrr);
  expect(result.accountHint).toBe(expected.accountHint);
  expect(result.evidence.bank).toBe(expected.bank);
  expect(result.confidence).toBeGreaterThanOrEqual(expected.minConfidence ?? 0.9);
  if (expected.directionSource) {
    expect((result.evidence as { directionSource: string }).directionSource).toBe(
      expected.directionSource,
    );
  }
}

// ---------------------------------------------------------------------------
// Format 1 — Internet transfer (4-line, header+amount combined)
// ---------------------------------------------------------------------------

describe('Internet transfer parser — Format 1', () => {
  it('parses the spec fixture (550,000 CREDIT)', () => {
    const raw = [
      'انتقال اینترنت:+550,000',
      'حساب:310057795083',
      'مانده:83,341,067',
      '0515-10:06',
    ].join('\n');
    expectBankTx(parseSms(n(raw)), {
      parserId: 'internet-transfer-signed-v1',
      bank: 'UNKNOWN',
      accountHint: '310057795083',
      amountIrr: 550_000,
      balanceIrr: 83_341_067,
      direction: 'CREDIT',
      directionSource: 'signed_amount',
    });
  });

  it('parses the trailing-sign variant (550,000+)', () => {
    const raw = [
      'انتقال اینترنت:550,000+',
      'حساب:310057795083',
      'مانده:83,341,067',
      '0515-10:06',
    ].join('\n');
    expectBankTx(parseSms(n(raw)), {
      parserId: 'internet-transfer-signed-v1',
      bank: 'UNKNOWN',
      accountHint: '310057795083',
      amountIrr: 550_000,
      balanceIrr: 83_341_067,
      direction: 'CREDIT',
    });
  });

  it('parses the trailing-minus variant (DEBIT)', () => {
    const raw = [
      'انتقال اینترنت:550,000-',
      'حساب:310057795083',
      'مانده:83,341,067',
      '0515-10:06',
    ].join('\n');
    expectBankTx(parseSms(n(raw)), {
      parserId: 'internet-transfer-signed-v1',
      bank: 'UNKNOWN',
      accountHint: '310057795083',
      amountIrr: 550_000,
      balanceIrr: 83_341_067,
      direction: 'DEBIT',
    });
  });

  it('accepts Persian digits in amount + balance', () => {
    const raw = [
      'انتقال اینترنت:+۵۵۰٬۰۰۰',
      'حساب:310057795083',
      'مانده:۸۳٬۳۴۱٬۰۶۷',
      '۰۵۱۵-۱۰:۰۶',
    ].join('\n');
    expectBankTx(parseSms(n(raw)), {
      parserId: 'internet-transfer-signed-v1',
      bank: 'UNKNOWN',
      accountHint: '310057795083',
      amountIrr: 550_000,
      balanceIrr: 83_341_067,
      direction: 'CREDIT',
    });
  });

  it('tolerates CRLF line endings', () => {
    const raw = [
      'انتقال اینترنت:+550,000',
      'حساب:310057795083',
      'مانده:83,341,067',
      '0515-10:06',
    ].join('\r\n');
    expectBankTx(parseSms(n(raw)), {
      parserId: 'internet-transfer-signed-v1',
      bank: 'UNKNOWN',
      accountHint: '310057795083',
      amountIrr: 550_000,
      balanceIrr: 83_341_067,
      direction: 'CREDIT',
    });
  });

  it('rejects 5-line account-transfer layout (lets account-transfer claim it)', () => {
    // The existing 6-fixture sample 1 must still resolve to the 5-line
    // parser; the 4-line parser must NOT claim it.
    const raw = [
      'انتقال اینترنت',
      'حساب:310057795083',
      'مبلغ:5,500,000+',
      'مانده:82,791,067',
      '05/14-11:30',
    ].join('\n');
    const r = parseSms(n(raw));
    expect(r.parserId).toBe('account-transfer-signed-v1');
  });

  it('emits ACCOUNT_NUMBER identifier for the حساب value', () => {
    const raw = [
      'انتقال اینترنت:+550,000',
      'حساب:310057795083',
      'مانده:83,341,067',
      '0515-10:06',
    ].join('\n');
    const r = parseSms(n(raw));
    const ids = r.evidence.detectedIdentifiers as Array<{
      type: string;
      normalizedValue: string;
      parserId: string;
    }>;
    expect(ids).toHaveLength(1);
    expect(ids[0]!.type).toBe('ACCOUNT_NUMBER');
    expect(ids[0]!.normalizedValue).toBe('310057795083');
    expect(ids[0]!.parserId).toBe('internet-transfer-signed-v1');
  });
});

// ---------------------------------------------------------------------------
// Format 2 — Melli variant (MMDD-HH:mm date, leading-zero account hint)
// ---------------------------------------------------------------------------

describe('Melli parser — Format 2 variant (MMDD-HH:mm, leading-zero account)', () => {
  it('parses the spec fixture (1,950,000 CREDIT, account 06006)', () => {
    const raw = [
      'بانك ملي',
      'انتقال:1,950,000+',
      'حساب:06006',
      'مانده:9,379,136',
      '0515-20:46',
    ].join('\n');
    expectBankTx(parseSms(n(raw)), {
      parserId: 'melli-transfer-v1',
      bank: 'MELLI',
      accountHint: '06006',
      amountIrr: 1_950_000,
      balanceIrr: 9_379_136,
      direction: 'CREDIT',
      directionSource: 'signed_amount',
      minConfidence: 0.95,
    });
  });

  it('parses trailing-minus variant (DEBIT)', () => {
    const raw = [
      'بانك ملي',
      'انتقال:1,950,000-',
      'حساب:06006',
      'مانده:9,379,136',
      '0515-20:46',
    ].join('\n');
    expectBankTx(parseSms(n(raw)), {
      parserId: 'melli-transfer-v1',
      bank: 'MELLI',
      accountHint: '06006',
      amountIrr: 1_950_000,
      balanceIrr: 9_379_136,
      direction: 'DEBIT',
    });
  });

  it('still parses the original MM/DD-HH:mm layout (regression)', () => {
    const raw = [
      'بانك ملي',
      'انتقال:+1,500,000',
      'حساب:17000',
      'مانده:78,159,809',
      '05/14-16:30',
    ].join('\n');
    expectBankTx(parseSms(n(raw)), {
      parserId: 'melli-transfer-v1',
      bank: 'MELLI',
      accountHint: '17000',
      amountIrr: 1_500_000,
      balanceIrr: 78_159_809,
      direction: 'CREDIT',
    });
  });

  it('preserves leading zero in the ACCOUNT_HINT identifier (06006 → 06006)', () => {
    const raw = [
      'بانك ملي',
      'انتقال:1,950,000+',
      'حساب:06006',
      'مانده:9,379,136',
      '0515-20:46',
    ].join('\n');
    const r = parseSms(n(raw));
    expect(r.accountHint).toBe('06006');
    const ids = r.evidence.detectedIdentifiers as Array<{
      type: string;
      normalizedValue: string;
      maskedValue: string;
    }>;
    expect(ids).toHaveLength(1);
    expect(ids[0]!.type).toBe('ACCOUNT_HINT');
    // Leading zero MUST be preserved per the user spec.
    expect(ids[0]!.normalizedValue).toBe('06006');
    // Mask: canonical maskIdentifier reveals the trailing 4 digits, so
    // the display form masks the leading 0 (acceptable — the canonical
    // normalized value still has it for matching).
    expect(ids[0]!.maskedValue).toBe('*6006');
  });

  it('accepts header variant "بانك ملي ایران"', () => {
    const raw = [
      'بانك ملي ایران',
      'انتقال:1,950,000+',
      'حساب:06006',
      'مانده:9,379,136',
      '0515-20:46',
    ].join('\n');
    expectBankTx(parseSms(n(raw)), {
      parserId: 'melli-transfer-v1',
      bank: 'MELLI',
      accountHint: '06006',
      amountIrr: 1_950_000,
      balanceIrr: 9_379_136,
      direction: 'CREDIT',
    });
  });

  it('accepts Persian digits in amount + balance + date', () => {
    const raw = [
      'بانك ملي',
      'انتقال:۱٬۹۵۰٬۰۰۰+',
      'حساب:۰۶۰۰۶',
      'مانده:۹٬۳۷۹٬۱۳۶',
      '۰۵۱۵-۲۰:۴۶',
    ].join('\n');
    expectBankTx(parseSms(n(raw)), {
      parserId: 'melli-transfer-v1',
      bank: 'MELLI',
      accountHint: '06006',
      amountIrr: 1_950_000,
      balanceIrr: 9_379_136,
      direction: 'CREDIT',
    });
  });

  it('emits ACCOUNT_HINT identifier with leading zero intact', () => {
    const raw = [
      'بانك ملي',
      'انتقال:1,950,000+',
      'حساب:06006',
      'مانده:9,379,136',
      '0515-20:46',
    ].join('\n');
    const r = parseSms(n(raw));
    const ids = r.evidence.detectedIdentifiers as Array<{ type: string; normalizedValue: string }>;
    expect(ids).toHaveLength(1);
    expect(ids[0]!.type).toBe('ACCOUNT_HINT');
    expect(ids[0]!.normalizedValue).toBe('06006');
  });
});

// ---------------------------------------------------------------------------
// Format 3 — Saman deposit
// ---------------------------------------------------------------------------

describe('Saman parser — Format 3 (deposit with separate date+time lines)', () => {
  it('parses the spec fixture (1,000,000 CREDIT, account 901-777-2938283-1)', () => {
    const raw = [
      'بانك سامان',
      'واريز مبلغ  1,000,000ریال',
      'به  901-777-2938283-1',
      'مانده 12,814,704',
      '1405/5/15',
      '20:48',
    ].join('\n');
    expectBankTx(parseSms(n(raw)), {
      parserId: 'saman-credit-v1',
      bank: 'SAMAN',
      accountHint: '901-777-2938283-1',
      amountIrr: 1_000_000,
      balanceIrr: 12_814_704,
      direction: 'CREDIT',
      directionSource: 'explicit_credit_phrase',
      minConfidence: 0.99,
    });
  });

  it('preserves hyphens in the account identifier (round-trip)', () => {
    const raw = [
      'بانك سامان',
      'واريز مبلغ  1,000,000ریال',
      'به  901-777-2938283-1',
      'مانده 12,814,704',
      '1405/5/15',
      '20:48',
    ].join('\n');
    const r = parseSms(n(raw));
    expect(r.accountHint).toBe('901-777-2938283-1');
    const ids = r.evidence.detectedIdentifiers as Array<{
      type: string;
      normalizedValue: string;
      parserId: string;
    }>;
    expect(ids).toHaveLength(1);
    expect(ids[0]!.type).toBe('ACCOUNT_NUMBER');
    expect(ids[0]!.normalizedValue).toBe('901-777-2938283-1');
    expect(ids[0]!.parserId).toBe('saman-credit-v1');
  });

  it('accepts Persian-letter variants (بانک / واریز / ریال)', () => {
    const raw = [
      'بانک سامان',
      'واریز مبلغ ۱٬۰۰۰٬۰۰۰ ریال',
      'به ۹۰۱-۷۷۷-۲۹۳۸۲۸۳-۱',
      'مانده ۱۲٬۸۱۴٬۷۰۴',
      '۱۴۰۵/۵/۱۵',
      '۲۰:۴۸',
    ].join('\n');
    expectBankTx(parseSms(n(raw)), {
      parserId: 'saman-credit-v1',
      bank: 'SAMAN',
      accountHint: '901-777-2938283-1',
      amountIrr: 1_000_000,
      balanceIrr: 12_814_704,
      direction: 'CREDIT',
    });
  });

  it('tolerates CRLF line endings', () => {
    const raw = [
      'بانك سامان',
      'واريز مبلغ  1,000,000ریال',
      'به  901-777-2938283-1',
      'مانده 12,814,704',
      '1405/5/15',
      '20:48',
    ].join('\r\n');
    expectBankTx(parseSms(n(raw)), {
      parserId: 'saman-credit-v1',
      bank: 'SAMAN',
      accountHint: '901-777-2938283-1',
      amountIrr: 1_000_000,
      balanceIrr: 12_814_704,
      direction: 'CREDIT',
    });
  });

  it('rejects a body missing the time line', () => {
    const raw = [
      'بانك سامان',
      'واريز مبلغ  1,000,000ریال',
      'به  901-777-2938283-1',
      'مانده 12,814,704',
      '1405/5/15',
    ].join('\n');
    const r = parseSms(n(raw));
    expect(r.parserId).not.toBe('saman-credit-v1');
  });

  it('rejects non-Saman bank header', () => {
    const raw = ['بانك ملي', 'انتقال:1,950,000+', 'حساب:06006', 'مانده:9,379,136', '0515-20:46'].join(
      '\n',
    );
    const r = parseSms(n(raw));
    expect(r.parserId).not.toBe('saman-credit-v1');
  });
});

// ---------------------------------------------------------------------------
// Format 4 — Compact credit notification (existing compact-signed-v1)
// ---------------------------------------------------------------------------

describe('Compact parser — Format 4 (1,000,000+ CREDIT)', () => {
  it('parses the spec fixture', () => {
    const raw = ['300422286226', '1,000,000+', '1405/5/15-12:06', 'مانده:720,919,100'].join('\n');
    expectBankTx(parseSms(n(raw)), {
      parserId: 'compact-signed-v1',
      bank: 'UNKNOWN',
      accountHint: '300422286226',
      amountIrr: 1_000_000,
      balanceIrr: 720_919_100,
      direction: 'CREDIT',
      directionSource: 'signed_amount',
    });
  });

  it('parses the Persian-digit equivalent', () => {
    const raw = ['۳۰۰۴۲۲۲۸۶۲۲۶', '۱٬۰۰۰٬۰۰۰+', '۱۴۰۵/۵/۱۵-۱۲:۰۶', 'مانده:۷۲۰٬۹۱۹٬۱۰۰'].join(
      '\n',
    );
    expectBankTx(parseSms(n(raw)), {
      parserId: 'compact-signed-v1',
      bank: 'UNKNOWN',
      accountHint: '300422286226',
      amountIrr: 1_000_000,
      balanceIrr: 720_919_100,
      direction: 'CREDIT',
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: precedence + identifier emission
// ---------------------------------------------------------------------------

describe('Parser precedence + identifier emission (all 4 formats)', () => {
  it('Internet transfer wins over compact for the 4-line layout', () => {
    const raw = [
      'انتقال اینترنت:+550,000',
      'حساب:310057795083',
      'مانده:83,341,067',
      '0515-10:06',
    ].join('\n');
    const r = parseSms(n(raw));
    expect(r.parserId).toBe('internet-transfer-signed-v1');
  });

  it('Saman wins over credit for واريز-with-amount', () => {
    const raw = [
      'بانك سامان',
      'واريز مبلغ  1,000,000ریال',
      'به  901-777-2938283-1',
      'مانده 12,814,704',
      '1405/5/15',
      '20:48',
    ].join('\n');
    const r = parseSms(n(raw));
    expect(r.parserId).toBe('saman-credit-v1');
  });

  it('Melli (variant) keeps MELLI bank_id even with leading-zero account', () => {
    const raw = [
      'بانك ملي',
      'انتقال:1,950,000+',
      'حساب:06006',
      'مانده:9,379,136',
      '0515-20:46',
    ].join('\n');
    const r = parseSms(n(raw));
    expect(r.evidence.bank).toBe('MELLI');
  });
});