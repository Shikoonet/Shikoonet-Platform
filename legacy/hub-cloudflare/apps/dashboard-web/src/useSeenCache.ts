/**
 * useSeenCache — per-actor, server-synced overlay for the dashboard's
 * "is this transaction NEW?" judgement.
 *
 * Two layers decide whether a row shows the NEW badge:
 *
 *   1. The server computes `is_new` per row in the list endpoints
 *      (`GET /api/v1/today` etc.) using the actor's cursor + per-row
 *      reads. Authoritative on every poll.
 *
 *   2. The client overlays optimistic dismissals — when the user marks
 *      one row seen, the badge disappears IMMEDIATELY without waiting
 *      for the next server poll. The overlay is hydrated from
 *      `GET /api/v1/notifications/seen-ids` so it survives reloads
 *      and is shared across browsers logged in as the same Access user.
 *
 * This hook is intentionally tiny: it returns
 *   `{ seenIds: Set<string>, markSeen(id): Promise<void> }`.
 * `markSeen` does the optimistic local update, fires the POST, and rolls
 * back the local update if the POST fails. It also invalidates the
 * server-side cache key so a future refetch re-converges with the
 * server's view.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import type { Cache } from './query.js';
import { QK } from './queries.js';

interface SeenCacheState {
  seenIds: Set<string>;
  loaded: boolean;
}

const stateByCache = new WeakMap<Cache, SeenCacheState>();

function getState(cache: Cache): SeenCacheState {
  let s = stateByCache.get(cache);
  if (!s) {
    s = { seenIds: new Set(), loaded: false };
    stateByCache.set(cache, s);
  }
  return s;
}

export function useSeenCache(cache: Cache): {
  seenIds: Set<string>;
  loaded: boolean;
  markSeen: (id: string) => Promise<void>;
} {
  const [, force] = useState(0);
  const rerender = useCallback(() => force((n) => n + 1), []);

  // Hydrate from the server once on mount. Subsequent invalidations are
  // triggered by mutations (markSeen invalidates SEEN_IDS).
  useEffect(() => {
    const s = getState(cache);
    if (s.loaded) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.notificationsSeenIds();
        if (cancelled) return;
        for (const id of Object.keys(r.seen_at_by_id)) s.seenIds.add(id);
        s.loaded = true;
        rerender();
      } catch {
        // Silent — the list endpoints still carry server-side is_new.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cache, rerender]);

  const markSeen = useCallback(
    async (id: string) => {
      const s = getState(cache);
      if (s.seenIds.has(id)) return;
      const prev = s.seenIds.has(id);
      s.seenIds.add(id);
      rerender();
      try {
        await api.markTransactionSeen(id);
        cache.invalidate(QK.seenIds);
      } catch {
        // Roll back on failure.
        if (!prev) s.seenIds.delete(id);
        rerender();
      }
    },
    [cache, rerender],
  );

  const s = getState(cache);
  return { seenIds: s.seenIds, loaded: s.loaded, markSeen };
}
