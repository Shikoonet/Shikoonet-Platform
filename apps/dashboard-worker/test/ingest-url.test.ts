/**
 * The URL the panel prints into a phone, and the path it must carry.
 *
 * `ingestUrl` returned `INGEST_URL` verbatim, and on the server that variable
 * was the origin with no path — `https://sms.mahamsteel.ir:9443`. The panel
 * printed it into the SMS-relay configuration, so an admin pasting exactly what
 * they were handed would have pointed the relay at `/`.
 *
 * Measured against the running ingest on 2026-08-23, before the fix:
 *
 *     POST /             → 404
 *     POST /api/v1/sms   → 400
 *
 * The relay retries three times on a non-2xx and then drops the message. So
 * every bank SMS would have been lost, and **nothing on this side would have
 * known** — the request never arrives, so there is no row, no log line and no
 * event. Silence that looks exactly like a shop with no sales that hour.
 *
 * Nothing tested this. `deploy/README.md` called the variable «printed into the
 * SMS-relay phone configuration» and stopped there, which is a description of
 * what it is for rather than a claim about what it contains.
 *
 * The expected path is imported from `@shikoo/contracts` rather than written
 * out below, because that is the same constant `apps/ingest-worker/src/index.ts`
 * registers the route with (`app.post(INGEST_PATH, …)`). A test with its own
 * copy of `/api/v1/sms` would agree with itself while the two halves drifted —
 * which is the sixth rule, and the reason this file exists at all.
 */

import { describe, expect, it } from 'vitest';
import { INGEST_PATH } from '@shikoo/contracts';
import { ingestUrl } from '../src/index.js';

describe('the relay URL handed to an operator', () => {
  it('completes a bare origin, which is what the server actually had', () => {
    expect(ingestUrl({ INGEST_URL: 'https://sms.mahamsteel.ir:9443' })).toBe(
      `https://sms.mahamsteel.ir:9443${INGEST_PATH}`,
    );
  });

  it('leaves a URL that already carries the path alone', () => {
    // Which is why correcting the variable on the server is safe either way:
    // the fix cannot double the path onto an environment somebody already set
    // properly.
    const full = `https://sms.mahamsteel.ir:9443${INGEST_PATH}`;
    expect(ingestUrl({ INGEST_URL: full })).toBe(full);
  });

  it('does not produce a double slash from a trailing one', () => {
    for (const raw of [
      'https://sms.mahamsteel.ir:9443/',
      'https://sms.mahamsteel.ir:9443///',
      `https://sms.mahamsteel.ir:9443${INGEST_PATH}/`,
    ]) {
      expect(ingestUrl({ INGEST_URL: raw })).toBe(
        `https://sms.mahamsteel.ir:9443${INGEST_PATH}`,
      );
    }
  });

  it('keeps a sub-path, for an ingest that is not at the root of its host', () => {
    expect(ingestUrl({ INGEST_URL: 'https://example.test/hub' })).toBe(
      `https://example.test/hub${INGEST_PATH}`,
    );
  });

  it('answers null when unset, so the routes can refuse rather than guess', () => {
    // The older half of this function, kept: a phone pointed at a hard-coded
    // hostname that is no longer ours looks configured and delivers nothing.
    expect(ingestUrl({})).toBeNull();
    expect(ingestUrl({ INGEST_URL: '' })).toBeNull();
    expect(ingestUrl({ INGEST_URL: '   ' })).toBeNull();
  });

  it('always ends at the path the ingest worker listens on', () => {
    // The assertion that survives a rename. Whatever the variable says, what
    // comes out is a URL whose pathname IS the frozen contract — parsed rather
    // than string-matched, so `…/api/v1/smsX` could not pass.
    for (const raw of [
      'https://sms.mahamsteel.ir:9443',
      'https://sms.mahamsteel.ir:9443/',
      `https://sms.mahamsteel.ir:9443${INGEST_PATH}`,
      'https://example.test/hub',
    ]) {
      const out = ingestUrl({ INGEST_URL: raw });
      expect(out, raw).not.toBeNull();
      expect(new URL(out!).pathname.endsWith(INGEST_PATH), raw).toBe(true);
    }
  });
});
