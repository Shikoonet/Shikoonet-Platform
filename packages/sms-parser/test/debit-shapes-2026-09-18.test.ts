/**
 * The withdrawal SMS the shop actually receives — and was throwing away.
 *
 * Read off production on 2026-09-18, digits replaced: in the two days since
 * the phones were pointed at this system, eleven withdrawal messages arrived
 * and nine of them left as UNKNOWN. Shahr and Gardeshgari have a named credit
 * parser that claims the whole bank and then only knows «واریز به»; a body
 * that says «برداشت از» fails its required-field check, and because a named
 * parser's answer is final, the generic debit parser two lines down never
 * sees it. So «برداشت بی‌توضیح» on «دفتر بانک» read ۰ while balances fell.
 *
 * The other two are not withdrawals at all: a transfer REQUEST carrying the
 * confirmation code («رمز 123456», «رمز زیر را وارد نمایید: 12345»). Those
 * must classify as OTP, and even where they do not, the code must not reach
 * `normalized_body` — three real ones did.
 */
import { describe, expect, it } from 'vitest';
import type { NormalizedSms } from '@shikoo/contracts';
import { parseSms } from '../src/parsers/registry.js';
import { redactOtp, isAuthenticationOtp } from '../src/parsers/otp.js';

const n = (text: string): NormalizedSms => ({
  raw: text,
  text,
  timestamp: Date.UTC(2026, 8, 17, 9, 0, 0),
  sender: 'BANK',
  deviceId: 'phone-a',
});

describe('Shahr — a withdrawal is read, not dropped', () => {
  it('خرید با کارت / برداشت از', () => {
    const raw = [
      '*بانک شهر*',
      'خرید با کارت',
      'برداشت از:7001018246497',
      'مبلغ:12,500,000ریال',
      'موجودی:713,275 ریال',
      '1405/06/27 14:08:31',
    ].join('\n');
    const r = parseSms(n(raw));
    expect(r.parserId).toBe('shahr-credit-v1');
    expect(r.classification).toBe('BANK_TRANSACTION');
    expect(r.direction).toBe('DEBIT');
    expect(r.amountIrr).toBe(12_500_000);
    expect(r.balanceIrr).toBe(713_275);
    expect(r.accountHint).toBe('7001018246497');
  });

  it('انتقال وجه کارتی / برداشت از — the outgoing twin of the credit fixture', () => {
    const raw = [
      '*بانک شهر*',
      'انتقال وجه کارتی',
      'برداشت از:9001017429938',
      'مبلغ:2,000,000ریال',
      'موجودی:311,421,885 ریال',
      '1405/06/26 22:05:10',
    ].join('\n');
    const r = parseSms(n(raw));
    expect(r.direction).toBe('DEBIT');
    expect(r.amountIrr).toBe(2_000_000);
    expect(r.balanceIrr).toBe(311_421_885);
    expect(r.accountHint).toBe('9001017429938');
  });
});

describe('Gardeshgari — a withdrawal is read, not dropped', () => {
  it('کارت / برداشت از', () => {
    const raw = [
      '*بانک گردشگری*',
      'کارت',
      'برداشت از: 110.9992.2377306.1',
      'مبلغ: 35,000,000 ریال',
      '06/27/05_11:42',
      'موجودی: 0 ریال',
    ].join('\n');
    const r = parseSms(n(raw));
    expect(r.parserId).toBe('gardeshgari-credit-v1');
    expect(r.classification).toBe('BANK_TRANSACTION');
    expect(r.direction).toBe('DEBIT');
    expect(r.amountIrr).toBe(35_000_000);
    expect(r.balanceIrr).toBe(0);
    expect(r.accountHint).toBe('110.9992.2377306.1');
  });

  it('درگاه مجازی / برداشت از', () => {
    const raw = [
      '*بانک گردشگری*',
      'درگاه مجازی',
      'برداشت از: 110.7007.2377306.1',
      'مبلغ: 1,250,000 ریال',
      '06/27/05_09:15',
      'موجودی: 8 ریال',
    ].join('\n');
    const r = parseSms(n(raw));
    expect(r.direction).toBe('DEBIT');
    expect(r.amountIrr).toBe(1_250_000);
    expect(r.balanceIrr).toBe(8);
  });
});

describe('a transfer request carrying its confirmation code is an OTP, never a movement', () => {
  const mehr = ['انتقال وجه آنی', 'از: 300432401476', 'به: IR120540000000300432401476', 'مبلغ 25,000,000 ریال', 'رمز 482913'].join(
    '\n',
  );
  const resalat = [
    'بانک قرض الحسنه رسالت',
    'درخواست انتقال وجه',
    'از شماره شبا/سپرده: 10.14438208.1',
    'به: پویان بهمن',
    'شماره شبا/سپرده: 10.1443012.1',
    'مبلغ: 12,000,000 ریال',
    'درصورت تایید, رمز زیر را وارد نمایید: 73921',
    'از در اختیار قراردادن محتویات این پیامک به دیگران جداً خودداری نمائید',
  ].join('\n');

  it('classifies both as OTP and exposes nothing', () => {
    for (const body of [mehr, resalat]) {
      expect(isAuthenticationOtp(body)).toBe(true);
      const r = parseSms(n(body));
      expect(r.classification).toBe('OTP');
      expect(r.amountIrr).toBeNull();
    }
  });

  it('the scrubber removes the code even when classification is bypassed', () => {
    for (const body of [mehr, resalat]) {
      const out = redactOtp(body);
      expect(out.redacted).toBeGreaterThan(0);
      expect(out.text).not.toMatch(/482913|73921/);
    }
  });

  it('a real withdrawal is still not an OTP', () => {
    const body = ['*بانک شهر*', 'خرید با کارت', 'برداشت از:7001018246497', 'مبلغ:12,500,000ریال', 'موجودی:713,275 ریال'].join('\n');
    expect(isAuthenticationOtp(body)).toBe(false);
    expect(redactOtp(body).redacted).toBe(0);
  });
});
