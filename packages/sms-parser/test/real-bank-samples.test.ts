/**
 * Eight real bank messages, one per bank, supplied by the shop owner on
 * 2026-08-29 as screenshots from the phone that receives them.
 *
 * Six parsed correctly the day they arrived. The two that did not are the
 * reason this file exists, and they failed in opposite ways:
 *
 *   - Bank Shahr wrote a SINGLE-DIGIT day — `1405/06/7` rather than
 *     `1405/06/07` — and the parser's date pattern required two. The date
 *     gates the whole parse, so a real 3,990,000 IRR deposit produced UNKNOWN
 *     with no amount and no account. One character.
 *
 *   - Bank Mellat had no parser at all, so it fell to `generic-credit`, which
 *     takes the first number it finds. The first number in a Mellat message is
 *     the ACCOUNT, so a 1,000,000 IRR deposit was recorded as 4,436,995,648.
 *     A miss costs a payment; a wrong amount puts a number in the ledger that
 *     never happened, and it is the worse of the two.
 *
 * The bodies are transcribed from images, so the exact characters — Persian ی
 * against Arabic ي, ک against ك, where the spaces fall — are the transcriber's
 * reading rather than the bank's bytes. Every assertion here is about the
 * MONEY and the ACCOUNT, which survive that uncertainty; none of them pins a
 * layout detail that a re-transcription could change.
 */

import { describe, expect, it } from 'vitest';
import { parseSms } from '../src/index.js';
import { mellatCreditParser } from '../src/parsers/mellat.js';
import type { NormalizedSms } from '@shikoo/contracts';

const SMS_TIMESTAMP = Date.UTC(2026, 7, 29, 9, 0, 0);

function n(raw: string): NormalizedSms {
  return { raw, text: raw, sender: 'BANK', timestamp: SMS_TIMESTAMP, deviceId: 'phone-samples' };
}

interface Sample {
  bank: string;
  text: string;
  amountIrr: number;
  accountHint: string;
  balanceIrr: number;
}

const SAMPLES: Sample[] = [
  {
    bank: 'پارسیان',
    text: '30101883751600\nمبلغ:1,500,000+\nمانده:14,763,250\n06/07\n12:04',
    amountIrr: 1_500_000,
    accountHint: '30101883751600',
    balanceIrr: 14_763_250,
  },
  {
    bank: 'ملت',
    text: 'حساب4436995648\nواریز\n1,000,000\nمانده 56,773,273\n05/06/07-10:18',
    amountIrr: 1_000_000,
    accountHint: '4436995648',
    balanceIrr: 56_773_273,
  },
  {
    bank: 'سامان',
    text: 'بانک سامان\nواریز مبلغ 1,000,000ریال\nبه 901-777-2938283-1\nمانده 20,715,394\n1405/6/7\n10:12',
    amountIrr: 1_000_000,
    accountHint: '901-777-2938283-1',
    balanceIrr: 20_715_394,
  },
  {
    bank: 'شهر',
    text: '*بانک شهر*\nانتقال وجه کارتی\nواریز به:7001018382933\nمبلغ:3,990,000ریال\nموجودی:205,726,000ریال\n1405/06/7 12:45:57',
    amountIrr: 3_990_000,
    accountHint: '7001018382933',
    balanceIrr: 205_726_000,
  },
  {
    bank: 'گردشگری',
    text: '*بانک گردشگری*\nکارت\nواریز به: 110.9992.2382129.1\nمبلغ: 2,490,000 ریال\n05/06/07_12:13\nموجودی: 23,632,500 ریال',
    amountIrr: 2_490_000,
    accountHint: '110.9992.2382129.1',
    balanceIrr: 23_632_500,
  },
  {
    bank: 'رسالت',
    text: '10.9220133.1\n+7,500,000\n06/07_10:20\nمانده: 28,271,034',
    amountIrr: 7_500_000,
    accountHint: '10.9220133.1',
    balanceIrr: 28_271_034,
  },
  {
    bank: 'مسکن',
    text: 'انتقال اینترنت:+1,000,000\nحساب:150028182866\nمانده:115,967,064\n0607-07:43',
    amountIrr: 1_000_000,
    accountHint: '150028182866',
    balanceIrr: 115_967_064,
  },
  {
    bank: 'مهر',
    text: '300433163497\n1,000,000+\n1405/6/7-0:52\nمانده 104,185,100',
    amountIrr: 1_000_000,
    accountHint: '300433163497',
    balanceIrr: 104_185_100,
  },
];

describe('the eight banks the shop actually receives from', () => {
  for (const s of SAMPLES) {
    it(`${s.bank}: reads the deposit and the account it landed in`, () => {
      const r = parseSms(n(s.text));
      expect(r.direction).toBe('CREDIT');
      expect(r.amountIrr).toBe(s.amountIrr);
      expect(r.accountHint).toBe(s.accountHint);
      expect(r.balanceIrr).toBe(s.balanceIrr);
    });
  }
});

describe('the two that were wrong, stated as the defect rather than the fixture', () => {
  it('Shahr writes a single-digit day, and that must not silence the parse', () => {
    // The two bodies differ by ONE character. Before the fix the first produced
    // no amount at all while the second parsed perfectly, which is why this is
    // written as a pair rather than as one more fixture.
    const singleDigitDay =
      '*بانک شهر*\nانتقال وجه کارتی\nواریز به:7001018382933\nمبلغ:3,990,000ریال\nموجودی:205,726,000ریال\n1405/06/7 12:45:57';
    const twoDigitDay = singleDigitDay.replace('1405/06/7 ', '1405/06/07 ');

    const a = parseSms(n(singleDigitDay));
    const b = parseSms(n(twoDigitDay));
    expect(a.amountIrr).toBe(b.amountIrr);
    expect(a.accountHint).toBe(b.accountHint);
    expect(a.parserId).toBe('shahr-credit-v1');
    // And the date was UNDERSTOOD, not merely survived. Without this the test
    // passes on the fallback below and says nothing about the date pattern:
    // widening `\d{2}` to `\d{1,2}` could be reverted with every assertion
    // above still green.
    expect(a.warnings).not.toContain('BANK_TIME_FALLBACK_TO_SMS_TIMESTAMP');
  });

  it('a date shape nobody has seen costs a warning, not the payment', () => {
    // The other half, and the one that matters more: the amount and the account
    // are read BEFORE the date, so a date this parser cannot make sense of must
    // never discard them. It used to — `return unsupportedWarn(...)` — which is
    // how one missing zero threw away a real 3,990,000 IRR deposit.
    const r = parseSms(
      n(
        '*بانک شهر*\nانتقال وجه کارتی\nواریز به:7001018382933\nمبلغ:3,990,000ریال\nموجودی:205,726,000ریال\nدیروز حوالی ظهر',
      ),
    );
    expect(r.amountIrr).toBe(3_990_000);
    expect(r.accountHint).toBe('7001018382933');
    expect(r.warnings).toContain('BANK_TIME_FALLBACK_TO_SMS_TIMESTAMP');
  });

  it('Shahr may also omit the seconds', () => {
    const r = parseSms(
      n(
        '*بانک شهر*\nانتقال وجه کارتی\nواریز به:7001018382933\nمبلغ:3,990,000ریال\nموجودی:205,726,000ریال\n1405/06/7 12:45',
      ),
    );
    expect(r.amountIrr).toBe(3_990_000);
    expect(r.accountHint).toBe('7001018382933');
  });

  it('Mellat: the account number is never the amount', () => {
    // The specific wrong answer, named. `generic-credit` returned the account
    // digits — 4,436,995,648 — for a 1,000,000 IRR deposit. Asserting «not that
    // number» as well as «this number» is the part that would catch a future
    // parser making the same mistake in a different way.
    const r = parseSms(n(SAMPLES.find((s) => s.bank === 'ملت')!.text));
    expect(r.amountIrr).not.toBe(4_436_995_648);
    expect(r.amountIrr).toBe(1_000_000);
  });
});

/**
 * What the Mellat parser refuses.
 *
 * These are the guards, and they were the least-covered code in the package the
 * day it was written — 28% of branches. A parser that reads money is exactly
 * the wrong place to leave the rejection paths unexercised: every one of them
 * exists so a body it does not understand produces NOTHING rather than a
 * number, and «produces nothing» is only true if somebody checked.
 */
describe('Mellat refuses rather than guesses', () => {
  const at = (raw: string, timestamp = SMS_TIMESTAMP): NormalizedSms => ({
    raw,
    text: raw,
    sender: 'BANK',
    timestamp,
    deviceId: 'phone-samples',
  });

  it('invents no amount when there is none to read', () => {
    // Account and balance are both present and both removed before the amount
    // is looked for, so there is nothing left. The wrong answer here would be
    // to fall back on one of the numbers it just discarded.
    const r = mellatCreditParser.parse(at('حساب4436995648\nواریز\nمانده 56,773,273'));
    expect(r.matched).toBe(false);
    expect(r.amountIrr).toBeNull();
    expect(r.warnings).toContain('mellat_amount_missing');
  });

  it('will not read an account too short to be one', () => {
    const r = mellatCreditParser.parse(at('حساب12\nواریز\n1,000,000\nمانده 56,773,273'));
    expect(r.matched).toBe(false);
    expect(r.amountIrr).toBeNull();
  });

  it('will not read a balance that is not there', () => {
    const r = mellatCreditParser.parse(at('حساب4436995648\nواریز\n1,000,000'));
    expect(r.matched).toBe(false);
    expect(r.amountIrr).toBeNull();
  });

  it('keeps the money when the date is missing, and says the time is a guess', () => {
    const r = mellatCreditParser.parse(at('حساب4436995648\nواریز\n1,000,000\nمانده 56,773,273'));
    expect(r.amountIrr).toBe(1_000_000);
    expect(r.warnings).toContain('BANK_TIME_FALLBACK_TO_SMS_TIMESTAMP');
  });

  it('keeps the money when the date is impossible', () => {
    // Month 13. `jalaliToGregorianEpochMs` throws, and the throw must cost the
    // timestamp rather than the deposit.
    const r = mellatCreditParser.parse(
      at('حساب4436995648\nواریز\n1,000,000\nمانده 56,773,273\n05/13/40-10:18'),
    );
    expect(r.amountIrr).toBe(1_000_000);
    expect(r.warnings).toContain('BANK_TIME_FALLBACK_TO_SMS_TIMESTAMP');
  });

  it('reads the two-digit year against the Jalali year the message arrived in', () => {
    // `05` is 1405 because the message arrived in 1405 — not because 1400 is
    // written down anywhere. Asserted from both sides of Nowruz, since the
    // Jalali year of a Gregorian instant changes there and a century derived
    // from the wrong side would be off by one.
    const beforeNowruz = mellatCreditParser.parse(
      at('حساب4436995648\nواریز\n1,000,000\nمانده 56,773,273\n05/06/07-10:18', Date.UTC(2027, 0, 15)),
    );
    const afterNowruz = mellatCreditParser.parse(
      at('حساب4436995648\nواریز\n1,000,000\nمانده 56,773,273\n05/06/07-10:18', Date.UTC(2026, 7, 29)),
    );
    expect(beforeNowruz.evidence['bankTimestamp']).toBe(afterNowruz.evidence['bankTimestamp']);
    expect(beforeNowruz.amountIrr).toBe(1_000_000);
  });
});
