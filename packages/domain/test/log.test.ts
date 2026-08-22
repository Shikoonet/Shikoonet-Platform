/**
 * The logger, and the one thing it must never do.
 *
 * Redaction is asserted the way rule 6 demands: by searching the **output
 * string** for the secret, not by comparing against `redact()`'s own idea of
 * what it removed. A test that called the redactor and checked the redactor
 * agreed with itself would pass on the day the deny-list is emptied.
 *
 * The secrets below are shaped like the real ones — a Telegram bot token, a
 * six-digit OTP, a hex HMAC key, a raw bank SMS — because the point is that a
 * grep for those characters comes back empty.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  PERSISTED_INFO_EVENTS,
  serializeError,
  setEventSink,
  type LogRecord,
} from '../src/log.js';

/** Shaped like the real thing, and never a real one. */
const BOT_TOKEN = '7712345678:AAH9fakeTokenForTestsOnly_not_a_real_one';
const OTP = '482913';
const HMAC_KEY = 'a3f1c09b7e4d2a685f0c1b9d3e7a4c62';
const RAW_SMS = 'واریز به حساب 1234-5678 مبلغ 250,000 ریال';

const NOW_MS = Date.UTC(2026, 7, 22, 18, 40, 0);

let written: string[];

beforeEach(() => {
  written = [];
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  setEventSink(null);
  vi.restoreAllMocks();
});

const output = (): string => written.join('');

describe('redaction', () => {
  it('does not let a secret reach the output, at any depth', () => {
    const log = createLogger('bot');
    log.error('provision.failed', {
      order_id: 'ORD-1',
      botToken: BOT_TOKEN,
      otp: OTP,
      'hmac-key': HMAC_KEY,
      smsBody: RAW_SMS,
      panel: {
        apiKey: BOT_TOKEN,
        nested: { password: 'hunter2', authorization: `Bearer ${HMAC_KEY}` },
      },
      attempts: [{ cookie: `s=${HMAC_KEY}` }],
    });

    const out = output();
    // The external truth: the characters are not in the bytes that were written.
    for (const secret of [BOT_TOKEN, OTP, HMAC_KEY, RAW_SMS, 'hunter2']) {
      expect(out, `a secret survived into the log line: ${secret.slice(0, 12)}…`).not.toContain(
        secret,
      );
    }
    // And the line is still worth having.
    expect(out).toContain('ORD-1');
    expect(out).toContain('provision.failed');
  });

  it('keeps walking past a value that points back at itself', () => {
    const cyclic: Record<string, unknown> = { name: 'panel' };
    cyclic['self'] = cyclic;
    cyclic['token'] = BOT_TOKEN;

    createLogger('bot').warn('panel.odd', { cyclic });

    // A driver error holds a reference to its own client. Before the `seen`
    // set this recursed until the stack ran out — inside the logger, during
    // the failure it was describing.
    expect(output()).toContain('[circular]');
    expect(output()).not.toContain(BOT_TOKEN);
  });
});

describe('the logger never becomes the failure', () => {
  it('still writes the line when the sink throws', () => {
    setEventSink(() => {
      throw new Error('postgres is down');
    });

    expect(() => createLogger('bot').error('settle.failed', { claim: 'c-1' })).not.toThrow();
    // The record reached stdout before the sink was called, which is the
    // ordering that makes an outage survivable: the sink is where the log goes
    // to be queryable later, stdout is where it goes to exist at all.
    expect(output()).toContain('settle.failed');
  });

  it('survives a field that cannot be serialised', () => {
    const nasty = {
      get boom(): never {
        throw new Error('getter exploded');
      },
    };
    expect(() => createLogger('bot').info('odd.value', { nasty })).not.toThrow();
  });
});

describe('what reaches the sink', () => {
  const seen: LogRecord[] = [];

  beforeEach(() => {
    seen.length = 0;
    setEventSink((r) => seen.push(r));
  });

  it('persists warn and error, and only the named info events', () => {
    const log = createLogger('bot');
    log.info('poll.cycle', { updates: 3 });
    log.info('settle.paid', { claim: 'c-9' });
    log.warn('panel.slow', {});
    log.error('provision.failed', {});

    expect(seen.map((r) => r.evt)).toEqual(['settle.paid', 'panel.slow', 'provision.failed']);
    // The named list is the contract, not an implementation detail — an event
    // added to it starts costing a row.
    expect(PERSISTED_INFO_EVENTS.has('settle.paid')).toBe(true);
  });

  it('carries the correlation id down from a bound child', () => {
    createLogger('bot').with({ trace: 'u4210' }).error('handle.failed', { ref: 'ORD-7' });

    expect(seen[0]?.trace).toBe('u4210');
    expect(seen[0]?.ref).toBe('ORD-7');
    // `trace` and `ref` are columns, not fields — they were lifted out rather
    // than left to be duplicated in the jsonb.
    expect(seen[0]?.fields).toEqual({});
  });

  it('stamps the record with the clock, not with a counter', () => {
    createLogger('ingest').error('ingest.sms.failed', {});
    expect(seen[0]?.ts).toBe(new Date(NOW_MS).toISOString());
  });
});

describe('serializeError', () => {
  it('keeps the message the Postgres adapter put the statement in', () => {
    const err = new Error('SELECT 1 FROM nope: relation "nope" does not exist');
    const out = serializeError(err);
    expect(out.message).toContain('relation "nope" does not exist');
    expect(out.name).toBe('Error');
    expect(out.stack?.length ?? 0).toBeGreaterThan(0);
  });

  it('follows a cause, and accepts something that is not an Error at all', () => {
    const out = serializeError(new Error('outer', { cause: new Error('inner') }));
    expect(out.cause?.message).toBe('inner');
    expect(serializeError('just a string')).toEqual({
      name: 'NonError',
      message: 'just a string',
    });
  });
});
