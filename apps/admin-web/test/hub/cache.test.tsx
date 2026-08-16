/**
 * Tests for the polling cache. We use real timers with very short
 * intervalMs so the cache runs in real time. This avoids the
 * microtask/fake-timer interactions that make deterministic timing
 * tests brittle.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createCache } from '../../src/hub/query.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('polling cache', () => {
  it('fetches on mount and exposes data', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, items: [1, 2, 3] });
    const cache = createCache();
    const { result } = renderHook(() =>
      cache.useQuery<{ ok: boolean; items: number[] }>('test', { fetcher }),
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.items).toEqual([1, 2, 3]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent fetches for the same key', async () => {
    let resolveFetch: (v: unknown) => void = () => undefined;
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          resolveFetch = r;
        }),
    );
    const cache = createCache();
    const a = renderHook(() => cache.useQuery('dup', { fetcher }));
    const b = renderHook(() => cache.useQuery('dup', { fetcher }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    resolveFetch({ ok: true });
    await waitFor(() => {
      expect(a.result.current.data).toBeDefined();
      expect(b.result.current.data).toBeDefined();
    });
  });

  it('polls again after intervalMs', async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    const cache = createCache();
    renderHook(() => cache.useQuery('poll', { fetcher, intervalMs: 30 }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 500,
    });
  });

  it('transitions to error status on failure', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('503'));
    const cache = createCache();
    const { result } = renderHook(() => cache.useQuery('err', { fetcher, intervalMs: 30 }));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBeDefined();
  });

  it('increases failureCount on persistent failures', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('boom'));
    const cache = createCache();
    const { result } = renderHook(() => cache.useQuery('fail', { fetcher, intervalMs: 30 }));
    await waitFor(() => expect(result.current.failureCount).toBeGreaterThanOrEqual(1));
  });

  it('invalidates affected keys', async () => {
    const fetcher = vi.fn().mockResolvedValue({});
    const cache = createCache();
    renderHook(() => cache.useQuery('a', { fetcher, intervalMs: 30 }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    cache.invalidate('a');
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('refetch() with no args rebounces all active keys', async () => {
    const a = vi.fn().mockResolvedValue({});
    const b = vi.fn().mockResolvedValue({});
    const cache = createCache();
    renderHook(() => cache.useQuery('a', { fetcher: a, intervalMs: 30 }));
    renderHook(() => cache.useQuery('b', { fetcher: b, intervalMs: 30 }));
    await waitFor(() => expect(a).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(b).toHaveBeenCalledTimes(1));
    cache.refetch();
    await waitFor(() => expect(a.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(b.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('fires onAnySuccess for every successful refetch', async () => {
    const fetcher = vi.fn().mockResolvedValue({ v: 1 });
    const cache = createCache();
    const onAny = vi.fn();
    cache.onAnySuccess(onAny);
    renderHook(() => cache.useQuery('success', { fetcher, intervalMs: 30 }));
    await waitFor(() => expect(onAny).toHaveBeenCalledWith('success', { v: 1 }));
  });

  it('treats AbortError as a non-error', async () => {
    const fetcher = vi.fn().mockImplementation(
      (_: AbortSignal) =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 5);
        }),
    );
    const cache = createCache();
    const { result } = renderHook(() => cache.useQuery('abort', { fetcher }));
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    await waitFor(() => expect(result.current.status).not.toBe('error'), { timeout: 200 });
  });

  it('keeps prior data on a failed refetch', async () => {
    let first = true;
    const fetcher = vi.fn().mockImplementation(async () => {
      if (first) {
        first = false;
        return { v: 1 };
      }
      throw new Error('503');
    });
    const cache = createCache();
    const { result } = renderHook(() => cache.useQuery('keep', { fetcher, intervalMs: 30 }));
    await waitFor(() => expect(result.current.data).toBeDefined());
    await waitFor(() => expect(result.current.status).toBe('error'));
    // The previous data must still be visible.
    expect(result.current.data).toBeDefined();
  });
});
