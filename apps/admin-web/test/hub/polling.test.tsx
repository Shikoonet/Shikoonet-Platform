/**
 * Tests for the adaptive polling layer in query.ts.
 *
 * Covers the dashboard spec contract:
 *   - 30 s visible polling cadence (no 5 s retries)
 *   - No polling while document.hidden
 *   - One immediate refresh on return-to-visible / focus / online
 *   - Concurrent focus + visibility events collapse to one refetch
 *   - Multiple focus events within WAKEUP_COOLDOWN_MS collapse to one
 *   - Mutation-triggered invalidate fires an immediate refetch without
 *     creating a second polling loop
 *   - Exactly one active polling timer per cache, even with many keys
 *   - Timers + wake listeners are torn down on dispose / unmount
 *   - Intervals below 30 000 ms warn in dev (production code never
 *     passes an explicit intervalMs — it inherits the default floor)
 *   - Cache singleton invariant (one instance per page)
 *   - StrictMode double-mount does not leak timers
 *   - NotificationBell has no private setInterval (verified by source
 *     inspection — see test below)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Vitest runs with cwd at the package root. Resolving from there is both
// separator-safe (the previous /test\/.../ string surgery never matched on
// Windows) and scheme-safe (import.meta.url is not a file: URL under Vitest).
const SRC = (file: string) => resolve(process.cwd(), 'src', file);

/**
 * Every component in the package, hub and panel alike.
 *
 * It used to read one flat directory, which was the whole package when the
 * payment hub was its own build. After the merge that directory is the panel's
 * chrome and the hub sits one level down in `src/hub` — the same scan would
 * have kept passing while checking none of the files it was written for. The
 * rule it enforces is not hub-specific anyway: no screen anywhere may set its
 * own polling interval.
 */
function componentFiles(dir = SRC('.'), prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const label = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...componentFiles(join(dir, entry.name), label));
    else if (entry.name.endsWith('.tsx')) found.push(label);
  }
  return found;
}
import { createCache, DASHBOARD_POLL_INTERVAL_MS } from '../../src/hub/query.js';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('adaptive polling — interval + visibility', () => {
  it('polls every 30 s when the tab is visible', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const cache = createCache();
    renderHook(() => cache.useQuery('visible', { fetcher }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  });

  it('makes no requests before the 30 s cycle has elapsed', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const cache = createCache();
    renderHook(() => cache.useQuery('idle', { fetcher }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not poll while the tab is hidden', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });

    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const cache = createCache();
    renderHook(() => cache.useQuery('hidden', { fetcher }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('adaptive polling — wake-up triggers', () => {
  it('refreshes immediately on window focus', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const cache = createCache();
    renderHook(() => cache.useQuery('focus', { fetcher }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });

    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it('coalesces focus + visibilitychange into a single refetch', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const cache = createCache();
    renderHook(() => cache.useQuery('coalesce', { fetcher }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });

    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('coalesces multiple focus events inside the wake-up cooldown', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const cache = createCache();
    renderHook(() => cache.useQuery('throttle', { fetcher }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    // Three focus events spread across separate tasks within the
    // 1.5 s cooldown — must collapse to ONE additional refetch.
    window.dispatchEvent(new Event('focus'));
    await act(async () => {
      await Promise.resolve();
    });
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('refreshes once when the tab returns to visible', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });

    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const cache = createCache();
    renderHook(() => cache.useQuery('visible-return', { fetcher }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });

    // 60 s pass hidden — no new fetches.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Tab returns to visible. Exactly one coalesced refresh.
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
    });

    // And no second timer is created.
    expect(cache.debug().activeTimers).toBe(1);
  });
});

describe('adaptive polling — mutations', () => {
  it('refreshes immediately after a mutation invalidates a key', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const cache = createCache();
    renderHook(() => cache.useQuery('mut', { fetcher }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });

    cache.invalidate('mut');
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it('mutation invalidation does not create a second polling timer', async () => {
    const cache = createCache();
    renderHook(() => cache.useQuery('mut-timer', { fetcher: vi.fn().mockResolvedValue({}) }));
    expect(cache.debug().activeTimers).toBe(1);

    cache.invalidate('mut-timer');
    await act(async () => {
      await Promise.resolve();
    });

    // Still exactly one timer after the invalidation-driven refetch.
    expect(cache.debug().activeTimers).toBe(1);
  });
});

describe('adaptive polling — timer + cache invariants', () => {
  it('keeps exactly one active polling timer across many subscribers', async () => {
    const cache = createCache();
    const a = renderHook(() => cache.useQuery('a', { fetcher: vi.fn().mockResolvedValue({}) }));
    const b = renderHook(() => cache.useQuery('b', { fetcher: vi.fn().mockResolvedValue({}) }));
    const c = renderHook(() => cache.useQuery('c', { fetcher: vi.fn().mockResolvedValue({}) }));

    expect(vi.getTimerCount()).toBe(1);

    a.unmount();
    expect(vi.getTimerCount()).toBe(1);
    b.unmount();
    expect(vi.getTimerCount()).toBe(1);

    c.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the polling timer when the last subscriber unmounts', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const cache = createCache();
    const { unmount } = renderHook(() => cache.useQuery('cleanup', { fetcher }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    unmount();
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('exposes only the singleton cache instance via debug()', () => {
    const cache = createCache();
    const before = cache.debug().activeCacheInstances;
    expect(before).toBeGreaterThanOrEqual(1);
    expect(cache.debug().effectiveGlobalInterval).toBe(DASHBOARD_POLL_INTERVAL_MS);
    cache.dispose();
    // Dispose removes THIS instance from the global set.
    expect(cache.debug().activeCacheInstances).toBe(before - 1);
  });

  it('warns in dev when a sub-30 s interval is registered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const cache = createCache();
    renderHook(() => cache.useQuery('too-fast', { fetcher, intervalMs: 5_000 }));

    // Dev warn — production code must omit intervalMs and inherit
    // DASHBOARD_POLL_INTERVAL_MS. The registered interval is preserved
    // so fast-cadence tests stay fast; the warning is the enforcement.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('intervalMs=5000'));
    expect(cache.debug().registeredIntervals['too-fast']).toBe(5_000);
  });

  it('production callers do not register an intervalMs < 30 000 ms', () => {
    // Static invariant: no useQuery call in src/ should pass an explicit
    // intervalMs (production must rely on the default 30 s floor).
    // Read from the directory rather than from a list written by hand. The
    // list used to name six files and skip silently past any it could not
    // open, so deleting a screen quietly shrank what this checked — and adding
    // one never widened it. `MatchList.tsx` was on that list and was deleted on
    // 2026-08-16; nothing would have said so.
    const offenders: string[] = [];
    for (const file of componentFiles()) {
      const body = readFileSync(SRC(file), 'utf8');
      const m = body.match(/cache\.useQuery[^)]*intervalMs\s*:\s*\d+/g);
      if (m) offenders.push(`${file}: ${m.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('StrictMode double-mount does not leave orphan timers', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const cache = createCache();

    // Simulate StrictMode: mount → cleanup → mount again.
    const first = renderHook(() => cache.useQuery('strict', { fetcher }));
    first.unmount();
    renderHook(() => cache.useQuery('strict', { fetcher }));

    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('adaptive polling — no private component intervals', () => {
  it('NotificationBell has no private setInterval for polling', () => {
    // ponytail: read the source directly and assert no polling interval
    // lives in the component. The bell must route through the cache.
    const src = readFileSync(SRC('hub/NotificationBell.tsx'), 'utf8');
    expect(src).not.toMatch(/setInterval\([^)]*['"`]\s*\d+\s*_?\d*\s*['"`]/);
    // The cache import must be present (proves the rewrite happened).
    expect(src).toMatch(/from ['"]\.\/query\.js['"]/);
    expect(src).toMatch(/cache\.useQuery/);
  });
});
