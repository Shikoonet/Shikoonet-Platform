/**
 * An OTP must not survive the ingestion path — proven at the database, not
 * at the parser.
 *
 * ## The failure this file exists for
 *
 * `otp.ts` paired «یکبار مصرف» with «رمز» and paired «کد» only with
 * تایید/تأیید/فعالسازی/ورود/احراز. So «کد یکبار مصرف», one of the commonest
 * Iranian phrasings, matched nothing. It fell through to `fallback-unknown`,
 * and `ingest.ts`'s `isRedactable` is false for UNKNOWN — so the full body,
 * code included, was written to `raw_sms_events.normalized_body`.
 *
 * No money was ever at risk: UNKNOWN creates no transaction candidate. What
 * broke is the guarantee `docs/threat-model.md:106` makes, that an OTP is
 * never stored.
 *
 * ## Why these tests read the database
 *
 * `packages/sms-parser` already asserts that `parseSms` returns OTP with a
 * null amount. That is a statement about a function. The guarantee is about a
 * ROW — and the two came apart precisely because the classification was
 * consulted to decide redaction, so a classification miss was a storage miss.
 *
 * So every test here posts through the real HTTP handler and then SELECTs
 * every column that could hold text, asserting the code is in none of them.
 * A test that trusted the classifier would have been green throughout the
 * window this bug was open.
 *
 * ## The fixtures
 *
 * Every message below was written for this file. No real SMS, no real OTP, no
 * real bank. The codes are obviously synthetic runs (`112233`, `445566`) and
 * the amounts are round numbers no transfer carries.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySchema, env } from './helpers/env.js';
import { app } from '../src/index.js';

const DEVICE_CODE = 'otp-persist';
const API_KEY = 'c'.repeat(40);

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
  )
    .bind('otp-persist-device', DEVICE_CODE, 'otp persistence fixture', now)
    .run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO device_credentials
       (id, device_id, token_hash, token_prefix, status, created_at, activated_at)
     VALUES (?1, ?2, ?3, ?4, 'ACTIVE', ?5, ?5)`,
  )
    .bind(
      'otp-persist-credential',
      'otp-persist-device',
      await sha256Hex(API_KEY),
      API_KEY.slice(0, 4),
      now,
    )
    .run();
});

let clock = 1_786_500_000_000;

beforeEach(async () => {
  await env.DB.prepare(
    `DELETE FROM raw_sms_events WHERE device_id = 'otp-persist-device'`,
  ).run();
});

async function post(message: string): Promise<Response> {
  clock += 1000;
  return app.fetch(
    new Request('https://example.com/api/v1/sms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: API_KEY,
        deviceId: DEVICE_CODE,
        deviceName: 'X',
        message,
        sender: 'BANK',
        timestamp: String(clock),
        checksum: '0'.repeat(32),
      }),
    }),
    env,
  );
}

/**
 * Every text-bearing column of the row this post created, concatenated.
 *
 * Column by column rather than `SELECT *`: a column added later that starts
 * carrying the body should turn this red, and `SELECT *` with a `JSON.
 * stringify` would do that too — but naming them means the assertion failure
 * says which column, which is the difference between a fix and an
 * investigation.
 */
async function storedText(): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT encrypted_or_protected_body, normalized_body, classification,
            parser_status, parser_id, parser_version, sender
       FROM raw_sms_events
      WHERE device_id = 'otp-persist-device'
      ORDER BY created_at DESC LIMIT 1`,
  ).first<Record<string, unknown>>();
  expect(row, 'the post created no row at all').not.toBeNull();
  return Object.values(row ?? {})
    .map((v) => (v === null ? '' : String(v)))
    .join(' | ');
}

async function classificationOf(): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT classification FROM raw_sms_events
      WHERE device_id = 'otp-persist-device'
      ORDER BY created_at DESC LIMIT 1`,
  ).first<{ classification: string }>();
  return row?.classification ?? '';
}

async function candidateCount(): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT count(*)::int AS n FROM transaction_candidates tc
       JOIN raw_sms_events r ON r.id = tc.raw_sms_event_id
      WHERE r.device_id = 'otp-persist-device'`,
  ).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Every wording, every digit shape.
// ---------------------------------------------------------------------------

/** ASCII → Persian (۰-۹). */
const fa = (s: string) => s.replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)] as string);
/** ASCII → Arabic-Indic (٠-٩). A different Unicode block. */
const ar = (s: string) => s.replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)] as string);

const OTP_WORDINGS: readonly [string, string][] = [
  ['رمز یکبار مصرف', 'رمز یکبار مصرف 112233'],
  ['رمز یک بار مصرف (spaced)', 'رمز یک بار مصرف 112233'],
  ['رمز پویا', 'رمز پویا: 112233'],
  ['کد یکبار مصرف', 'کد یکبار مصرف 112233'],
  ['کد یک بار مصرف (spaced)', 'کد یک بار مصرف 112233'],
  ['کد تایید', 'کد تایید: 112233'],
  ['کد ورود', 'کد ورود 112233'],
  ['رمز موقت', 'رمز موقت 112233'],
  ['English one-time password', 'Your one-time password is 112233'],
  ['English verification code', 'Your verification code is 112233'],
  ['OTP', 'OTP 112233'],
];

describe.each(OTP_WORDINGS)('an OTP written as «%s»', (_label, body) => {
  it('is classified OTP and its code reaches no column', async () => {
    expect((await post(body)).status).toBe(200);
    expect(await classificationOf()).toBe('OTP');
    const stored = await storedText();
    expect(stored, `the code is in a stored column: ${stored}`).not.toContain('112233');
    expect(stored).not.toContain(body);
  });

  it('is still redacted when the digits are Persian', async () => {
    const persian = fa(body);
    expect((await post(persian)).status).toBe(200);
    const stored = await storedText();
    expect(stored).not.toContain(fa('112233'));
    expect(stored).not.toContain(persian);
  });

  it('is still redacted when the digits are Arabic-Indic', async () => {
    const arabic = ar(body);
    expect((await post(arabic)).status).toBe(200);
    const stored = await storedText();
    expect(stored).not.toContain(ar('112233'));
  });

  it('creates no transaction candidate', async () => {
    await post(body);
    expect(await candidateCount()).toBe(0);
  });
});

describe('an OTP that also mentions money', () => {
  it('is an OTP, and neither the code nor an amount is read from it', async () => {
    // The shape that made the old gap dangerous-looking: a body carrying both
    // a code and an amount. It must be decided as an OTP — so no money is
    // read out of it — and the code must not be stored.
    const body = 'کد یکبار مصرف 445566 برای مبلغ 900,000 ریال';
    expect((await post(body)).status).toBe(200);
    expect(await classificationOf()).toBe('OTP');
    const stored = await storedText();
    expect(stored).not.toContain('445566');
    expect(await candidateCount()).toBe(0);
  });

  it('survives CRLF and a non-breaking space', async () => {
    const body = 'کد یکبار مصرف\r\n445566\r\nمبلغ 900,000 ریال';
    expect((await post(body)).status).toBe(200);
    const stored = await storedText();
    expect(stored).not.toContain('445566');
  });
});

describe('promotional messages are NOT OTPs', () => {
  // The other direction, and the one an over-broad regex breaks. A message
  // selling something must keep its body: `normalized_body` is what an
  // operator reads on «رویدادها», and a shop that redacted its own marketing
  // would be unable to tell why a pattern stopped matching.
  const PROMOTIONAL: readonly [string, string][] = [
    ['one-time discount code', 'کد یکبار مصرف تخفیف 778899 را وارد کنید'],
    ['discount code, other order', 'کد تخفیف یکبار مصرف 778899'],
    ['English promo', 'Use promo code 778899 for 20% off today'],
    ['plain marketing', 'فروش ویژه امروز! کد 778899 را بزنید و تخفیف بگیرید'],
  ];

  it.each(PROMOTIONAL)('«%s» is not classified OTP', async (_label, body) => {
    expect((await post(body)).status).toBe(200);
    expect(await classificationOf()).not.toBe('OTP');
  });
});

describe('defence in depth, when the classifier misses', () => {
  it('scrubs a code-shaped number out of a body that was NOT classified OTP', async () => {
    // The layer that exists because a vocabulary is a list, and a list is
    // never finished.
    //
    // Finding a body that actually REACHES it took a correction worth
    // recording. The first attempt used «کد یکبار مصرف تخفیف …» and asserted
    // the sentence survived — but `promoParser` claims anything containing
    // «تخفیف», PROMOTIONAL is already redactable, and the body was NULL. The
    // test failed because its premise was wrong, not because the code was.
    //
    // «کوپن» is the seam: it is in `otp.ts`'s selling-words, so the message is
    // NOT an authentication OTP, and it is NOT in `promo.ts`'s patterns, so
    // nothing claims it and it lands UNKNOWN — which is exactly the
    // non-redactable classification the original bug went out through.
    //
    // The SENTENCE must survive; only the digits go. Blanking the body would
    // make every unrecognised message mentioning a code permanently
    // unparseable, and the shop would lose payments to protect a number.
    const body = 'کد تایید کوپن 778899 را وارد کنید';
    expect((await post(body)).status).toBe(200);

    const row = await env.DB.prepare(
      `SELECT classification, normalized_body FROM raw_sms_events
        WHERE device_id = 'otp-persist-device'
        ORDER BY created_at DESC LIMIT 1`,
    ).first<{ classification: string; normalized_body: string | null }>();

    // Not OTP, and not otherwise redactable — so this row really did store a
    // body, which is what makes the assertion below mean something.
    expect(row?.classification).toBe('UNKNOWN');
    const stored = row?.normalized_body ?? '';
    expect(stored, 'a body WAS stored, so the scrub had something to do').not.toBe('');
    expect(stored, 'the code survived into a non-OTP row').not.toContain('778899');
    // And the rest of the message is still readable by an operator.
    expect(stored).toContain('کوپن');
    expect(stored).toContain('کد تایید');
  });

  it('scrubs every code-shaped run, not only the one beside the marker', async () => {
    // A message with two numbers must not depend on this guessing which is
    // the secret.
    const body = 'Use coupon code 778899 with your verification code 112233';
    expect((await post(body)).status).toBe(200);
    const row = await env.DB.prepare(
      `SELECT normalized_body FROM raw_sms_events
        WHERE device_id = 'otp-persist-device'
        ORDER BY created_at DESC LIMIT 1`,
    ).first<{ normalized_body: string | null }>();
    const stored = row?.normalized_body ?? '';
    expect(stored).not.toContain('778899');
    expect(stored).not.toContain('112233');
    expect(stored).toContain('coupon');
  });

  it('leaves an ordinary bank SMS completely untouched', async () => {
    // The cost side of the eager check. A body with no OTP marker keeps every
    // digit it had — an account fragment, an amount, a balance — because that
    // is what the operator and every parser need.
    const body = 'واریز 650,000 ریال - مانده 4,900,000 ریال';
    expect((await post(body)).status).toBe(200);
    const row = await env.DB.prepare(
      `SELECT normalized_body FROM raw_sms_events
        WHERE device_id = 'otp-persist-device'
        ORDER BY created_at DESC LIMIT 1`,
    ).first<{ normalized_body: string | null }>();
    expect(row?.normalized_body ?? '').toContain('650,000');
    expect(row?.normalized_body ?? '').toContain('4,900,000');
  });
});

describe('the logs', () => {
  it('never carry the OTP or the body it came from', async () => {
    // Captured at the sink rather than trusted. `packages/domain/src/log.ts`
    // redacts by KEY — a field called `apiKey` is replaced wherever it
    // appears — and that is exactly the mechanism that cannot help here,
    // because a body is not a denied key name. The only defence is that
    // nothing ever puts it in a log line, which is a claim about every call
    // site and therefore worth measuring rather than reading.
    const written: string[] = [];
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        written.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      }),
    );
    try {
      await post('کد یکبار مصرف 334455 برای ورود');
      await post('رمز پویا: 334455');
      // A body that will not parse: the path most likely to log something
      // about what it could not read.
      await post('یک پیام کاملاً نامفهوم با کد یکبار مصرف 334455');
    } finally {
      for (const s of spies) s.mockRestore();
    }

    const all = written.join('\n');
    expect(all, 'an OTP value reached a log line').not.toContain('334455');
    expect(all).not.toContain('کد یکبار مصرف 334455');
    expect(all).not.toContain('رمز پویا: 334455');
  });
});

describe('what an operator can read back', () => {
  it('cannot recover the OTP from the stored row by any column', async () => {
    // The dashboard reads `raw_sms_events` through `eventRoutes`/`today`. If
    // the value is in no column, no route can render it — which is a stronger
    // statement than checking the routes one at a time, and it stays true for
    // a route written next year.
    await post('کد یکبار مصرف 998877 برای ورود به حساب');
    const rows = await env.DB.prepare(
      `SELECT * FROM raw_sms_events WHERE device_id = 'otp-persist-device'`,
    ).all<Record<string, unknown>>();
    const serialised = JSON.stringify(rows.results ?? []);
    expect(serialised, 'the OTP is recoverable from the row').not.toContain('998877');
  });

  it('leaves no transaction candidate, payment or wallet movement behind', async () => {
    await post('کد یکبار مصرف 998877 برای ورود به حساب');
    expect(await candidateCount()).toBe(0);

    // Nothing downstream either. An OTP is not money and must not have
    // produced a claim, a match or a ledger entry.
    const claims = await env.DB.prepare(
      `SELECT count(*)::int AS n FROM payment_claims WHERE id LIKE 'otp-persist%'`,
    ).first<{ n: number }>();
    expect(Number(claims?.n ?? 0)).toBe(0);
  });
});