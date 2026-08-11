/**
 * URL-persisted table sort state.
 *
 * Each table gets a unique `key` (e.g. "today", "unmatched", "accounts").
 * Sort state is stored in the URL as `?sort_{key}=column:direction` so
 * links can be shared and a refresh restores the same view.
 *
 * No global state is shared across tables; each call owns one slot.
 *
 * Falls back to `{column: null, direction: 'asc'}` (the default) when the
 * URL is clean or has an invalid value.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SortDirection, SortState } from './sort.js';

const URL_PARAM = 'sort';
const VALID_DIRECTIONS: SortDirection[] = ['asc', 'desc'];

function readUrl(key: string): SortState<string> | null {
  if (typeof window === 'undefined') return null;
  const sp = new URLSearchParams(window.location.search);
  const raw = sp.get(`${URL_PARAM}_${key}`);
  if (!raw) return null;
  const [col, dir] = raw.split(':');
  if (!col) return null;
  const direction = VALID_DIRECTIONS.includes(dir as SortDirection)
    ? (dir as SortDirection)
    : 'asc';
  return { column: col, direction };
}

function writeUrl(key: string, state: SortState<string>): void {
  if (typeof window === 'undefined') return;
  const sp = new URLSearchParams(window.location.search);
  if (state.column) sp.set(`${URL_PARAM}_${key}`, `${state.column}:${state.direction}`);
  else sp.delete(`${URL_PARAM}_${key}`);
  // Use replaceState — no need to add a history entry per toggle.
  const url = `${window.location.pathname}${sp.toString() ? `?${sp}` : ''}`;
  window.history.replaceState(window.history.state, '', url);
}

export interface TableSortInit<C extends string> {
  column: C;
  direction: SortDirection;
}

/**
 * useTableSortState(key, defaultSort) → {state, setState}
 *
 *   key: identifier unique to this table instance ("today", "unmatched", ...)
 *   defaultSort: the polled default (often {column: "time", direction: "desc"}
 *                or similar). When the user unsets the sort, state falls back
 *                to this.
 *
 * `C` is the union of valid column literals (e.g. `'effective_ts' | 'amount_irr'`).
 * The state always exposes the column as `string | null` so generic consumers
 * (SortableHeader, sortBy) accept it without extra casts.
 */
export function useTableSortState<C extends string>(
  key: string,
  defaultSort: TableSortInit<C>,
): [SortState<string>, (next: SortState<string>) => void] {
  const initial = useMemo<SortState<string>>(() => {
    const fromUrl = readUrl(key);
    if (fromUrl && fromUrl.column) {
      return { column: fromUrl.column, direction: fromUrl.direction };
    }
    return { column: defaultSort.column, direction: defaultSort.direction };
  }, [key, defaultSort.column, defaultSort.direction]);

  const [state, setStateInternal] = useState<SortState<string>>(initial);

  // Listen for back/forward to keep state in sync with the URL.
  useEffect(() => {
    function onPop() {
      const fromUrl = readUrl(key);
      if (fromUrl && fromUrl.column) {
        setStateInternal({ column: fromUrl.column, direction: fromUrl.direction });
      } else {
        setStateInternal({ column: defaultSort.column, direction: defaultSort.direction });
      }
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [key, defaultSort.column, defaultSort.direction]);

  const setState = useCallback(
    (next: SortState<string>) => {
      const finalState: SortState<string> =
        next.column === null
          ? { column: defaultSort.column, direction: defaultSort.direction }
          : next;
      setStateInternal(finalState);
      // Persist whatever the user picked — null means reset to default.
      writeUrl(key, next.column === null ? { column: null, direction: 'asc' } : next);
    },
    [key, defaultSort.column, defaultSort.direction],
  );

  return [state, setState];
}
