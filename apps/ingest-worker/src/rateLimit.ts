/**
 * Rate limiting for the ingest endpoint.
 *
 * On Cloudflare this was a platform binding. On our own server the obvious
 * answer is nginx `limit_req` at the edge, and that is still where the bulk of
 * it belongs — it costs nothing and rejects floods before they reach Node.
 *
 * But this endpoint is the only publicly reachable surface in the whole
 * platform, and "the reverse proxy will handle it" is a configuration that can
 * be forgotten, mistyped, or lost in a server rebuild. So the limit is enforced
 * here as well. Defence in depth is not over-engineering on a trust boundary.
 *
 * ponytail: fixed window, in-process. Accurate for a single Node process, which
 * is the deployment. Two processes would each allow the full quota — move to
 * Redis or a shared counter if we ever run more than one.
 */

export interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface FixedWindowOptions {
  /** Requests allowed per window, per key. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Injectable for tests; defaults to the real clock. */
  now?: () => number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * A fixed-window counter keyed by device id or client IP.
 *
 * Expired buckets are swept on write rather than by a timer: a timer would keep
 * the process alive and would have to be cleaned up in tests, and the sweep is
 * O(1) amortised because it only runs when the map grows past a threshold.
 */
export function fixedWindowRateLimit(options: FixedWindowOptions): RateLimit {
  const { limit, windowMs, now = Date.now } = options;
  const buckets = new Map<string, Bucket>();
  let sweepAt = 0;

  function sweep(t: number): void {
    if (buckets.size < 1000 || t < sweepAt) return;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= t) buckets.delete(key);
    }
    sweepAt = t + windowMs;
  }

  return {
    limit({ key }) {
      const t = now();
      sweep(t);
      const bucket = buckets.get(key);
      if (bucket === undefined || bucket.resetAt <= t) {
        buckets.set(key, { count: 1, resetAt: t + windowMs });
        return Promise.resolve({ success: true });
      }
      bucket.count += 1;
      return Promise.resolve({ success: bucket.count <= limit });
    },
  };
}

/** Never rejects. For tests that are not about rate limiting. */
export const noRateLimit: RateLimit = {
  limit: () => Promise.resolve({ success: true }),
};
