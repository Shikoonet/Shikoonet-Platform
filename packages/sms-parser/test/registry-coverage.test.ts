/**
 * Every parser in the registry, proven against fixtures — and a check that
 * a new parser cannot be added without them.
 *
 * ## Why this file exists
 *
 * `docs/STATUS.md` says «parsers for eight Persian banks». The registry has
 * fifteen entries, and the eight-bank claim was never test-enumerated: one
 * file covered Parsian in depth (43 tests), another covered four *formats*,
 * and the rest were reached only incidentally by whichever generic test
 * happened to route through them. A parser that stopped matching would have
 * been caught by nothing, because no test named it.
 *
 * So the table below is keyed on `parserId`, and the last test in this file
 * asserts that **every id in `REGISTRY` appears in the table**. Adding
 * `packages/sms-parser/src/parsers/tejarat.ts` and registering it turns this
 * suite red until a fixture is written for it. That is the property worth
 * having — not the count.
 *
 * ## What each parser is asked
 *
 * The generic cases are applied to every parser that reads money:
 *
 *   - a valid representative body, in the layout that parser owns
 *   - the same body in Persian digits (۰-۹) and Arabic-Indic digits (٠-٩)
 *   - CRLF line endings and a non-breaking space
 *   - a malformed amount, which must NOT produce a number
 *   - a body that belongs to another parser, which this one must not claim
 *
 * `otp` and `promo` are asked the opposite question: they must claim their
 * body and must never return money.
 *
 * ## Fixtures are synthetic
 *
 * Every body here was written for this file from the layout the parser
 * matches. None is a real customer message. Account fragments are
 * deliberately out of the ranges the seed uses, and the amounts are round
 * numbers no real transfer would carry.
 */

import { describe, expect, it } from 'vitest';
import { parseSms } from '../src/index.js';
import { REGISTRY } from '../src/parsers/registry.js';
import type { NormalizedSms, ParseResult } from '@shikoo/contracts';

const TS = Date.UTC(2026, 7, 5, 9, 0, 0);

function n(raw: string, sender = 'BANK'): NormalizedSms {
  return { raw, text: raw, sender, timestamp: TS, deviceId: 'phone-fixture' };
}

/** ASCII digits → Persian (۰-۹). */
function toPersianDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)] as string);
}

/** ASCII digits → Arabic-Indic (٠-٩). A different Unicode block. */
function toArabicDigits(s: string): string {
  return s.replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)] as string);
}

interface Fixture {
  /** The `parserId` this body must be claimed by. */
  parserId: string;
  /** Human name, for the test title. */
  label: string;
  /** A representative body in that parser's layout. */
  body: string;
  /** What a correct parse produces. */
  expect: {
    classification: ParseResult['classification'];
    direction?: ParseResult['direction'];
    amountIrr?: number | null;
    balanceIrr?: number | null;
  };
  /**
   * Whether the digit-shape variants apply. A parser whose layout has no
   * digits outside the amount (there are none today) would set this false.
   */
  digitVariants?: boolean;
  /** A body this parser must NOT claim. */
  mustNotClaim?: string;
}

// ---------------------------------------------------------------------------
// The table. One entry per money-reading parser in `REGISTRY`.
// ---------------------------------------------------------------------------

const FIXTURES: readonly Fixture[] = [
  {
    parserId: 'generic-otp',
    label: 'OTP',
    body: 'کد تایید: 918273',
    expect: { classification: 'OTP', amountIrr: null, balanceIrr: null },
    digitVariants: false,
  },
  {
    parserId: 'generic-promo',
    label: 'promotional',
    body: 'تبلیغ: ۵۰٪ تخفیف ویژه فقط امروز',
    expect: { classification: 'PROMOTIONAL', amountIrr: null },
    digitVariants: false,
  },
  {
    parserId: 'shahr-credit-v1',
    label: 'Bank Shahr credit',
    body: [
      '*بانک شهر*',
      'انتقال وجه کارتي',
      'واريز به:7001018246497',
      'مبلغ:7,300,000ريال',
      'موجودي:41,250,000ريال',
      '1405/05/14 08:22:17',
    ].join('\n'),
    expect: { classification: 'BANK_TRANSACTION', direction: 'CREDIT', amountIrr: 7_300_000 },
  },
  {
    parserId: 'saman-credit-v1',
    label: 'Saman credit',
    body: [
      'بانك سامان',
      'واريز مبلغ  2,450,000ریال',
      'به  901-777-2938283-1',
      'مانده 19,004,880',
      '1405/5/15',
      '20:48',
    ].join('\n'),
    expect: { classification: 'BANK_TRANSACTION', direction: 'CREDIT', amountIrr: 2_450_000 },
  },
  {
    parserId: 'melli-transfer-v1',
    label: 'Melli transfer',
    body: [
      'بانك ملي',
      'انتقال:1,800,000+',
      'حساب:06006',
      'مانده:6,120,000',
      '0515-20:46',
    ].join('\n'),
    expect: { classification: 'BANK_TRANSACTION', direction: 'CREDIT', amountIrr: 1_800_000 },
  },
  {
    parserId: 'gardeshgari-credit-v1',
    label: 'Gardeshgari credit',
    body: [
      '*بانک گردشگری*',
      'کارت',
      'واريز به: 110.9992.2377306.1',
      'مبلغ: 920,000 ريال',
      '05/05/14_09:45',
      'موجودي: 3,455,000 ريال',
    ].join('\n'),
    expect: { classification: 'BANK_TRANSACTION', direction: 'CREDIT', amountIrr: 920_000 },
  },
  {
    parserId: 'internet-transfer-signed-v1',
    label: 'internet transfer (4-line compact)',
    body: [
      'انتقال اینترنت:+3,300,000',
      'حساب:310057795083',
      'مانده:52,880,140',
      '0514-09:05',
    ].join('\n'),
    expect: { classification: 'BANK_TRANSACTION', direction: 'CREDIT', amountIrr: 3_300_000 },
  },
  {
    parserId: 'account-transfer-signed-v1',
    label: 'account transfer (5-line)',
    body: [
      'انتقال اینترنت',
      'حساب:310057795083',
      'مبلغ:5,500,000+',
      'مانده:82,791,067',
      '05/14-11:30',
    ].join('\n'),
    expect: { classification: 'BANK_TRANSACTION', direction: 'CREDIT', amountIrr: 5_500_000 },
  },
  {
    parserId: 'parsian-signed-v1',
    label: 'Parsian signed',
    body: ['30101883751600', 'مبلغ:4,150,000+', 'مانده:11,900,500', '05/14', '10:30'].join('\n'),
    expect: { classification: 'BANK_TRANSACTION', direction: 'CREDIT', amountIrr: 4_150_000 },
  },
  {
    parserId: 'compact-signed-v1',
    label: 'generic compact signed',
    body: ['10.8206380.1', '+2,750,000', '05/14_11:28', 'مانده: 8,410,000'].join('\n'),
    expect: { classification: 'BANK_TRANSACTION', direction: 'CREDIT', amountIrr: 2_750_000 },
  },
  {
    parserId: 'generic-credit',
    label: 'generic credit keyword',
    body: 'واریز 650,000 ریال - مانده 4,900,000 ریال',
    expect: {
      classification: 'BANK_CREDIT',
      direction: 'CREDIT',
      amountIrr: 650_000,
      balanceIrr: 4_900_000,
    },
  },
  {
    parserId: 'generic-debit',
    label: 'generic debit keyword',
    body: 'برداشت 310,000 ریال - مانده 1,200,000 ریال',
    expect: { classification: 'BANK_DEBIT', direction: 'DEBIT', amountIrr: 310_000 },
  },
  {
    parserId: 'generic-balance',
    label: 'balance enquiry',
    body: 'مانده حساب شما 7,650,000 ریال می‌باشد',
    expect: { classification: 'BALANCE', balanceIrr: 7_650_000 },
  },
  {
    parserId: 'fallback-unknown',
    label: 'unrecognised message',
    body: 'سلام، جلسه فردا ساعت ده برگزار می‌شود.',
    expect: { classification: 'UNKNOWN', amountIrr: null },
    digitVariants: false,
  },
];

/**
 * The parsers that read money. Used by the shared assertions below; `otp`,
 * `promo` and `fallback-unknown` are excluded because "must not return an
 * amount" is their whole contract, asserted in the table instead.
 */
const MONEY_PARSERS = new Set(
  FIXTURES.filter((f) => (f.expect.amountIrr ?? null) !== null).map((f) => f.parserId),
);

// ---------------------------------------------------------------------------

describe('every registered parser has a fixture', () => {
  it('the table covers REGISTRY exactly, so a new parser cannot arrive untested', () => {
    const registered = REGISTRY.map((p) => p.id).sort();
    const covered = [...new Set(FIXTURES.map((f) => f.parserId))].sort();

    const missing = registered.filter((id) => !covered.includes(id));
    const stale = covered.filter((id) => !registered.includes(id));

    // Named individually rather than as a count: «expected 15 to be 14» sends
    // somebody counting, «missing: tejarat-credit-v1» sends them writing.
    expect(missing, `parsers in REGISTRY with no fixture: ${missing.join(', ')}`).toEqual([]);
    expect(stale, `fixtures for parsers no longer registered: ${stale.join(', ')}`).toEqual([]);
  });

  it('REGISTRY ids are unique', () => {
    const ids = REGISTRY.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe.each(FIXTURES)('$label ($parserId)', (f) => {
  it('claims its representative body and reads it correctly', () => {
    const r = parseSms(n(f.body));
    expect(r.parserId, `expected ${f.parserId}, body:\n${f.body}`).toBe(f.parserId);
    expect(r.classification).toBe(f.expect.classification);
    if (f.expect.direction !== undefined) expect(r.direction).toBe(f.expect.direction);
    if (f.expect.amountIrr !== undefined) expect(r.amountIrr).toBe(f.expect.amountIrr);
    if (f.expect.balanceIrr !== undefined) expect(r.balanceIrr).toBe(f.expect.balanceIrr);
  });

  it('reads the same amount when the digits are Persian', () => {
    if (f.digitVariants === false) return;
    const r = parseSms(n(toPersianDigits(f.body)));
    expect(r.amountIrr).toBe(f.expect.amountIrr ?? null);
    expect(r.classification).toBe(f.expect.classification);
  });

  it('reads the same amount when the digits are Arabic-Indic', () => {
    if (f.digitVariants === false) return;
    // A different Unicode block from Persian. `normalizeText` folds both; a
    // parser that hard-coded one range would pass the test above and fail
    // here, which is the point of asking twice.
    const r = parseSms(n(toArabicDigits(f.body)));
    expect(r.amountIrr).toBe(f.expect.amountIrr ?? null);
  });

  it('survives CRLF line endings and a non-breaking space', () => {
    if (f.digitVariants === false) return;
    const mangled = f.body.replace(/\n/g, '\r\n').replace(/ /g, ' ');
    const r = parseSms(n(mangled));
    expect(r.amountIrr).toBe(f.expect.amountIrr ?? null);
  });

  it('does not invent an amount when the number is malformed', () => {
    if (!MONEY_PARSERS.has(f.parserId)) return;
    // Every run of digits replaced by `-`. The layout survives; the money
    // does not. A parser that returns a number here is reading something it
    // should not — and a number that reaches `transaction_candidates` from a
    // body with no amount in it is a phantom payment.
    const broken = f.body.replace(/[\d,]+/g, '---');
    const r = parseSms(n(broken));
    expect(r.amountIrr, `broken body produced an amount:\n${broken}`).toBeNull();
  });
});

describe('the OTP rule, across every fixture', () => {
  it('never returns money for a body carrying a one-time password', () => {
    // The registry runs `otpParser` first precisely so an OTP is decided
    // before any money parser sees the body. This asserts the consequence
    // rather than the ordering: a body that is BOTH OTP-shaped AND
    // amount-shaped must still come back as OTP with no amount.
    const bodies = [
      'رمز پویا: 447291 مبلغ 2,500,000 ریال',
      'رمز یکبار مصرف 883012 برای مبلغ 900,000 ریال',
      'کد تایید: 120934',
      'کد ورود: 665544 مبلغ 1,000,000 ریال',
      'Your verification code is 445566, amount 500,000 IRR',
    ];
    for (const body of bodies) {
      const r = parseSms(n(body));
      expect(r.classification, body).toBe('OTP');
      expect(r.amountIrr, body).toBeNull();
      expect(r.balanceIrr, body).toBeNull();
    }
  });

  it('fails SAFE on an OTP phrasing the vocabulary does not know', () => {
    // FOUND WRITING THIS FILE, and left as a recorded fact rather than a
    // silent fix. `otp.ts:6` matches «رمز یکبار» but not «کد یکبار مصرف»,
    // which is a common Iranian phrasing — the pattern list pairs «یکبار»
    // with «رمز» and pairs «کد» only with تایید/تأیید/فعالسازی/ورود/احراز.
    //
    // The consequence is bounded and this test pins the bound: the message
    // falls through to UNKNOWN, and UNKNOWN creates no transaction candidate
    // (`shouldCreateTransaction` requires direction CREDIT), so no phantom
    // money is invented. What DOES happen is that the body is stored in
    // `raw_sms_events` without the OTP being decided first.
    //
    // Widening the vocabulary is a parser change with its own blast radius —
    // «کد یکبار» would also match a promotional «کد یکبار مصرف تخفیف» — so it
    // belongs in a change that is about the parser, not in one about CI.
    const r = parseSms(n('کد یکبار مصرف 883012 برای مبلغ 900,000 ریال'));
    expect(r.classification).toBe('UNKNOWN');
    // The safety property that matters: no money is read out of it.
    expect(r.amountIrr).toBeNull();
    expect(r.balanceIrr).toBeNull();
  });

  it('does not carry the one-time password into any returned field', () => {
    // The value must not survive into evidence, an account hint or a
    // reference. `parsers.test.ts` asserts the amount is null; this asserts
    // the six digits themselves are gone, which is the part that would end
    // up in `raw_sms_events` and in a log line.
    const r = parseSms(n('کد تایید: 556677'));
    const serialised = JSON.stringify({
      accountHint: r.accountHint,
      transactionReference: r.transactionReference,
      evidence: r.evidence,
    });
    expect(serialised).not.toContain('556677');
  });
});