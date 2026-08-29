/**
 * No request may carry the string «undefined» as a value.
 *
 * `String(undefined)` is `"undefined"` — a perfectly valid seven-character
 * query value that `z.coerce.number()` turns into NaN, so the server answers
 * `invalid_query` and the screen draws that code where content should be. On
 * 2026-08-29 the category screen showed exactly that, from `api.catalog()`
 * called without `page` by the tier-layout editor. Proven against the running
 * staging dashboard before this test was written:
 *
 *   ?page=undefined&pageSize=20&categoryId=2  ->  400 {"error":"invalid_query"}
 *   ?pageSize=20&categoryId=2                 ->  200, items=1
 *
 * The first test is that bug. The second is the shape that allowed it: this
 * sweeps every list method, so the next optional parameter someone stringifies
 * unconditionally fails here instead of in a browser. `products()` already
 * carried a `?? 1` — the same fault, fixed at one call site, which is why it
 * came back somewhere else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api.js';

let urls: string[] = [];

beforeEach(() => {
  urls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, items: [], total: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

/** Every value actually put on the wire, decoded. */
const values = (url: string) => [...new URL(url, 'http://x').searchParams.values()];

describe('list requests', () => {
  it('sends page=1, not page=undefined, when the caller omits it', async () => {
    // Exactly the call `ArrangeTiers` makes: a category, a size, no page.
    await api.catalog({ categoryId: 2, pageSize: 20 });

    const qs = new URL(urls[0]!, 'http://x').searchParams;
    expect(qs.get('page')).toBe('1');
    expect(qs.get('pageSize')).toBe('20');
    expect(qs.get('categoryId')).toBe('2');
  });

  it('never puts the string «undefined» on the wire, from any list method', async () => {
    // Called the way a screen calls them — some with a page, some without —
    // because it is the omission that produces the bug.
    await api.catalog({ categoryId: 2, pageSize: 20 });
    await api.catalog({ page: 2, pageSize: 20, q: 'x' });
    await api.customers({ page: 1, pageSize: 25 });
    await api.stock({ page: 1, pageSize: 25 });
    await api.events({ page: 1, pageSize: 25 });
    await api.discounts({ page: 1, pageSize: 25 });
    await api.orders({ page: 1, pageSize: 25 });
    await api.subscriptions({ page: 1, pageSize: 25 });
    await api.walletEntries({ page: 1, pageSize: 25 });

    expect(urls.length).toBeGreaterThan(8);
    for (const url of urls) {
      expect(values(url), url).not.toContain('undefined');
      expect(values(url), url).not.toContain('null');
      expect(values(url), url).not.toContain('NaN');
    }
  });
});
