import { describe, expect, it } from 'vitest';
import { formatTimeAgo } from '../src/paymentReview.js';

/**
 * The test this function did not have, which is why the bug survived the port.
 *
 * `formatTimeAgo` used to be `formatRelativePast(ms)` and took an elapsed
 * duration, sitting between `formatDuration` and `formatDurationLong` which
 * genuinely do. Two of its three callers passed `verifiedAt` — an absolute
 * timestamp — straight in, so the manually-verified list on the live dashboard
 * read "Verified 29773038 minutes ago" for payments approved that afternoon.
 * A single test with a real timestamp would have caught it on the first run.
 *
 * `now` is passed explicitly throughout: a test that reads the real clock and
 * expects a fixed answer is a time bomb, and this repo has been bitten by that.
 */

// 2026-08-12 17:00:00 Asia/Tehran.
const NOW_MS = 1_786_542_600_000;
const MINUTE = 60_000;

describe('formatTimeAgo', () => {
  it('reads a timestamp, not a duration', () => {
    // The whole bug in one assertion: given a real epoch timestamp it must say
    // 27 minutes, not the ~29.7 million that formatting the epoch produces.
    expect(formatTimeAgo(NOW_MS - 27 * MINUTE, NOW_MS)).toBe('27 minutes ago');
  });

  it('never reports an implausible age for a recent verification', () => {
    // A day of plausible verification times. Anything that treats the argument
    // as an interval lands in the millions here.
    for (const minutes of [0, 1, 5, 27, 60, 240, 1439]) {
      const label = formatTimeAgo(NOW_MS - minutes * MINUTE, NOW_MS);
      const parsed = Number(label.split(' ')[0]);
      if (!Number.isNaN(parsed)) {
        expect(parsed, label).toBeLessThanOrEqual(1440);
      }
    }
  });

  it('says just now inside the first minute', () => {
    expect(formatTimeAgo(NOW_MS, NOW_MS)).toBe('just now');
    expect(formatTimeAgo(NOW_MS - 59_999, NOW_MS)).toBe('just now');
  });

  it('gets the singular right', () => {
    expect(formatTimeAgo(NOW_MS - MINUTE, NOW_MS)).toBe('1 minute ago');
    expect(formatTimeAgo(NOW_MS - 2 * MINUTE, NOW_MS)).toBe('2 minutes ago');
  });

  it('does not count backwards for a clock that is slightly behind', () => {
    // Browser and server clocks disagree; a future timestamp must read as now
    // rather than as a negative age.
    expect(formatTimeAgo(NOW_MS + 5 * MINUTE, NOW_MS)).toBe('just now');
  });
});
