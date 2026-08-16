import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

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
