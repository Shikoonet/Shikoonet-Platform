/**
 * The withdrawal shapes production received in the fortnight to 2026-09-19
 * and made no row of — each fell past its bank's parser to a generic one.
 * Bodies are the banks' own, digits changed. Timestamps are Tehran-night
 * instants near the bank's own clock so no parser falls back.
 */
import { describe, expect, it } from 'vitest';
import { parseSms } from '../src/parsers/registry.js';
import type { NormalizedSms } from '@shikoo/contracts';

const AT = Date.UTC(2026, 8, 17, 13, 30, 0); // 1405/06/26 17:00 Tehran
const n = (text: string, sender: string): NormalizedSms => ({ raw: text, text, sender, timestamp: AT, deviceId: 'd' });

describe('withdrawals the named parsers now read', () => {
  it('Melli — a bill («قبض») is a DEBIT on the account, with the balance', () => {
    const r = parseSms(n('بانک ملی ایران\nقبض:107,000,000-\nحساب:06006\nمانده:26,481,206\n0626-17:16', '+98700717'));
    expect(r.parserId).toBe('melli-transfer-v1');
    expect(r.direction).toBe('DEBIT');
    expect(r.amountIrr).toBe(107_000_000);
    expect(r.balanceIrr).toBe(26_481_206);
    expect(r.accountHint).toBe('06006');
    expect(r.evidence['label']).toBe('قبض');
  });

  it('Melli — an internet purchase («خریداینترنتی») the same way', () => {
    const r = parseSms(n('بانک ملی ایران\nخریداینترنتی:39,900,000-\nحساب:24000\nمانده:12,140\n0626-17:59', '+989830009417'));
    expect(r.parserId).toBe('melli-transfer-v1');
    expect(r.direction).toBe('DEBIT');
    expect(r.amountIrr).toBe(39_900_000);
    expect(r.balanceIrr).toBe(12_140);
  });

  it('Melli — a deposit still reads as before', () => {
    const r = parseSms(n('بانک ملی ایران\nانتقال:2,000,000+\nحساب:24000\nمانده:18,893,140\n0626-17:24', '+98700717'));
    expect(r.parserId).toBe('melli-transfer-v1');
    expect(r.direction).toBe('CREDIT');
    expect(r.balanceIrr).toBe(18_893_140);
  });

  it('Maskan — «انتقال: -…» and «قبض: -…» are DEBITs, not a bare balance', () => {
    const a = parseSms(n('انتقال: -114,750,000 \nحساب:310057795083\nمانده:146,107\n0626-17:38', 'Bank Maskan'));
    expect(a.parserId).toBe('internet-transfer-signed-v1');
    expect(a.direction).toBe('DEBIT');
    expect(a.amountIrr).toBe(114_750_000);
    expect(a.balanceIrr).toBe(146_107);
    expect(a.accountHint).toBe('310057795083');
    const b = parseSms(n('قبض: -107,000,000 \nحساب:150028182866\nمانده:169,524\n0626-17:54', 'Bank Maskan'));
    expect(b.parserId).toBe('internet-transfer-signed-v1');
    expect(b.direction).toBe('DEBIT');
    expect(b.balanceIrr).toBe(169_524);
  });

  it('Saman — «برداشت مبلغ … خریدکالا» from «از …», with seconds on the clock', () => {
    const r = parseSms(n('بانک سامان\nبرداشت مبلغ 71,881,247 خریدکالا\nاز 901-777-2938283-1 \nمانده 0\n1405/6/26\n17:01:07', '+989999920000'));
    expect(r.parserId).toBe('saman-credit-v1');
    expect(r.direction).toBe('DEBIT');
    expect(r.amountIrr).toBe(71_881_247);
    expect(r.balanceIrr).toBe(0);
    expect(r.accountHint).toBe('901-777-2938283-1');
  });

  it('Mellat — «برداشت<N>» is the deposit body with the other word', () => {
    const r = parseSms(n('حساب4436995648\nبرداشت88,000,000\nمانده306,323\n05/06/26-17:29', 'Bank Mellat'));
    expect(r.parserId).toBe('mellat-credit-v1');
    expect(r.direction).toBe('DEBIT');
    expect(r.amountIrr).toBe(88_000_000);
    expect(r.balanceIrr).toBe(306_323);
    expect(r.accountHint).toBe('4436995648');
  });
});

describe('the generic parsers no longer guess a balance', () => {
  it('a body whose last number is a card, with no «مانده» label, yields no balance', () => {
    // The Keshavarzi shape as an unknown bank would send it: no bki.ir, no sender we know.
    const r = parseSms(n('واریز1,000,000\nموجودي شما\n050627-21:30\nکارت4006*', 'SOMEBANK'));
    expect(r.parserId).toBe('generic-credit');
    expect(r.amountIrr).toBe(1_000_000);
    expect(r.balanceIrr).toBeNull();
  });

  it('and reads the balance when the text labels it', () => {
    const r = parseSms(n('واریز 1,000,000 ریال\nمانده 12,054,098 ریال\nکارت4006*', 'SOMEBANK'));
    expect(r.parserId).toBe('generic-credit');
    expect(r.balanceIrr).toBe(12_054_098);
  });

  it('a bare balance notice without a label is BALANCE with no number, and says so', () => {
    const r = parseSms(n('موجودی حساب شما\n4006', 'SOMEBANK'));
    expect(r.parserId).toBe('generic-balance');
    expect(r.balanceIrr).toBeNull();
    expect(r.warnings).toContain('BALANCE_UNLABELLED_IGNORED');
  });
});
