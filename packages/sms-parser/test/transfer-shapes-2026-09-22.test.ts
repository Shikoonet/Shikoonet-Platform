/**
 * Three shapes production received on 2026-09-22 and made no row of — each
 * fell past its bank's parser to `generic-balance`, which reads a balance and
 * records no movement. Between them: 96,000,000 IRR out on «پایا», two
 * 461,200 fees out on «انتقالی», and 2,500,000 IRR IN on «انتقال خودپرداز»
 * that no claim could ever be matched to.
 *
 * The same class of gap as the قبض/خرید one of 2026-09-19: the layout was
 * already known, only the word in front of the amount was new. Bodies are the
 * banks' own with the digits changed.
 */
import { describe, expect, it } from 'vitest';
import { parseSms } from '../src/parsers/registry.js';
import type { NormalizedSms } from '@shikoo/contracts';

const AT = Date.UTC(2026, 8, 22, 7, 45, 0); // 1405/06/31 11:15 Tehran
const n = (text: string, sender: string): NormalizedSms => ({ raw: text, text, sender, timestamp: AT, deviceId: 'd' });

describe('transfer words the named parsers now read', () => {
  it('Melli — «پایا», the interbank rail, is a DEBIT with its balance', () => {
    const r = parseSms(n('بانک ملی ایران\nپایا:96,000,000-\nحساب:06006\nمانده:270,506\n0631-11:19', '+98700717'));
    expect(r.parserId).toBe('melli-transfer-v1');
    expect(r.direction).toBe('DEBIT');
    expect(r.amountIrr).toBe(96_000_000);
    expect(r.balanceIrr).toBe(270_506);
    expect(r.accountHint).toBe('06006');
    expect(r.evidence['label']).toBe('پایا');
  });

  it('Melli — «ساتنا», the rail beside it, reads the same way', () => {
    const r = parseSms(n('بانک ملی ایران\nساتنا:50,000,000-\nحساب:06006\nمانده:1,270,506\n0631-11:20', '+98700717'));
    expect(r.parserId).toBe('melli-transfer-v1');
    expect(r.direction).toBe('DEBIT');
    expect(r.amountIrr).toBe(50_000_000);
  });

  it('Melli — «انتقالی» is the bank’s own word for the same movement', () => {
    const r = parseSms(n('بانک ملی ایران\nانتقالی:461,200-\nحساب:06006\nمانده:96,270,506\n0631-11:16', '+98700717'));
    expect(r.parserId).toBe('melli-transfer-v1');
    expect(r.direction).toBe('DEBIT');
    expect(r.amountIrr).toBe(461_200);
    expect(r.balanceIrr).toBe(96_270_506);
    expect(r.evidence['label']).toBe('انتقالی');
  });

  it('«انتقال خودپرداز» is money IN at an ATM, not a bare balance', () => {
    const r = parseSms(n('انتقال خودپرداز: +2,500,000 \nحساب:310057795083\nمانده:53,900,024\n0631-11:18', 'Bank Maskan'));
    expect(r.parserId).toBe('internet-transfer-signed-v1');
    expect(r.direction).toBe('CREDIT');
    expect(r.amountIrr).toBe(2_500_000);
    expect(r.balanceIrr).toBe(53_900_024);
    expect(r.accountHint).toBe('310057795083');
  });

  it('a balance-only text is still a balance, and still makes no row', () => {
    const r = parseSms(n('بانک ملی ایران\nمانده:12,345,678\n0631-11:21', '+98700717'));
    expect(r.parserId).toBe('generic-balance');
    expect(r.amountIrr).toBeNull();
  });
});
