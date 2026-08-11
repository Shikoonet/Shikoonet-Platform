import { describe, expect, it } from 'vitest';
import { parseSms } from '../src/index.js';
import type { NormalizedSms } from '@shikoo/contracts';

function n(raw: string, sender = 'BANK'): NormalizedSms {
  return { raw, text: raw, sender, timestamp: 1700000000000, deviceId: 'phone-01' };
}

describe('parseSms', () => {
  it('classifies OTP and never exposes an amount', () => {
    const r = parseSms(n('کد تایید: 123456', 'FRIEND'));
    expect(r.classification).toBe('OTP');
    expect(r.amountIrr).toBeNull();
    expect(r.balanceIrr).toBeNull();
  });

  it('classifies promotional', () => {
    const r = parseSms(n('تبلیغ: 50٪ تخفیف فقط امروز'));
    expect(r.classification).toBe('PROMOTIONAL');
  });

  it('parses credit in ریال with balance', () => {
    const r = parseSms(n('واریز 50,000 ریال - مانده 250,000 ریال'));
    expect(r.classification).toBe('BANK_CREDIT');
    expect(r.direction).toBe('CREDIT');
    expect(r.amountIrr).toBe(50_000);
    expect(r.balanceIrr).toBe(250_000);
    expect(r.confidence).toBeGreaterThan(0.6);
  });

  it('parses credit in تومان (×10) when standalone', () => {
    const r = parseSms(n('واریز 100 تومان به حساب'));
    expect(r.classification).toBe('BANK_CREDIT');
    expect(r.amountIrr).toBe(1000);
  });

  it('parses debit', () => {
    const r = parseSms(n('برداشت 20,000 ریال - مانده 30,000 ریال'));
    expect(r.classification).toBe('BANK_DEBIT');
    expect(r.direction).toBe('DEBIT');
    expect(r.amountIrr).toBe(20_000);
  });

  it('parses balance', () => {
    const r = parseSms(n('مانده حساب 50,000 ریال'));
    expect(r.classification).toBe('BALANCE');
    expect(r.balanceIrr).toBe(50_000);
    expect(r.amountIrr).toBeNull();
  });

  it('returns UNKNOWN on garbage', () => {
    const r = parseSms(n('xyzzy foobar'));
    expect(r.classification).toBe('UNKNOWN');
    expect(r.matched).toBe(false);
  });

  it('flags AMBIGUOUS_CURRENCY when both toman and rial appear', () => {
    const r = parseSms(n('واریز 100 تومان معادل 1000 ریال'));
    expect(r.warnings).toContain('AMBIGUOUS_CURRENCY');
    expect(r.amountIrr).toBeNull();
  });

  it('extracts account hint from card tail', () => {
    const r = parseSms(n('واریز 10,000 ریال به کارت *1234'));
    expect(r.accountHint).toBe('1234');
  });

  it('extracts transaction reference', () => {
    const r = parseSms(n('واریز 10,000 ریال شماره تراکنش 99887766'));
    expect(r.transactionReference).toBe('99887766');
  });

  it('OTP wins over credit if both keywords appear', () => {
    const r = parseSms(n('کد تایید 123456 - واریز 50,000 ریال'));
    expect(r.classification).toBe('OTP');
  });
});
