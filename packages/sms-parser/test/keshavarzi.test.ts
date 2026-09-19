/**
 * Keshavarzi: the shapes production received on 2026-09-18/19. Until this
 * parser existed, `generic-credit` read the card's «4006» as the balance.
 */
import { describe, expect, it } from 'vitest';
import { parseSms } from '../src/parsers/registry.js';
import type { NormalizedSms } from '@shikoo/contracts';

// 1405/06/27 21:30 Tehran.
const AT = Date.UTC(2026, 8, 18, 18, 0, 0);
const n = (text: string, sender = 'KESHAVARZI'): NormalizedSms => ({ raw: text, text, sender, timestamp: AT, deviceId: 'd' });

describe('keshavarzi-v1', () => {
  it('reads the deposit, the balance, the card and the bank clock — not the card as the balance', () => {
    const r = parseSms(n('واریز1,000,000\nمانده12,054,098\n050627-21:30\nکارت4006*\nbki. ir'));
    expect(r.parserId).toBe('keshavarzi-v1');
    expect(r.classification).toBe('BANK_TRANSACTION');
    expect(r.direction).toBe('CREDIT');
    expect(r.amountIrr).toBe(1_000_000);
    expect(r.balanceIrr).toBe(12_054_098);
    expect(r.accountHint).toBe('4006');
    expect(r.evidence['bankTimestamp']).toBe(Date.UTC(2026, 8, 18, 18, 0, 0));
    expect(r.warnings).toEqual([]);
  });

  it('a Pol transfer with a bare account number', () => {
    const r = parseSms(n('واریز پل5,500,000\nمانده8,354,098\n050627-13:04\n12345678\nbki. ir', '+989192030800'));
    expect(r.parserId).toBe('keshavarzi-v1');
    expect(r.amountIrr).toBe(5_500_000);
    expect(r.balanceIrr).toBe(8_354_098);
    expect(r.accountHint).toBe('12345678');
  });

  it('a withdrawal is a DEBIT with the same fields', () => {
    const r = parseSms(n('برداشت2,000,000\nمانده10,054,098\n050628-09:10\nکارت4006*\nbki. ir'));
    expect(r.parserId).toBe('keshavarzi-v1');
    expect(r.direction).toBe('DEBIT');
    expect(r.amountIrr).toBe(2_000_000);
    expect(r.balanceIrr).toBe(10_054_098);
  });

  it('leaves other banks alone', () => {
    const r = parseSms(n('واریز1,000,000\nمانده12,054,098\n050627-21:30\nکارت4006*', 'BANK'));
    expect(r.parserId).not.toBe('keshavarzi-v1');
  });
});
