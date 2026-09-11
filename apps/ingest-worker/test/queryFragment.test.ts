/**
 * The query string stops at the `#`, and this is measured rather than assumed.
 *
 * `hono` was pinned at `4.13.3`, inside the advisory range of GHSA-crvj-82cr-hjcx
 * — «Query parser reads parameters after the URL fragment, causing cache-key and
 * proxy interpretation differentials». On that version, asked for
 * `/x#?admin=1`, hono answered `admin=1`: a URL with **no query string at all**
 * by every other reader's rules.
 *
 * That is not academic here. This process is the only public surface we have,
 * and nothing reaches it directly — a Cloudflare tunnel and the `:9443` edge
 * both sit in front, both split the URL themselves, and both would have read
 * that request as having no parameters while the app read one. PR #142
 * (`fix/temp-domain-fragment-bypass`) is this same family of bug, already met
 * once.
 *
 * Measured on both versions before this test was written:
 *
 *   4.13.3   /x?a=1#&admin=1  ->  {a: '1#', admin: '1'}   /x#?admin=1  ->  {admin: '1'}
 *   4.13.7   /x?a=1#&admin=1  ->  {a: '1'}                /x#?admin=1  ->  {}
 *
 * So this file is red on the version we shipped and green on the version we
 * pinned — the point of writing it. It asks the parser, not the version string:
 * a lockfile that says `4.13.7` and a parser that behaves like `4.13.3` would
 * still fail here, and that is the only claim worth making.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

const app = new Hono().get('/x', (c) => c.json(c.req.query()));

const queryOf = async (url: string): Promise<Record<string, string>> =>
  (await (await app.request(url)).json()) as Record<string, string>;

describe('the query parser and the URL fragment', () => {
  it('reads nothing from a URL whose parameters are all after the #', async () => {
    // A proxy in front of us sees no query string here at all.
    expect(await queryOf('http://h/x#?admin=1')).toEqual({});
  });

  it('stops at the # rather than reading through it', async () => {
    expect(await queryOf('http://h/x?a=1#&admin=1')).toEqual({ a: '1' });
  });

  it('still reads an ordinary query string', async () => {
    // Without this the two above pass on a parser that reads nothing at all.
    expect(await queryOf('http://h/x?a=1&admin=1')).toEqual({ a: '1', admin: '1' });
  });
});
