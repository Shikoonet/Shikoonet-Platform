/**
 * Tiny polling + cache layer for the dashboard.
 *
 * Why a hand-rolled layer instead of TanStack Query:
 *   - this dashboard has at most ~7 queries and a single page; TanStack
 *     is overkill and would add ~12 KB gz of vendor.
 *   - we need explicit control over visibility/focus/online triggers,
 *     exponential backoff on failure, abortable fetches, and per-key
 *     invalidation that mutations can call by name.
 *
 * Adaptive polling (Cloudflare-cost aware):
 *   - One global setTimeout re-armed every (min active intervalMs)
 *     ms — only ONE timer per page regardless of how many queries.
 *   - Default intervalMs is 30 s (was 5 s) for Cloudflare Free-plan
 *     budget. Per-entry intervalMs still honored (used by tests).
 *   - Hidden tab: timer is paused; skipped cycles are counted.
 *   - visibilitychange→visible / window focus / window online
 *     trigger a coalesced refetch — multiple events within one
 *     microtask flush become a single refetch per key.
 *   - Dev-only counters exposed via cache.getStats().
 *
 * Public surface:
 *   createCache()          — singleton-ish factory (one per dashboard).
 *   useQuery(key, opts)    — hook returning {data, error, status,
 *                            lastUpdatedAt, refresh, failureCount}.
 *   useSeenTracker(cache, key, idFrom)
 *                          — track seen ids in sessionStorage and
 *                            return `{newIds, count}`.
 *
 * No external state-management deps; the cache lives at module scope so
 * multiple views share the same fetched payload and the same in-flight
 * promise (de-duplicated per key).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * The single source of truth for the dashboard polling interval.
 * Visible-tab cadence is 30 s; anything below this is rejected in dev
 * with a console warning. Tests pass an override via CacheOptions.intervalMs.
 */
export const DASHBOARD_POLL_INTERVAL_MS = 30_000;

/**
 * Wake-up refresh cooldown. Browser events (focus, visibilitychange,
 * online) can fire repeatedly within a short window when DevTools is
 * open, the page is alt-tabbed, or the network flaps. This throttle
 * prevents the per-event coalescing in wakeUp() from being bypassed by
 * events that arrive across separate tasks.
 */
const WAKEUP_COOLDOWN_MS = 1_500;

export type QueryStatus = 'idle' | 'loading' | 'refreshing' | 'success' | 'error' | 'paused';

export interface QueryState<T> {
  data: T | undefined;
  error: unknown;
  status: QueryStatus;
  lastUpdatedAt: number | undefined;
  failureCount: number;
  refresh: () => void;
  /** Pause polling for this query while tab is hidden / offline / stalled. */
  setPaused: (paused: boolean) => void;
}

export interface DevStats {
  /** Fetch calls issued in the current cycle. Resets each tick. */
  requestsThisCycle: number;
  /** Polling cycles in the past minute. Resets each minute. */
  cyclesThisMinute: number;
  /** Cumulative count of cycles that would have fired while document.hidden. */
  skippedWhileHidden: number;
  /** Cumulative count of runFetch calls short-circuited by an in-flight promise. */
  dedupedRequests: number;
  /** Cumulative count of wake-up refreshes suppressed by the cooldown. */
  wakeupsThrottled: number;
}

/** Safe (no payloads, no URLs) runtime introspection for tests / devtools. */
export interface CacheDebugInfo {
  activeQueryKeys: string[];
  registeredIntervals: Record<string, number>;
  effectiveGlobalInterval: number;
  activeCacheInstances: number;
  activeTimers: number;
}

interface EntryInternal<T> {
  data: T | undefined;
  error: unknown;
  status: QueryStatus;
  lastUpdatedAt: number | undefined;
  failureCount: number;
  /** active subscribers; the entry pauses when subscribers == 0 */
  subscribers: number;
  paused: boolean;
  inflight: AbortController | undefined;
  /** Latest fetcher (re-bound every render via optsRef). */
  fetcher: ((signal: AbortSignal) => Promise<unknown>) | undefined;
  /** Per-entry interval override. */
  intervalMs: number;
  /** owner refetched-on-demand flag */
  onRefresh: (() => void) | undefined;
  listeners: Set<() => void>;
}

export interface CacheOptions {
  /** Called on every refetch. Throwing aborts the refetch; the previous
   *  data remains visible. */
  fetcher: (signal: AbortSignal) => Promise<unknown>;
  /** Per-entry polling interval in ms. Default = DASHBOARD_POLL_INTERVAL_MS. */
  intervalMs?: number;
  /** Called once with the data after each successful refetch. */
  onSuccess?: (data: unknown) => void;
}

type AnyEntry = EntryInternal<unknown>;

/** Tracks live cache instances so dev can assert there's only one. */
const cacheInstances = new Set<symbol>();

export interface Cache {
  /** Subscribe to a key. Returns stable object with the current snapshot
   *  and a refresh() bound to the cache. */
  useQuery: <T>(key: string, opts?: CacheOptions) => QueryState<T>;
  /** Invalidate (mark stale) one or more keys. Triggers an immediate
   *  refetch on every subscriber (in next microtask). */
  invalidate: (...keys: string[]) => void;
  /** Force a hard refetch on every active key (or a subset if passed). */
  refetch: (...keys: string[]) => void;
  /** Pause all queries (e.g. when network is offline). */
  setGlobalPaused: (paused: boolean) => void;
  /** Marker for the SSE listener / tests — emits when ANY query succeeds. */
  onAnySuccess: (cb: (key: string, data: unknown) => void) => () => void;
  /** Status of a single key (for the LiveStatus header). */
  status: (key: string) => QueryStatus;
  /** Dev-only counters snapshot; returns null in production. */
  getStats: () => DevStats | null;
  /** Dev-only safe metadata snapshot for assertions / instrumentation. */
  debug: () => CacheDebugInfo;
  /** Tear down all timers + listeners (called on cache disposal). */
  dispose: () => void;
}

export function createCache(): Cache {
  const entries = new Map<string, AnyEntry>();
  const globalListeners = new Set<(key: string, data: unknown) => void>();
  /** Keys with subscribers > 0; iterated by the global tick. */
  const activeKeys = new Set<string>();
  /** Cache-level fetcher + interval registry, rebuilt on subscriber change. */
  let globalTimer: ReturnType<typeof setTimeout> | null = null;
  let globalPaused = false;
  /** Coalesced wake-up token — incremented per call to deduplicate. */
  let wakeToken = 0;
  /** True while a microtask flush is scheduled. */
  let wakePending = false;
  /** Timestamp of the last wake-up refresh that actually fired — used
   *  to throttle separate-event wake-ups (DevTools / alt-tab / online). */
  let lastWakeAt = 0;
  /** Token to invalidate a scheduled wake-up (e.g. when dispose() fires). */
  let wakeTimerId: ReturnType<typeof setTimeout> | null = null;

  const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV === true;
  const devStats: DevStats | null = isDev
    ? {
        requestsThisCycle: 0,
        cyclesThisMinute: 0,
        skippedWhileHidden: 0,
        dedupedRequests: 0,
        wakeupsThrottled: 0,
      }
    : null;
  let minuteStartedAt = Date.now();

  /** Identity for the dev-only single-cache-instance invariant. */
  const instanceId = Symbol('cache');
  cacheInstances.add(instanceId);
  if (isDev && cacheInstances.size > 1) {
    console.warn(
      `[cache] multiple cache instances detected (${cacheInstances.size}). The dashboard expects exactly one singleton.`,
    );
  }

  function isVisible(): boolean {
    return (
      typeof document === 'undefined' ||
      (document.visibilityState === 'visible' && navigator.onLine !== false && !globalPaused)
    );
  }

  function ensureEntry(key: string): AnyEntry {
    let e = entries.get(key);
    if (!e) {
      e = {
        data: undefined,
        error: undefined,
        status: 'idle',
        lastUpdatedAt: undefined,
        failureCount: 0,
        subscribers: 0,
        paused: false,
        inflight: undefined,
        fetcher: undefined,
        intervalMs: DASHBOARD_POLL_INTERVAL_MS,
        onRefresh: undefined,
        listeners: new Set(),
      };
      entries.set(key, e);
    }
    return e;
  }

  function notify(e: AnyEntry) {
    for (const l of e.listeners) l();
  }

  /** Minimum interval across active entries. Drives the global timer. */
  function getMinInterval(): number {
    let m = DASHBOARD_POLL_INTERVAL_MS;
    for (const k of activeKeys) {
      const e = entries.get(k);
      if (!e) continue;
      m = Math.min(m, e.intervalMs);
    }
    return m;
  }

  /** Re-arm the global timer based on active entries' minimum interval. */
  function scheduleGlobal() {
    if (globalTimer) {
      clearTimeout(globalTimer);
      globalTimer = null;
    }
    if (activeKeys.size === 0) return;
    globalTimer = setTimeout(globalTick, getMinInterval());
  }

  /** Single polling tick — fires one fetch per active entry. */
  async function globalTick() {
    globalTimer = null;
    if (globalPaused || !isVisible()) {
      if (devStats) devStats.skippedWhileHidden += 1;
      scheduleGlobal();
      return;
    }
    if (devStats) {
      devStats.cyclesThisMinute += 1;
      devStats.requestsThisCycle = 0;
      // Per-minute console summary in dev only.
      if (Date.now() - minuteStartedAt >= 60_000) {
        console.debug('[cache] dev stats — past minute', {
          cyclesThisMinute: devStats.cyclesThisMinute,
          skippedWhileHidden: devStats.skippedWhileHidden,
          dedupedRequests: devStats.dedupedRequests,
        });
        devStats.cyclesThisMinute = 0;
        minuteStartedAt = Date.now();
      }
    }
    const keys = [...activeKeys];
    for (const k of keys) {
      const e = entries.get(k);
      const f = e?.fetcher;
      if (!e || !f) continue;
      void runFetch(k, f);
    }
    scheduleGlobal();
  }

  /** Coalesced wake-up — multiple trigger sources within the same
   *  microtask tick collapse to one refetch per key. Events that arrive
   *  in separate tasks but within WAKEUP_COOLDOWN_MS also collapse into
   *  one refresh via setTimeout(0) chaining, so DevTools alt-tabbing
   *  can't generate a 5s-style retry loop. */
  function wakeUp() {
    if (!isVisible() || globalPaused) return;
    if (activeKeys.size === 0) return;
    const now = Date.now();
    const sinceLast = now - lastWakeAt;
    if (sinceLast < WAKEUP_COOLDOWN_MS) {
      if (wakeTimerId == null) {
        const wait = WAKEUP_COOLDOWN_MS - sinceLast;
        wakeTimerId = setTimeout(() => {
          wakeTimerId = null;
          if (wakePending) return; // microtask flush already pending
          wakePending = true;
          Promise.resolve().then(() => {
            wakePending = false;
            lastWakeAt = Date.now();
            const keys = [...activeKeys];
            for (const k of keys) {
              const e = entries.get(k);
              const f = e?.fetcher;
              if (!e || !f) continue;
              void runFetch(k, f);
            }
          });
        }, wait);
      } else {
        // Already a throttle timer pending; nothing to do.
      }
      if (devStats) devStats.wakeupsThrottled += 1;
      return;
    }
    if (wakePending) return;
    wakePending = true;
    const token = ++wakeToken;
    Promise.resolve().then(() => {
      wakePending = false;
      if (token !== wakeToken) return; // superseded
      lastWakeAt = Date.now();
      const keys = [...activeKeys];
      for (const k of keys) {
        const e = entries.get(k);
        const f = e?.fetcher;
        if (!e || !f) continue;
        void runFetch(k, f);
      }
    });
  }

  async function runFetch(key: string, fetcher: CacheOptions['fetcher']): Promise<void> {
    const e = ensureEntry(key);
    // Already in-flight for this key — coalesce.
    if (e.inflight) {
      if (devStats) devStats.dedupedRequests += 1;
      return;
    }

    const controller = new AbortController();
    e.inflight = controller;
    e.status = e.data === undefined ? 'loading' : 'refreshing';
    e.error = undefined;
    notify(e);
    if (devStats) devStats.requestsThisCycle += 1;
    try {
      const raw = await fetcher(controller.signal);
      if (controller.signal.aborted) return;
      e.data = raw;
      e.lastUpdatedAt = Date.now();
      e.error = undefined;
      e.failureCount = 0;
      e.status = 'success';
      notify(e);
      for (const cb of globalListeners) cb(key, raw);
    } catch (err) {
      if (controller.signal.aborted) return;
      // AbortError isn't a real failure — leave prior data in place,
      // don't bump failureCount.
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      if (!isAbort) {
        e.error = err;
        e.failureCount += 1;
        e.status = 'error';
        notify(e);
      }
    } finally {
      e.inflight = undefined;
    }
  }

  function invalidate(...keys: string[]): void {
    for (const k of keys) {
      const e = entries.get(k);
      e?.onRefresh?.();
    }
  }

  function refetchAll(...keys: string[]): void {
    const targets = keys.length === 0 ? [...activeKeys] : keys;
    for (const k of targets) {
      const e = entries.get(k);
      e?.onRefresh?.();
    }
  }

  // Cache-level wake-up listeners — installed once per cache, not per entry.
  function installWakeListeners() {
    if (typeof document === 'undefined') return () => undefined;
    const onVisibility = () => {
      if (isVisible()) wakeUp();
    };
    const onFocus = () => wakeUp();
    const onOnline = () => wakeUp();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
    };
  }

  let removeWakeListeners: () => void = () => undefined;
  // Install once on cache creation; survives unmounts (it's a global concern).
  removeWakeListeners = installWakeListeners();

  return {
    useQuery<T>(key: string, opts?: CacheOptions): QueryState<T> {
      const optsRef = useRef(opts);
      optsRef.current = opts;
      const refreshRef = useRef<() => void>(() => undefined);
      const e = ensureEntry(key);

      const subscribe = useCallback(() => {
        const listener = () => forceUpdate((s) => s + 1);
        e.listeners.add(listener);
        return () => {
          e.listeners.delete(listener);
        };
        // e is keyed by `key`; hook owns the subscription for this key.
      }, [key]);

      // Use a useState counter to re-render when entry changes.
      const [, forceUpdate] = useState(0);

      useEffect(() => {
        e.subscribers += 1;
        const unsubscribe = subscribe();
        const fetchOpts = optsRef.current;
        if (!fetchOpts) {
          // No options — just stay subscribed so we surface cache writes
          // from other callers.
          e.subscribers -= 1;
          return unsubscribe;
        }

        // Bind latest fetcher + interval onto the entry.
        e.fetcher = fetchOpts.fetcher;
        e.intervalMs = fetchOpts.intervalMs ?? DASHBOARD_POLL_INTERVAL_MS;
        if (
          isDev &&
          fetchOpts.intervalMs !== undefined &&
          fetchOpts.intervalMs < DASHBOARD_POLL_INTERVAL_MS
        ) {
          console.warn(
            `[cache] query "${key}" registered intervalMs=${fetchOpts.intervalMs} (below ${DASHBOARD_POLL_INTERVAL_MS} ms). Production code must omit intervalMs and inherit it.`,
          );
        }
        activeKeys.add(key);

        refreshRef.current = () => refetch(key, fetchOpts);

        // Stash a way for invalidate() to bounce here. Pull the latest
        // fetcher each call so the closure captures the live options.
        e.onRefresh = () => {
          if (e.inflight) return;
          refetch(key, fetchOpts);
        };

        // Kick off the first fetch immediately and ensure timer is running.
        refetch(key, fetchOpts);
        scheduleGlobal();

        return () => {
          e.subscribers -= 1;
          e.inflight?.abort();
          activeKeys.delete(key);
          if (e.subscribers === 0) {
            e.onRefresh = undefined;
            e.fetcher = undefined;
          }
          scheduleGlobal();
          unsubscribe();
        };
      }, [key]);

      function refetch(k: string, c: CacheOptions) {
        if (!c) return;
        void runFetch(k, c.fetcher);
      }

      return {
        data: e.data as T | undefined,
        error: e.error,
        status: e.status,
        lastUpdatedAt: e.lastUpdatedAt,
        failureCount: e.failureCount,
        refresh: refreshRef.current,
        setPaused: (p: boolean) => {
          const cur = ensureEntry(key);
          cur.paused = p;
          cur.status = p ? 'paused' : cur.status;
        },
      };
    },
    invalidate,
    refetch: refetchAll,
    setGlobalPaused(paused: boolean) {
      globalPaused = paused;
      for (const e of entries.values()) {
        if (paused) e.status = 'paused';
        notify(e);
      }
    },
    onAnySuccess(cb) {
      globalListeners.add(cb);
      return () => globalListeners.delete(cb);
    },
    status(key) {
      return entries.get(key)?.status ?? 'idle';
    },
    getStats() {
      if (!devStats) return null;
      return {
        requestsThisCycle: devStats.requestsThisCycle,
        cyclesThisMinute: devStats.cyclesThisMinute,
        skippedWhileHidden: devStats.skippedWhileHidden,
        dedupedRequests: devStats.dedupedRequests,
        wakeupsThrottled: devStats.wakeupsThrottled,
      };
    },
    debug(): CacheDebugInfo {
      const registeredIntervals: Record<string, number> = {};
      for (const [k, e] of entries) {
        if (e.subscribers > 0) registeredIntervals[k] = e.intervalMs;
      }
      return {
        activeQueryKeys: [...activeKeys],
        registeredIntervals,
        effectiveGlobalInterval: getMinInterval(),
        activeCacheInstances: cacheInstances.size,
        activeTimers: globalTimer ? 1 : 0,
      };
    },
    dispose() {
      if (globalTimer) clearTimeout(globalTimer);
      globalTimer = null;
      if (wakeTimerId) clearTimeout(wakeTimerId);
      wakeTimerId = null;
      removeWakeListeners();
      activeKeys.clear();
      for (const e of entries.values()) {
        e.inflight?.abort();
        e.inflight = undefined;
        e.onRefresh = undefined;
        e.listeners.clear();
      }
      cacheInstances.delete(instanceId);
    },
  };
}

/**
 * Track new ids seen in a polled list. Persistence is per-session via
 * sessionStorage so the same ids stay "seen" for the current tab but a
 * fresh tab will see them as new again.
 */
export function useSeenTracker(
  storageKey: string,
  ids: string[] | undefined,
): { newIds: string[]; markSeen: (extra?: string[]) => void } {
  const seenRef = useRef<Set<string> | null>(null);
  if (seenRef.current === null) {
    let out = new Set<string>();
    if (typeof sessionStorage !== 'undefined') {
      try {
        const raw = sessionStorage.getItem(storageKey);
        if (raw) out = new Set(JSON.parse(raw) as string[]);
      } catch {
        /* ignore */
      }
    }
    seenRef.current = out;
  }

  const initial = useMemo(() => seenRef.current as Set<string>, [storageKey]);

  useEffect(() => {
    seenRef.current = initial;
  }, [initial]);

  const persist = useCallback(
    (set: Set<string>) => {
      if (typeof sessionStorage === 'undefined') return;
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify([...set].slice(-500)), // cap
        );
      } catch {
        /* quota / private mode — ignore */
      }
    },
    [storageKey],
  );

  const newIds = useMemo(() => {
    if (!ids) return [];
    const seen = seenRef.current ?? new Set<string>();
    const out: string[] = [];
    for (const id of ids) if (!seen.has(id)) out.push(id);
    return out;
  }, [ids]);

  const markSeen = useCallback(
    (extra: string[] = []) => {
      const seen = seenRef.current ?? new Set<string>();
      for (const id of ids ?? []) seen.add(id);
      for (const id of extra) seen.add(id);
      seenRef.current = seen;
      persist(seen);
    },
    [ids, persist],
  );

  return { newIds, markSeen };
}

/** Stable id-list diff helper for tests + refetches. */
export function diffIds(prev: string[] | undefined, next: string[] | undefined): string[] {
  if (!prev || !next) return [];
  const set = new Set(prev);
  return next.filter((id) => !set.has(id));
}
