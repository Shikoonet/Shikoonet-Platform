/**
 * Tests for the seen-id tracker and helpers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSeenTracker, diffIds } from '../src/query.js';

describe('useSeenTracker', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('returns all ids as new when seen set is empty', () => {
    const { result } = renderHook(() => useSeenTracker('k1', ['a', 'b', 'c']));
    expect(result.current.newIds).toEqual(['a', 'b', 'c']);
  });

  it('returns only new ids after markSeen', () => {
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => useSeenTracker('k2', ids),
      { initialProps: { ids: ['a', 'b', 'c'] } },
    );
    act(() => result.current.markSeen());
    rerender({ ids: ['a', 'b', 'c', 'd'] });
    expect(result.current.newIds).toEqual(['d']);
  });

  it('persists across mounts', () => {
    const { result, unmount } = renderHook(() => useSeenTracker('k3', ['x', 'y']));
    act(() => result.current.markSeen());
    unmount();
    const { result: r2 } = renderHook(() => useSeenTracker('k3', ['x', 'y', 'z']));
    expect(r2.current.newIds).toEqual(['z']);
  });

  it('diffIds computes symmetric difference', () => {
    expect(diffIds(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['d']);
    expect(diffIds([], ['a'])).toEqual(['a']);
    expect(diffIds(['a'], undefined)).toEqual([]);
  });
});
