/**
 * Two shapes production read wrong on 2026-09-24, and the guess that made it
 * worse. Both fell past their named parser to `generic-debit`, which took
 * «the last four-digit number» as the account — the year, 1405 — so an
 * account called «1405» was minted and three withdrawals of three of our
 * accounts landed on it: a 20,000,000 IRR Saman transfer and two Resalat SMS
 * fees, the fees read as 10 IRR (the «10» of the account number).
 *
 * The balance chain on production named each owner exactly. Bodies are the
 * banks' own with the digits changed.
 */
import { describe, expect, it } from 'vitest';
import { parseSms } from '../src/parsers/registry.js';
import type { NormalizedSms } from '@shikoo/contracts';

const AT = Date.UTC(2026, 8, 24, 9, 0, 0); // 1405/07/02 12:30 Tehran
const n = (text: string, sender: string): NormalizedSms => ({ raw: text, text, sender, timestamp: AT, deviceId: 'd' });

describe('shapes of 2026-09-24', () => {
  it('Saman — a two-word reason («انتقال وجه») is still a withdrawal of that account', () => {
    const r = parseSms(
      n('بانک سامان\nبرداشت مبلغ 20,000,000 انتقال وجه\nاز 901-777-1234567-1\nمانده 61,645,420\n1405/7/2\n09:33:26', '+989999920000'),
    );
    expect(r.parserId).toBe('saman-credit-v1');
    expect(r.direction).toBe('DEBIT');
    expect(r.amountIrr).toBe(20_000_000);
    expect(r.balanceIrr).toBe(61_645_420);
    expect(r.accountHint).toBe('901-777-1234567-1');
  });

  it('Resalat — the monthly SMS fee, with its fifth line of words, is 39,000 out of that account', () => {
    const r = parseSms(n('10.1234567.1\n-39,000\n07/02_12:12\nمانده: 9,308,000\nکارمزد پیامک تیر ماه 1405', 'ResalatBank'));
    expect(r.parserId).toBe('compact-signed-v1');
    expect(r.direction).toBe('DEBIT');
    expect(r.amountIrr).toBe(39_000);
    expect(r.balanceIrr).toBe(9_308_000);
    expect(r.accountHint).toBe('10.1234567.1');
  });

  it('a fifth line that opens on a number is not a remark — the compact layout still refuses it', () => {
    const r = parseSms(n('10.1234567.1\n-39,000\n07/02_12:12\nمانده: 9,308,000\n1405', 'ResalatBank'));
    expect(r.parserId).not.toBe('compact-signed-v1');
  });

  it('a generic parser names no account from a year — only from a card the text names', () => {
    const debit = parseSms(n('برداشت 500,000 ریال\n1405/7/2 10:00', 'SOMEBANK'));
    expect(debit.parserId).toBe('generic-debit');
    expect(debit.accountHint).toBeNull();
    const credit = parseSms(n('واریز 500,000 ریال\n1405/7/2 10:00', 'SOMEBANK'));
    expect(credit.parserId).toBe('generic-credit');
    expect(credit.accountHint).toBeNull();
    const card = parseSms(n('برداشت 500,000 ریال از کارت ****1234\n1405/7/2 10:00', 'SOMEBANK'));
    expect(card.accountHint).toBe('1234');
  });
});
