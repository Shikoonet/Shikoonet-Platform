import { describe, expect, it } from 'vitest';
import { clientIp, fixedWindowRateLimit, noRateLimit } from '../src/rateLimit.js';

/** A clock the test drives, so nothing here depends on wall time. */
function clock(start = 1_786_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('fixed window rate limit', () => {
  it('allows up to the limit and rejects the next request', async () => {
    const c = clock();
    const rl = fixedWindowRateLimit({ limit: 3, windowMs: 60_000, now: c.now });

    for (let i = 0; i < 3; i++) {
      expect((await rl.limit({ key: 'device-a' })).success).toBe(true);
    }
    expect((await rl.limit({ key: 'device-a' })).success).toBe(false);
  });

  it('counts each key separately', async () => {
    const c = clock();
    const rl = fixedWindowRateLimit({ limit: 1, windowMs: 60_000, now: c.now });

    expect((await rl.limit({ key: 'device-a' })).success).toBe(true);
    expect((await rl.limit({ key: 'device-a' })).success).toBe(false);
    // One noisy device must not lock out every other phone.
    expect((await rl.limit({ key: 'device-b' })).success).toBe(true);
  });

  it('opens a fresh window once the old one expires', async () => {
    const c = clock();
    const rl = fixedWindowRateLimit({ limit: 2, windowMs: 60_000, now: c.now });

    expect((await rl.limit({ key: 'k' })).success).toBe(true);
    expect((await rl.limit({ key: 'k' })).success).toBe(true);
    expect((await rl.limit({ key: 'k' })).success).toBe(false);

    c.advance(59_999);
    expect((await rl.limit({ key: 'k' })).success).toBe(false);

    c.advance(1);
    expect((await rl.limit({ key: 'k' })).success).toBe(true);
  });

  it('keeps rejecting for the rest of a window once over the limit', async () => {
    // A caller that keeps hammering must not reset its own counter.
    const c = clock();
    const rl = fixedWindowRateLimit({ limit: 1, windowMs: 10_000, now: c.now });

    expect((await rl.limit({ key: 'k' })).success).toBe(true);
    for (let i = 0; i < 5; i++) {
      c.advance(1_000);
      expect((await rl.limit({ key: 'k' })).success).toBe(false);
    }
  });

  it('does not grow without bound', async () => {
    // Every request from a different IP would otherwise leak a bucket each.
    const c = clock();
    const rl = fixedWindowRateLimit({ limit: 1, windowMs: 1_000, now: c.now });

    for (let i = 0; i < 1_500; i++) await rl.limit({ key: `ip-${i}` });
    c.advance(2_000);
    for (let i = 0; i < 1_500; i++) await rl.limit({ key: `later-${i}` });

    // The expired buckets are gone, so an old key starts a fresh window.
    expect((await rl.limit({ key: 'ip-0' })).success).toBe(true);
  });
});

describe('noRateLimit', () => {
  it('always allows', async () => {
    for (let i = 0; i < 100; i++) {
      expect((await noRateLimit.limit({ key: 'k' })).success).toBe(true);
    }
  });
});

describe('who the client is', () => {
  /** A header bag that answers case-insensitively, as Hono's does. */
  const headers = (bag: Record<string, string>) => (name: string) =>
    bag[name.toLowerCase()];

  it('ignores a header the operator has not named', () => {
    // The whole failure this replaces. `cf-connecting-ip` was read
    // unconditionally, and now that nothing strips it the client sets it — so
    // an attacker chose their own bucket and rotated it per request. Trusting a
    // header is trusting whoever can set it, and only the operator knows which
    // one the proxy overwrites.
    const spoofed = headers({
      'cf-connecting-ip': '1.2.3.4',
      'x-forwarded-for': '5.6.7.8',
      'x-real-ip': '9.9.9.9',
    });
    expect(clientIp(spoofed, undefined)).toBeNull();
    expect(clientIp(spoofed, '')).toBeNull();
  });

  it('reads exactly the header it was told to', () => {
    const bag = headers({ 'x-real-ip': '203.0.113.7', 'cf-connecting-ip': '1.2.3.4' });
    expect(clientIp(bag, 'X-Real-IP')).toBe('203.0.113.7');
    expect(clientIp(bag, 'x-real-ip')).toBe('203.0.113.7');
  });

  it('answers null when the named header is missing, rather than a shared bucket', () => {
    // `?? 'unknown'` put every caller in one bucket, so one busy device
    // rate-limited the whole fleet. Callers skip the per-IP limit on null.
    expect(clientIp(headers({}), 'x-real-ip')).toBeNull();
    expect(clientIp(headers({ 'x-real-ip': '   ' }), 'x-real-ip')).toBeNull();
  });

  it('takes the client end of a forwarded-for list, not the proxy end', () => {
    // Only relevant if somebody configures X-Forwarded-For, which the docs
    // advise against because nginx appends rather than overwrites. If they do,
    // the leftmost entry is the original client; the rightmost is the hop.
    expect(clientIp(headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.2' }), 'x-forwarded-for'))
      .toBe('203.0.113.7');
  });
});
