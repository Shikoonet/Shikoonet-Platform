/**
 * Rate limiting, and the question it depends on: who is the client?
 *
 * On Cloudflare this was a platform binding. On our own server the obvious
 * answer is nginx `limit_req` at the edge, and that is still where the bulk of
 * it belongs — it costs nothing and rejects floods before they reach Node.
 *
 * But the SMS endpoint is the only publicly reachable surface in the whole
 * platform and the operator login is the only wall in front of the panel, and
 * "the reverse proxy will handle it" is a configuration that can be forgotten,
 * mistyped, or lost in a server rebuild. So the limit is enforced here as well.
 * Defence in depth is not over-engineering on a trust boundary.
 *
 * It lives in `packages/domain` rather than in either app because both of them
 * need it and neither may import the other.
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

// ---------------------------------------------------------------------------
// who the client is
// ---------------------------------------------------------------------------

/**
 * The client address, if it can be known at all.
 *
 * ## What was here before
 *
 * `c.req.header('cf-connecting-ip') ?? 'unknown'`. Cloudflare left the request
 * path on 2026-08-17, so that header is now **never** present, and the fallback
 * is a single literal string. Two consequences, in opposite directions:
 *
 *   - **Every client shares one bucket.** One noisy phone rate-limits the whole
 *     fleet, and the limit stops describing anybody in particular.
 *   - **The header is attacker-controlled.** Nothing strips it any more, so a
 *     client that *does* send `cf-connecting-ip` picks its own bucket and can
 *     rotate it per request — the limit is bypassed by typing a header name.
 *
 * A limiter that both punishes the innocent and waves through the guilty is
 * worse than none, because it reads as protection.
 *
 * ## What replaces it
 *
 * The header carrying the client address is **named by configuration** rather
 * than guessed, and it is trusted only because the operator has said that the
 * proxy in front sets it. `X-Real-IP` from nginx is the intended one, because
 * `proxy_set_header X-Real-IP $remote_addr` *overwrites* whatever the client
 * sent. `X-Forwarded-For` is the wrong choice by default: nginx appends to it,
 * so the client's own value stays in the string.
 *
 * When it is not configured, or configured and absent, the answer is `null` —
 * "unknown", not a shared bucket. Callers skip the per-IP limit rather than
 * putting everybody in one. Silently returning a constant is how this failed
 * the first time.
 */
export function clientIp(
  header: (name: string) => string | undefined,
  headerName: string | undefined,
): string | null {
  if (headerName === undefined || headerName === '') return null;
  const raw = header(headerName)?.trim();
  if (raw === undefined || raw === '') return null;
  // `X-Forwarded-For` is a list even when a well-behaved proxy sets it, and the
  // first entry is the original client. Taking the last would take the proxy.
  const first = raw.split(',')[0]?.trim();
  return first === undefined || first === '' ? null : first;
}
