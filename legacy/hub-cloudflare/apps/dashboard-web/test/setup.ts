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

// Mirror production index.html — dashboard is LTR (Persian content, left-to-right UI).
if (typeof document !== 'undefined') {
  document.documentElement.dir = 'ltr';
  document.documentElement.lang = 'fa';
}
