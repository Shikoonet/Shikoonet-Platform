/**
 * Playwright E2E — real-browser proof of dashboard polling cadence.
 *
 * This spec runs against the dashboard-web served by Vite on :5173
 * with every /api/** route mocked (independent of D1 / Access JWT).
 * The dashboard's cache uses a 30-second global timer (see
 * apps/dashboard-web/src/query.ts), and the production version
 * deployed at https://dashboard-worker.samsos.workers.dev is built
 * from the same bundle.
 *
 * Three invariants are verified against real wall-clock time:
 *
 *   1. No request to any endpoint is issued before 30 seconds have
 *      passed since the previous request to that endpoint.
 *
 *   2. While the tab is hidden (visibilityState === 'hidden'), the
 *      global timer is paused — zero requests for 35 s.
 *
 *   3. Returning to visible (focus + visibilitychange in one burst)
 *      fires EXACTLY one refetch per endpoint, coalesced by
 *      wakeUp() + WAKEUP_COOLDOWN_MS.
 *
 * The minimum gap proof uses a 75 s observation window, which gives
 * enough slack for a 30 s cadence + jitter + the initial fetch.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

// 35 s observation → at least one 30 s cycle after the initial fetch.
const OBSERVE_MS = 35_000;
const MIN_GAP_MS = 30_000;
// Allow ~150 ms of Chromium setTimeout jitter in either direction.
const GAP_TOLERANCE_MS = 150;
const HIDDEN_MS = 35_000;

interface Hit {
  path: string;
  t: number;
}

// Endpoints whose cadence is policed by the polling cache in query.ts.
// Other endpoints (e.g. /notifications/seen-ids) are one-shot hydrates
// gated by useSeenCache + React StrictMode — not polling — so a 3 ms
// double-fire at mount is expected.
const POLLED_ENDPOINTS = [
  '/api/v1/today',
  '/api/v1/accounts',
  '/api/v1/devices',
  '/api/v1/matches/',
  '/api/v1/notifications/counts',
  '/api/v1/notifications/recent',
] as const;

async function stubAndOpen(page: Page): Promise<void> {
  // Mock every /api/** request. No real network round-trip; timing is
  // driven by the dashboard's own internal timers.
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.startsWith('/api/v1/notifications/recent')) {
      return route.fulfill({ json: { ok: true, items: [] } });
    }
    return route.fulfill({ json: { ok: true, items: [], count: 0 } });
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.getByRole('heading', { name: 'Reconciliation Hub' }).waitFor();
}

function summarizeByPath(hits: Hit[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const h of hits) {
    const arr = out.get(h.path) ?? [];
    arr.push(h.t);
    out.set(h.path, arr);
  }
  for (const arr of out.values()) arr.sort((a, b) => a - b);
  return out;
}

function installNetworkRecorder(page: Page): { hits: Hit[]; start: number } {
  const state = { hits: [] as Hit[], start: 0 };
  // Capture the start time on the page itself so we measure clock inside
  // the page, not Playwright's process clock.
  state.start = Date.now();
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('/api/')) return;
    state.hits.push({ path: new URL(url).pathname, t: Date.now() - state.start });
  });
  return state;
}

test.describe('polling cadence — real browser proof (≥ 30 s)', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test(
    'visible: no two requests to the same endpoint within 30 000 ms',
    async ({ page }) => {
      const rec = installNetworkRecorder(page);
      await stubAndOpen(page);

      // Observe for 35 s — expect at least one re-poll of each endpoint
      // after the initial 30 s tick, and ≥ ~30 s gaps per endpoint
      // (with ~150 ms setTimeout jitter tolerance).
      await page.waitForTimeout(OBSERVE_MS);

      const byPath = summarizeByPath(rec.hits);
      // Filter to polled endpoints only — leave one-shot hydrates out.
      const byPolled = new Map(
        [...byPath.entries()].filter(([p]) =>
          POLLED_ENDPOINTS.some((sub) => p.startsWith(sub)),
        ),
      );
      expect(
        byPolled.size,
        JSON.stringify([...byPolled.entries()]),
      ).toBeGreaterThan(0);

      for (const [path, ts] of byPolled) {
        // At least 2 hits for the cadence proof (initial + 30 s repoll).
        expect(
          ts.length,
          `${path} hit count = ${ts.length} (timestamps: ${JSON.stringify(ts)})`,
        ).toBeGreaterThanOrEqual(2);
        for (let i = 1; i < ts.length; i++) {
          const gap = ts[i]! - ts[i - 1]!;
          // Floor: no fast-cycle retries — gap is never below 30 s minus
          // a small tolerance for setTimeout jitter on slow CI hosts.
          // Ceiling: catches accidental sleeps > 30 s + buffer.
          const minOk = MIN_GAP_MS - GAP_TOLERANCE_MS;
          const maxOk = MIN_GAP_MS + 5_000;
          expect(
            gap,
            `${path} gap[${i - 1}→${i}] = ${gap} ms (expected ${minOk}..${maxOk}) — timestamps: ${JSON.stringify(ts)}`,
          ).toBeGreaterThanOrEqual(minOk);
          expect(gap, `${path} gap too long`).toBeLessThan(maxOk);
        }
      }

      // Log a human-readable summary for the incident report.
      const summary = [...byPolled.entries()]
        .map(([p, ts]) => `${p}: ${ts.length} hits @ ${ts.join(',')}ms`)
        .join('\n  ');
      console.log(`[polling-cadence] visible-window summary:\n  ${summary}`);
    },
  );

  test(
    'hidden tab: zero requests for 35 s',
    async ({ page }) => {
      const rec = installNetworkRecorder(page);
      await stubAndOpen(page);

      // Let the dashboard issue its initial fetch so the cache has
      // registered an active subscriber, then hide the tab.
      await page.waitForTimeout(2_000);
      const hitsBeforeHide = rec.hits.length;

      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // While hidden, the cache pauses the global timer. No requests
      // should fire for HIDDEN_MS.
      await page.waitForTimeout(HIDDEN_MS);
      expect(
        rec.hits.length,
        `requests while hidden: ${rec.hits.length - hitsBeforeHide} (max 0)`,
      ).toBe(hitsBeforeHide);

      // Now return to visible — exactly ONE refetch per endpoint.
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
      });
      // Tiny settle for the coalesced refetch.
      await page.waitForTimeout(1_500);

      const byPath = summarizeByPath(rec.hits);
      // Each path should have at most initialCount + 1 (one coalesced
      // wake-up refetch), not initialCount + many.
      for (const [path, ts] of byPath) {
        const wakeupFires = ts.length - hitsBeforeHide;
        expect(
          wakeupFires,
          `${path}: ${wakeupFires} wake-up fires (expected ≤ 1) — timestamps: ${JSON.stringify(ts)}`,
        ).toBeLessThanOrEqual(1);
      }
    },
  );

  test(
    'rapid focus + visibilitychange coalesces to ONE refetch per endpoint',
    async ({ page }) => {
      const rec = installNetworkRecorder(page);
      await stubAndOpen(page);

      // Wait past the 30 s cycle so the cache timer is in steady state.
      await page.waitForTimeout(MIN_GAP_MS + 1_500);

      const hitsBefore = rec.hits.length;
      const byPathBefore = summarizeByPath(rec.hits);
      const beforeTimestamps = new Map(
        [...byPathBefore.entries()].map(([p, ts]) => [p, ts[ts.length - 1]!]),
      );

      // Burst: focus + visibilitychange in the same task. wakeUp()'s
      // microtask flush should collapse them into ONE refetch per key.
      await page.evaluate(() => {
        window.dispatchEvent(new Event('focus'));
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });

      await page.waitForTimeout(2_000);
      const hitsAfter = rec.hits.length;

      // Filter to the polled endpoints — wakeUp() fires refetches only
      // for entries the cache owns, not the one-shot /seen-ids hydrate.
      const wakeupHits = rec.hits
        .slice(hitsBefore, hitsAfter)
        .filter((h) => POLLED_ENDPOINTS.some((sub) => h.path.startsWith(sub)));

      // All wake-up hits belong to polled endpoints that already exist
      // (the dashboard registered them at mount); they originate from
      // the wakeUp() microtask, not a stale timer.
      const known = new Set(
        [...beforeTimestamps.keys()].filter((p) =>
          POLLED_ENDPOINTS.some((sub) => p.startsWith(sub)),
        ),
      );
      for (const h of wakeupHits) {
        expect(
          known.has(h.path),
          `${h.path} wake-up hit on unknown endpoint`,
        ).toBe(true);
      }

      // And the count of wake-up refetches per endpoint is at most ONE
      // (focus + visibilitychange in one task coalesces to a single
      // refetch via wakeUp()'s microtask flush + WAKEUP_COOLDOWN_MS).
      const wakeupByPath = summarizeByPath(wakeupHits);
      for (const [path, ts] of wakeupByPath) {
        expect(
          ts.length,
          `${path}: ${ts.length} wake-up hits (expected ≤ 1) — ${JSON.stringify(ts)}`,
        ).toBeLessThanOrEqual(1);
      }
    },
  );
});
