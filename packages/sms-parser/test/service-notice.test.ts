/**
 * A bank's notice about its own SMS service is not a transaction and not an
 * advert — it is the bank saying the feed this product lives on is about to
 * stop. Melli, 2026-09-21 16:36 (+987007170): «۸۰٫۰ درصد از حجم بسته پیامکی
 * "شارژ ۳۰۰ پیامکی" … با اتمام بسته فعلی سیستم ارسال پیامکی شما غیرفعال خواهد
 * شد». It fell to `fallback-unknown` and sat under «ناخوانده» on the coverage
 * page, and nothing told anyone the Melli deposits were about to go dark.
 */
import { describe, expect, it } from 'vitest';
import { parseSms } from '../src/index.js';
import type { NormalizedSms } from '@shikoo/contracts';

const n = (raw: string, sender = '+987007170'): NormalizedSms => ({
  raw,
  text: raw,
  sender,
  timestamp: 1700000000000,
  deviceId: 'phone-01',
});

// The real shape, digits changed.
const MELLI_QUOTA =
  'بانک ملی ایران\n' +
  'مشتری گرامی سرویس پیام کوتاه شماره حساب 0123456789012 شما تا تاریخ 1405/06/30 16:36:15 به میزان 80.0 درصد از حجم بسته پیامکی "شارژ 300 پیامکی" خود را استفاده کرده اید.\n' +
  'شما دارای بسته رزرو نیستید و گزینه شارژ اتوماتیک را نیز انتخاب نکرده اید و با اتمام بسته فعلی سیستم ارسال پیامکی شما غیرفعال خواهد شد';

describe('a bank service notice', () => {
  it('is recognised by name, makes no row, and carries how much of the quota is gone', () => {
    const r = parseSms(n(MELLI_QUOTA));
    expect(r.parserId).toBe('bank-service-notice');
    expect(r.classification).toBe('IGNORED');
    expect(r.matched).toBe(false);
    expect(r.amountIrr).toBeNull();
    expect(r.balanceIrr).toBeNull();
    expect(r.evidence).toMatchObject({ bank: 'MELLI', percentUsed: 80, package: 'شارژ 300 پیامکی' });
    // The account number is in the body and stays there; it is not evidence.
    expect(JSON.stringify(r.evidence)).not.toContain('0123456789012');
  });

  it('is not fooled by a deposit that merely mentions a package', () => {
    const r = parseSms(n('واریز 50,000 ریال بابت بسته پیامکی - مانده 250,000 ریال'));
    expect(r.parserId).not.toBe('bank-service-notice');
    expect(r.amountIrr).toBe(50_000);
  });
});
