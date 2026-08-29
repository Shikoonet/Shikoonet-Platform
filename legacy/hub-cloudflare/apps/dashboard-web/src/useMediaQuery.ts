/** Tiny matchMedia hook: returns true / false based on the current
 *  viewport matching the given CSS media query. */
import { useEffect, useState } from 'react';

function safeMatchMedia(query: string): boolean {
  if (typeof window === 'undefined') return false;
  const mq = window.matchMedia;
  if (typeof mq !== 'function') return false;
  try {
    return mq.call(window, query).matches;
  } catch {
    return false;
  }
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => safeMatchMedia(query));
  useEffect(() => {
    const get = () => safeMatchMedia(query);
    setMatches(get());
    const mq = typeof window !== 'undefined' ? window.matchMedia?.(query) : undefined;
    if (!mq || typeof mq.addEventListener !== 'function') return;
    const onChange = () => setMatches(get());
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
