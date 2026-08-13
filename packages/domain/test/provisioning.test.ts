/**
 * The Marzban adapter, against a fake panel that speaks the real API.
 *
 * The request bodies are asserted field by field rather than "it called the
 * panel", because the fields ARE the behaviour: a data_limit in the wrong unit
 * sells a customer a gigabyte instead of fifty, and an expire in the wrong shape
 * sells them an account that has already expired.
 */

import { describe, expect, it } from 'vitest';
import {
  adapterFor,
  isAutomated,
  manualAdapter,
  marzbanAdapter,
  remoteUsernameFor,
  type ProviderContext,
  type ProvisionRequest,
} from '../src/index.js';

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/**
 * A panel that behaves like the real one: token endpoint, user lookup, user
 * creation. `users` seeds accounts that already exist.
 */
function fakePanel(options: { users?: Record<string, unknown>; onCreate?: () => Response } = {}) {
  const calls: Call[] = [];
  const users: Record<string, unknown> = { ...options.users };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let body: unknown = init?.body;
    if (typeof body === 'string' && body.startsWith('{')) body = JSON.parse(body);
    if (body instanceof URLSearchParams) body = Object.fromEntries(body);
    calls.push({ url, method, body });

    if (url.endsWith('/api/admin/token')) {
      return new Response(JSON.stringify({ access_token: 'tok-123' }), { status: 200 });
    }
    if (method === 'GET' && url.includes('/api/user/')) {
      const name = decodeURIComponent(url.split('/api/user/')[1]!);
      const found = users[name];
      return found
        ? new Response(JSON.stringify(found), { status: 200 })
        : new Response('{}', { status: 404 });
    }
    if (method === 'POST' && url.endsWith('/api/user')) {
      if (options.onCreate) return options.onCreate();
      const created = body as { username: string };
      const row = { username: created.username, subscription_url: `/sub/${created.username}-tok` };
      users[created.username] = row;
      return new Response(JSON.stringify(row), { status: 200 });
    }
    return new Response('{}', { status: 500 });
  }) as unknown as typeof globalThis.fetch;

  return { calls, users, fetchImpl };
}

/**
 * The create-user call, not the token call — both are POSTs, and matching on
 * the method alone quietly asserts against the login body instead.
 */
function createCall(calls: Call[]): Call | undefined {
  return calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/user'));
}

function provider(over: Partial<ProviderContext> = {}): ProviderContext {
  return {
    id: 1,
    code: '7e7a',
    name: 'VIP',
    baseUrl: 'https://panel.example.com',
    credentials: { username: 'admin', password: 'p:ss:word' },
    // Exactly what the live panels carry: version 1, so group ids and
    // proxy_settings rather than inbounds and proxies.
    config: { group_ids: [42, 2], proxy_settings: { vless: {} } },
    fetch: fakePanel().fetchImpl,
    ...over,
  };
}

function request(over: Partial<ProvisionRequest> = {}): ProvisionRequest {
  return {
    username: '369469521_84702b7df0',
    volumeGb: 50,
    durationDays: 30,
    note: 'shikoo 84702b7df0',
    providerConfig: { group_ids: [42, 2], proxy_settings: { vless: {} } },
    planAttrs: {},
    expiresAt: new Date(NOW + 30 * 86_400_000),
    ...over,
  };
}

describe('remoteUsernameFor', () => {
  it('keeps the shape the panels already hold', () => {
    // Real production usernames: 369469521_ce4c, 5633385607_ff620a55.
    expect(remoteUsernameFor(369469521, '84702b7df0')).toBe('369469521_84702b7df0');
    expect(remoteUsernameFor(5633385607, 'd2154af80e')).toBe('5633385607_d2154af80e');
  });

  it('is the same every time, which is what makes a retry safe', () => {
    const a = remoteUsernameFor(1, 'abcdef1234');
    const b = remoteUsernameFor(1, 'abcdef1234');
    expect(a).toBe(b);
  });

  it('keeps two orders of one customer apart, however alike their ids', () => {
    // This caught a real defect. An earlier version took the first eight
    // characters, so these two collided — and a collision is not an error: the
    // adapter finds the existing account and reports success, so the customer
    // pays twice and receives one service.
    expect(remoteUsernameFor(1, 'abcdef1235')).not.toBe(remoteUsernameFor(1, 'abcdef1234'));
    expect(remoteUsernameFor(1, 'aaaaaaaaab')).not.toBe(remoteUsernameFor(1, 'aaaaaaaaaa'));
  });
});

describe('the marzban adapter', () => {
  it('creates the account with the volume, expiry and groups the plan says', async () => {
    const panel = fakePanel();

    const result = await marzbanAdapter.provision(request(), provider({ fetch: panel.fetchImpl }));

    expect(result).toMatchObject({ ok: true, alreadyExisted: false });
    const create = createCall(panel.calls)!;
    expect(create.body).toMatchObject({
      username: '369469521_84702b7df0',
      // 50 GB in bytes, not 50. Getting this wrong is a two-order-of-magnitude
      // difference in what the customer receives.
      data_limit: 50 * 1024 * 1024 * 1024,
      expire: new Date(NOW + 30 * 86_400_000).toISOString(),
      group_ids: [42, 2],
      proxy_settings: { vless: {} },
      data_limit_reset_strategy: 'no_reset',
      note: 'shikoo 84702b7df0',
    });
  });

  it('sends the credentials form-encoded, and never in a URL', async () => {
    const panel = fakePanel();

    await marzbanAdapter.provision(request(), provider({ fetch: panel.fetchImpl }));

    const login = panel.calls.find((c) => c.url.endsWith('/api/admin/token'))!;
    // A password containing a colon must survive intact.
    expect(login.body).toEqual({ username: 'admin', password: 'p:ss:word' });
    for (const call of panel.calls) expect(call.url).not.toContain('p:ss:word');
  });

  it('turns a relative subscription path into something tappable', async () => {
    const panel = fakePanel();

    const result = await marzbanAdapter.provision(request(), provider({ fetch: panel.fetchImpl }));

    expect(result.ok && result.subscriptionUrl).toBe(
      'https://panel.example.com/sub/369469521_84702b7df0-tok',
    );
  });

  it('leaves an absolute subscription URL alone', async () => {
    const panel = fakePanel({
      users: {},
      onCreate: () =>
        new Response(JSON.stringify({ username: 'x', subscription_url: 'https://sub.other/abc' }), {
          status: 200,
        }),
    });

    const result = await marzbanAdapter.provision(request(), provider({ fetch: panel.fetchImpl }));

    expect(result.ok && result.subscriptionUrl).toBe('https://sub.other/abc');
  });

  it('spells an unmetered or never-expiring plan as zero', async () => {
    const panel = fakePanel();

    await marzbanAdapter.provision(
      request({ volumeGb: null, durationDays: null, expiresAt: null }),
      provider({ fetch: panel.fetchImpl }),
    );

    const create = createCall(panel.calls)!;
    expect(create.body).toMatchObject({ data_limit: 0, expire: 0 });
  });

  it('lets the plan override the panel default', async () => {
    const panel = fakePanel();

    await marzbanAdapter.provision(
      request({ planAttrs: { group_ids: [83] } }),
      provider({ fetch: panel.fetchImpl }),
    );

    const create = createCall(panel.calls)!;
    expect(create.body).toMatchObject({ group_ids: [83] });
  });

  describe('running it twice', () => {
    it('finds the account instead of making a second one', async () => {
      const panel = fakePanel({
        users: {
          '369469521_84702b7df0': {
            username: '369469521_84702b7df0',
            subscription_url: '/sub/existing',
          },
        },
      });

      const result = await marzbanAdapter.provision(
        request(),
        provider({ fetch: panel.fetchImpl }),
      );

      expect(result).toMatchObject({ ok: true, alreadyExisted: true });
      expect(result.ok && result.subscriptionUrl).toBe('https://panel.example.com/sub/existing');
      // The point: nothing was created.
      expect(createCall(panel.calls)).toBeUndefined();
    });

    it('recovers when the account appears between the read and the write', async () => {
      // Two sweeps racing. Ours looks, sees nothing, then loses the create.
      let created = false;
      const panel = fakePanel({
        onCreate: () => {
          created = true;
          return new Response('{"detail":"exists"}', { status: 409 });
        },
      });
      const originalFetch = panel.fetchImpl;
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (created && init?.method !== 'POST' && url.includes('/api/user/')) {
          return new Response(
            JSON.stringify({ username: '369469521_84702b7df0', subscription_url: '/sub/won' }),
            { status: 200 },
          );
        }
        return originalFetch(input as never, init as never);
      }) as unknown as typeof globalThis.fetch;

      const result = await marzbanAdapter.provision(request(), provider({ fetch: fetchImpl }));

      expect(result).toMatchObject({ ok: true, alreadyExisted: true });
      expect(result.ok && result.subscriptionUrl).toBe('https://panel.example.com/sub/won');
    });
  });

  describe('when it goes wrong', () => {
    it('asks to be retried when the panel is unreachable', async () => {
      const fetchImpl = (() =>
        Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof globalThis.fetch;

      const result = await marzbanAdapter.provision(request(), provider({ fetch: fetchImpl }));

      expect(result).toMatchObject({ ok: false, retryable: true });
      expect(result.ok === false && result.reason).toContain('could not reach the panel');
    });

    it('asks to be retried on a panel error, but not on a bad request', async () => {
      for (const [status, retryable] of [
        [500, true],
        [503, true],
        [400, false],
        [422, false],
      ] as const) {
        const panel = fakePanel({ onCreate: () => new Response('{}', { status }) });
        const result = await marzbanAdapter.provision(
          request(),
          provider({ fetch: panel.fetchImpl }),
        );
        expect(result).toMatchObject({ ok: false, retryable });
      }
    });

    it('classifies a failed lookup by whose fault it is, not as always retryable', async () => {
      // This caught a real defect. The existence check threw on any non-404, and
      // the outer catch turned every throw into "try again" — so a panel whose
      // admin account had lost permission would have been retried forever
      // instead of reaching a person.
      for (const [status, retryable] of [
        [500, true],
        [502, true],
        [403, false],
        [422, false],
      ] as const) {
        const fetchImpl = (async (input: string | URL | Request) =>
          String(input).endsWith('/api/admin/token')
            ? new Response(JSON.stringify({ access_token: 't' }), { status: 200 })
            : new Response('{}', { status })) as unknown as typeof globalThis.fetch;

        const result = await marzbanAdapter.provision(request(), provider({ fetch: fetchImpl }));

        expect(result).toMatchObject({ ok: false, retryable });
      }
    });

    it('stops rather than guessing when the panel has no credentials', async () => {
      const panel = fakePanel();

      const result = await marzbanAdapter.provision(
        request(),
        provider({ fetch: panel.fetchImpl, credentials: null }),
      );

      expect(result).toMatchObject({ ok: false });
      expect(result.ok === false && result.reason).toContain('no credentials');
      expect(panel.calls).toHaveLength(0);
    });

    it('never puts the password in the failure reason', async () => {
      const fetchImpl = (async () =>
        new Response('{"detail":"bad password p:ss:word"}', {
          status: 401,
        })) as unknown as typeof globalThis.fetch;

      const result = await marzbanAdapter.provision(request(), provider({ fetch: fetchImpl }));

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).not.toContain('p:ss:word');
    });
  });
});

describe('choosing an adapter', () => {
  it('uses marzban for marzban', () => {
    expect(adapterFor('marzban')).toBe(marzbanAdapter);
    expect(isAutomated('marzban')).toBe(true);
  });

  it('falls back to manual for every kind without an adapter', () => {
    // Every remaining value the schema's CHECK allows.
    for (const kind of ['marzneshin', 'hiddify', 'xui', 'wireguard', 'ai_account', 'spotify']) {
      expect(adapterFor(kind)).toBe(manualAdapter);
      expect(isAutomated(kind)).toBe(false);
    }
  });

  it('falls back to manual rather than throwing on something unheard of', () => {
    expect(adapterFor('carrier-pigeon')).toBe(manualAdapter);
  });

  it('marks a manual order as waiting for a person, not as delivered', async () => {
    const result = await manualAdapter.provision(request(), provider());

    expect(result).toMatchObject({ ok: true });
    // No link, so the caller cannot promise the customer a config.
    expect(result.ok && result.subscriptionUrl).toBeNull();
    expect(result.ok && result.remoteRef).toMatchObject({ pending: true });
  });
});

/**
 * The bulk listing the subscription sync is built on.
 *
 * Paging is asserted against a panel that actually holds more than one page,
 * because the loop's exit condition is the interesting part: reading `total`
 * instead of the length of the array beside it is how a listing quietly stops
 * halfway when a panel's count and its page disagree.
 */
describe('listing every account on a panel', () => {
  function listingPanel(count: number, over: (i: number) => Record<string, unknown> = () => ({})) {
    const pages: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/admin/token')) {
        return new Response(JSON.stringify({ access_token: 'tok-123' }), { status: 200 });
      }
      const match = /offset=(\d+)&limit=(\d+)/.exec(url);
      if (!match) return new Response('{}', { status: 500 });
      pages.push(url);
      const offset = Number(match[1]);
      const limit = Number(match[2]);
      const users = [];
      for (let i = offset; i < Math.min(offset + limit, count); i++) {
        users.push({
          username: `u_${i}`,
          used_traffic: i * 1024,
          subscription_url: `/sub/u_${i}`,
          ...over(i),
        });
      }
      // Deliberately wrong on purpose in one test below; here it is honest.
      return new Response(JSON.stringify({ users, total: count }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    return { pages, fetchImpl };
  }

  it('returns every account and makes the link absolute', async () => {
    const panel = listingPanel(3);

    const result = await marzbanAdapter.listAccounts!(provider({ fetch: panel.fetchImpl }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.accounts).toEqual([
      { username: 'u_0', usedBytes: 0, subscriptionUrl: 'https://panel.example.com/sub/u_0' },
      { username: 'u_1', usedBytes: 1024, subscriptionUrl: 'https://panel.example.com/sub/u_1' },
      { username: 'u_2', usedBytes: 2048, subscriptionUrl: 'https://panel.example.com/sub/u_2' },
    ]);
    // One full page was not needed, so one request.
    expect(panel.pages).toHaveLength(1);
  });

  it('walks past the first page rather than stopping at it', async () => {
    // 501 accounts against a 500-account page: the second page has one row.
    const panel = listingPanel(501);

    const result = await marzbanAdapter.listAccounts!(provider({ fetch: panel.fetchImpl }));

    expect(result.ok && result.accounts).toHaveLength(501);
    expect(panel.pages).toHaveLength(2);
  });

  it('refuses a usage figure that would corrupt the row', async () => {
    // A panel mid-restart has been seen to report both of these. The column has
    // a `>= 0` CHECK, so a negative would abort the whole sync batch, and a
    // fraction would show a customer volume they do not have.
    const panel = listingPanel(2, (i) => ({ used_traffic: i === 0 ? -5 : 1024.7 }));

    const result = await marzbanAdapter.listAccounts!(provider({ fetch: panel.fetchImpl }));

    expect(result.ok && result.accounts[0]?.usedBytes).toBeNull();
    expect(result.ok && result.accounts[1]?.usedBytes).toBe(1024);
  });

  it('skips an account with no name instead of inventing one', async () => {
    const panel = listingPanel(2, (i) => (i === 0 ? { username: null } : {}));

    const result = await marzbanAdapter.listAccounts!(provider({ fetch: panel.fetchImpl }));

    expect(result.ok && result.accounts).toHaveLength(1);
    expect(result.ok && result.accounts[0]?.username).toBe('u_1');
  });

  it('reports a refusal rather than an empty panel', async () => {
    // The difference matters: an empty list would mean "this panel holds
    // nothing", and the sweep would have no reason to leave the rows alone.
    const fetchImpl = (async (input: string | URL | Request) =>
      String(input).endsWith('/api/admin/token')
        ? new Response(JSON.stringify({ access_token: 't' }), { status: 200 })
        : new Response('{}', { status: 403 })) as unknown as typeof globalThis.fetch;

    const result = await marzbanAdapter.listAccounts!(provider({ fetch: fetchImpl }));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('403');
  });

  it('is not offered at all by the manual adapter', () => {
    expect(manualAdapter.listAccounts).toBeUndefined();
  });
});
