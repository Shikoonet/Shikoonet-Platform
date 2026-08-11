import { describe, expect, it } from 'vitest';
import { fixedWindowRateLimit, noRateLimit } from '../src/rateLimit.js';

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
