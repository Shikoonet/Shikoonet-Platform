/**
 * `GET /api/v1/brand` — the one thing the page needs before anybody signs in.
 *
 * Two claims are worth testing here and neither is about the string:
 *
 *   * it answers **without a session**, because the sign-in card draws this
 *     name and a route behind the gate could never reach it;
 *   * it is read from the SERVER's environment, so one bundle can carry every
 *     installation. That is the whole reason this is not a `VITE_*` variable.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';
import { DEFAULT_BRAND_NAME } from '@shikoo/contracts';

beforeAll(async () => {
  await applySchema();
});

/** Deliberately without `TEST_ACCESS_USER`: nobody is signed in. */
function anonymous(overrides: Record<string, unknown> = {}) {
  const { TEST_ACCESS_USER: _skip, ...rest } = baseEnv as unknown as Record<string, unknown>;
  return { ...rest, ...overrides };
}

async function ask(env: Record<string, unknown>) {
  const res = await app.request('/api/v1/brand', {}, env);
  return { status: res.status, body: (await res.json()) as { ok: boolean; name: string } };
}

describe('whose panel this is', () => {
  it('answers a caller with no session at all', async () => {
    // The sign-in card is drawn before there is one. A 401 here would mean a
    // reseller's front door reads our name, which is the entire bug.
    const res = await ask(anonymous({ BRAND_NAME: 'نماینده‌نت' }));
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('نماینده‌نت');
  });

  it('reads the name the server was started with, not one the caller sends', async () => {
    // Asserted by sending a caller-supplied name and getting the server's back.
    // A route that echoed a query parameter would be a page anybody could
    // rebrand from a link.
    const res = await app.request(
      '/api/v1/brand?name=whatever',
      {},
      anonymous({ BRAND_NAME: 'نماینده‌نت' }),
    );
    expect(((await res.json()) as { name: string }).name).toBe('نماینده‌نت');
  });

  it('is ours when nothing is set, so no existing installation changes', async () => {
    const res = await ask(anonymous());
    expect(res.body.name).toBe(DEFAULT_BRAND_NAME);
  });

  it('is ours when the variable is set to nothing', async () => {
    const res = await ask(anonymous({ BRAND_NAME: '   ' }));
    expect(res.body.name).toBe(DEFAULT_BRAND_NAME);
  });

  it('flattens a name that arrived with a line break', async () => {
    const res = await ask(anonymous({ BRAND_NAME: 'وی‌پی‌ان\nپلاس' }));
    expect(res.body.name).toBe('وی‌پی‌ان پلاس');
  });

  it('did not make some OTHER route public on the way', async () => {
    /**
     * This change adds the second route on the panel that answers without a
     * session, and until now nothing counted them. `write-roles.test.ts`
     * guards the write surface the same way, and a read route that stopped
     * asking for a session is the quieter half of the same mistake.
     *
     * Every GET under `/api/` is asked with no cookie and no bypass. The two
     * named below must answer; every other one must say 401. A new exemption
     * added to the middleware turns this red, which is exactly the moment
     * somebody should have to say why.
     */
    const PUBLIC = ['/api/v1/health', '/api/v1/brand'];

    const routes = (app as unknown as { routes: { method: string; path: string }[] }).routes;
    const gets = [
      ...new Set(
        routes
          .filter((r) => r.method === 'GET' && r.path.startsWith('/api/'))
          .map((r) => r.path),
      ),
    ].sort();
    // A guard that enumerated nothing would pass in silence.
    expect(gets.length).toBeGreaterThan(50);

    const open: string[] = [];
    for (const path of gets) {
      // Path parameters filled with something harmless — the status is all
      // this reads, and a 404 or a 400 is still «not 401», which is the point.
      const url = path.replace(/:[A-Za-z0-9_]+/g, '1');
      const res = await app.fetch(new Request(`https://example.com${url}`), anonymous());
      if (res.status !== 401) open.push(path);
    }
    expect(open.sort()).toEqual([...PUBLIC].sort());
  });

  it('says nothing else about the box', async () => {
    // `/version` is behind the session gate because the commit sha is an
    // operator's business. This one is public, so it must carry the name and
    // nothing beside it.
    const res = await ask(anonymous({ BRAND_NAME: 'نماینده‌نت' }));
    expect(Object.keys(res.body).sort()).toEqual(['name', 'ok']);
  });
});
