import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

/**
 * How long a `waitFor` may wait before it calls the app broken.
 *
 * Testing Library's default is one second, and one second is a statement about
 * the MACHINE rather than about the code. `pnpm test` runs five packages, and
 * two of them drive a real Postgres; on a loaded laptop or a shared CI runner
 * the render these tests are waiting for finishes comfortably, just not inside
 * that budget.
 *
 * It cost two full-suite runs to place: on 2026-09-03 a different test in
 * `test/hub/device-modal.test.tsx` failed in each of them, and the file passed
 * three times in a row on its own. Both failures were `waitFor` calls, and
 * nothing about the component was slow — the same assertions pass in about 250
 * milliseconds when the file runs alone.
 *
 * Five seconds rather than a large number: a test that genuinely hangs should
 * still fail this decade, and a real regression that slows a render fivefold is
 * still caught. What this stops is the suite reporting a defect that is
 * actually a busy runner — which is worse than a slow test, because somebody
 * spends an afternoon looking for it.
 */
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
});

// happy-dom does not ship matchMedia. Stub a default that matches nothing;
// individual tests override window.matchMedia to control behavior.
{
  const make = (q: string) => ({
    matches: q.includes('min-width') && q.includes('1024'),

    media: q,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => make(query),
    });
  }
}

if (typeof navigator !== 'undefined') {
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
}

// Mirror production index.html. This used to force `ltr`, back when the payment
// hub had its own document; the merged panel is RTL, and the hub's screens sit
// inside a `dir="ltr"` island until they are translated. Setting the document
// to what production actually serves is the point — a test environment that
// disagrees with the page proves nothing about the page.
if (typeof document !== 'undefined') {
  document.documentElement.dir = 'rtl';
  document.documentElement.lang = 'fa';
}
