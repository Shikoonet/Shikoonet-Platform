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
  checkRemoteUsername,
  adapterFor,
  groupIdsFor,
  isAutomated,
  manualAdapter,
  marzbanAdapter,
  remoteUsernameFor,
  renewAllowed,
  renewModeFor,
  type ProviderContext,
  type ProvisionRequest,
  type RenewRequest,
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
    if (method === 'POST' && url.endsWith('/reset')) {
      // RESET mode zeroes the usage counter before the PUT. Without this the
      // fake answered 500, the renewal bailed before it ever reached the PUT,
      // and the assertions below looked at an undefined body — which is how the
      // add-on case passed while asserting nothing at all.
      return new Response('{}', { status: 200 });
    }
    if (method === 'PUT' && url.includes('/api/user/')) {
      // What a renewal does: the adapter reads the account, then PUTs the new
      // quota, expiry and — since 2026-08-24 — the tier being renewed into.
      const name = decodeURIComponent(url.split('/api/user/')[1]!);
      const row = { ...(users[name] as object), ...(body as object) };
      users[name] = row;
      return new Response(JSON.stringify(row), { status: 200 });
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

  describe('«متن پنل + آیدی عددی + شمارهٔ خرید»', () => {
    const seq = (purchaseSeq: number | null) =>
      remoteUsernameFor(369469521, '84702b7df0', {
        mode: 'PANEL_TEXT_SEQ' as const,
        panelText: 'shikoo',
        purchaseSeq,
      });

    it('reads the way support asked for', () => {
      expect(seq(2)).toBe('shikoo_369469521_2');
      expect(seq(1)).toBe('shikoo_369469521_1');
    });

    it('is the same every time, so a retry finds the account it made', () => {
      expect(seq(3)).toBe(seq(3));
    });

    it('keeps two purchases of one customer apart', () => {
      // The only thing standing between this mode and a second paid account:
      // the suffix is no longer the order id, so the number IS the uniqueness.
      expect(seq(1)).not.toBe(seq(2));
    });

    it('falls back to the order-id shape when the number is not known', () => {
      // A caller that could not count it — an old row, a path that predates
      // this. Inventing a number here is the one thing that must not happen:
      // a guessed «1» is a name the customer's first account already has.
      expect(seq(null)).toBe('shikoo_84702b7df0');
      expect(seq(0)).toBe('shikoo_84702b7df0');
    });

    it('falls back with the shop’s own word, not a bare id', () => {
      // The prefix and the suffix are separate decisions. Losing the count
      // should not also lose the panel's name.
      expect(seq(null).startsWith('shikoo_')).toBe(true);
    });

    it('uses the telegram id when the panel has no text to use', () => {
      expect(
        remoteUsernameFor(369469521, '84702b7df0', {
          mode: 'PANEL_TEXT_SEQ' as const,
          panelText: null,
          purchaseSeq: 2,
        }),
      ).toBe('369469521_369469521_2');
    });
  });
});

describe('checkRemoteUsername', () => {
  // A WHOLE name, not a part of one. The distinction matters because a handover
  // note proposed `checkNamePrefix` for this job, and that validator caps at
  // twelve characters and refuses the underscore — it would reject every real
  // username this system builds.

  it('accepts the names this product actually creates', () => {
    expect(checkRemoteUsername('shikoo_369469521_2')).toBeNull();
    expect(checkRemoteUsername('369469521_84702b7df0')).toBeNull();
    expect(checkRemoteUsername('shikoo-vip_12')).toBeNull();
  });

  it('refuses what a panel would store differently from what we sent', () => {
    // The failure this prevents is not cosmetic: provisioning looks an account
    // up by the exact string it sent, so a name the panel case-folds or strips
    // is an account this system never finds again — and the sweep then loops on
    // a PAID order for ever.
    expect(checkRemoteUsername('Shikoo_1')).not.toBeNull();
    expect(checkRemoteUsername('علی')).not.toBeNull();
    expect(checkRemoteUsername('has space')).not.toBeNull();
    expect(checkRemoteUsername('_leading')).not.toBeNull();
    expect(checkRemoteUsername('ab')).not.toBeNull();
    expect(checkRemoteUsername('a'.repeat(65))).not.toBeNull();
  });

  it('answers in Persian, because an operator reads it', () => {
    expect(checkRemoteUsername('Shikoo_1')).toContain('حروف کوچک');
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

  /**
   * `groupIdsFor` exists so the panel preflight can say, before cutover, which
   * groups an order would ask for. It is only worth anything if it answers the
   * same thing the wire carries — so every case here asserts the function
   * against the body the fake panel actually received, never against a second
   * expectation written by hand. Delete the `groupIdsFor` call inside
   * `provision` and every one of these goes red.
   */
  describe('groupIdsFor answers what the wire carries', () => {
    const cases: { name: string; over: Partial<ProvisionRequest> }[] = [
      { name: 'the panel default', over: {} },
      { name: 'a plan override', over: { planAttrs: { group_ids: [83] } } },
      {
        name: 'the legacy `inbounds` spelling on the panel',
        over: { providerConfig: { inbounds: [7] }, planAttrs: {} },
      },
      {
        name: 'a plan `group_ids` beating a panel `inbounds`',
        over: { providerConfig: { inbounds: [7] }, planAttrs: { group_ids: [9] } },
      },
      {
        name: 'a plan `inbounds` beating a panel `inbounds`',
        over: { providerConfig: { inbounds: [7] }, planAttrs: { inbounds: [11] } },
      },
      {
        name: 'an empty plan list falling through to the panel',
        over: { providerConfig: { group_ids: [3] }, planAttrs: { group_ids: [] } },
      },
    ];

    for (const { name, over } of cases) {
      it(name, async () => {
        const panel = fakePanel();
        const req = request(over);

        await marzbanAdapter.provision(req, provider({ fetch: panel.fetchImpl }));

        const sent = (createCall(panel.calls)!.body as { group_ids?: unknown }).group_ids;
        expect(groupIdsFor(req)).toEqual(sent);
      });
    }

    it('says undefined when nothing is configured, and then nothing is sent', async () => {
      const panel = fakePanel();
      const req = request({ providerConfig: {}, planAttrs: {} });

      await marzbanAdapter.provision(req, provider({ fetch: panel.fetchImpl }));

      // Not the same as an empty list. The preflight has to tell "this plan
      // lets the panel decide" apart from "this plan asks for no groups",
      // because only the second one is worth reporting.
      expect(groupIdsFor(req)).toBeUndefined();
      expect(createCall(panel.calls)!.body).not.toHaveProperty('group_ids');
    });

    /**
     * An empty list is «no opinion», never «no groups» — on CREATE too.
     *
     * `renew` has refused to send `[]` since it was written, because PasarGuard
     * reads it as «this account belongs to no group» and strips every inbound:
     * the subscription link keeps resolving and returns nothing. `provision`
     * sent it, so the same plan behaved differently on the day it was bought and
     * on the day it was renewed.
     *
     * Measured on the live test panel 2026-08-26: five of its thirteen accounts
     * carry `group_ids: []`. Asserted against the body the fake panel received,
     * not against the stored value, for the reason at the top of this block.
     */
    it('never sends an empty group list, the way renew never has', async () => {
      const panel = fakePanel();
      const req = request({ providerConfig: { group_ids: [] }, planAttrs: { group_ids: [] } });

      await marzbanAdapter.provision(req, provider({ fetch: panel.fetchImpl }));

      expect(groupIdsFor(req)).toBeUndefined();
      expect(createCall(panel.calls)!.body).not.toHaveProperty('group_ids');
    });
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
  it('uses the panel adapter for pasarguard, which is what production runs', () => {
    expect(adapterFor('pasarguard')).toBe(marzbanAdapter);
    expect(isAutomated('pasarguard')).toBe(true);
  });

  it('sends a classic marzban panel to a human rather than to this adapter', () => {
    // Not an oversight. PasarGuard takes `group_ids`/`proxy_settings`; classic
    // Marzban takes `inbounds`/`proxies` and drops the others in silence, so a
    // customer would get an account with no inbounds and no error anywhere.
    expect(adapterFor('marzban')).toBe(manualAdapter);
    expect(isAutomated('marzban')).toBe(false);
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
    // `expiresAtMs` is null here because this fixture's users carry no `expire`
    // key at all — the panel saying nothing, which is not the same as a date of
    // zero. The test below feeds it both.
    const url = (i: number) => `https://panel.example.com/sub/u_${i}`;
    expect(result.ok && result.accounts).toEqual([
      { username: 'u_0', usedBytes: 0, subscriptionUrl: url(0), expiresAtMs: null },
      { username: 'u_1', usedBytes: 1024, subscriptionUrl: url(1), expiresAtMs: null },
      { username: 'u_2', usedBytes: 2048, subscriptionUrl: url(2), expiresAtMs: null },
    ]);
    // One full page was not needed, so one request.
    expect(panel.pages).toHaveLength(1);
  });

  /**
   * The expiry the sync sweep fills an imported service's blank date from.
   *
   * Read here rather than at the sweep because this is where the panel's two
   * spellings live: a unix number on one version, an ISO string on another,
   * and `0` or nothing at all for an account with no expiry — which must stay
   * NULL rather than becoming 1970. Issue #92.
   */
  it('reports the expiry however the panel spells it', async () => {
    const spellings: (number | string | undefined)[] = [
      1_788_000_000,
      '1788000000',
      '2026-09-01T06:00:00.000Z',
      0,
      undefined,
    ];
    const panel = listingPanel(spellings.length, (i) =>
      spellings[i] === undefined ? {} : { expire: spellings[i] },
    );

    const result = await marzbanAdapter.listAccounts!(provider({ fetch: panel.fetchImpl }));

    expect(result.ok && result.accounts.map((a) => a.expiresAtMs)).toEqual([
      1_788_000_000_000,
      1_788_000_000_000,
      Date.parse('2026-09-01T06:00:00.000Z'),
      // Zero and absent are the same answer: this account has no expiry.
      null,
      null,
    ]);
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

/**
 * Which renewal mode a panel uses, read from the settings the admin already
 * made in the old bot.
 *
 * Anchored on the exact strings in the production `marzban_panel` rows rather
 * than on the constant in the source, so a typo in one is not a typo in both.
 */
describe('reading the panel’s renewal settings', () => {
  const LEGACY_ADD = 'اضافه شدن زمان و حجم به ماه بعد';
  const LEGACY_RESET = 'ریست حجم و زمان';

  it('matches the five live panels', () => {
    // panel 1 accumulates; 8, 12, 13 and 14 reset.
    expect(renewModeFor({ Methodextend: LEGACY_ADD })).toBe('ADD');
    expect(renewModeFor({ Methodextend: LEGACY_RESET })).toBe('RESET');
  });

  it('resets rather than accumulates when the setting is missing or unknown', () => {
    // The safe direction: RESET gives the customer exactly the plan they paid
    // for. Defaulting to ADD would hand out a month on top of whatever was
    // there, on every panel nobody configured.
    expect(renewModeFor({})).toBe('RESET');
    expect(renewModeFor({ Methodextend: 'ریست زمان و اضافه کردن حجم قبلی' })).toBe('RESET');
  });

  it('lets an explicit setting win over the legacy one', () => {
    expect(renewModeFor({ renew_mode: 'add', Methodextend: LEGACY_RESET })).toBe('ADD');
    expect(renewModeFor({ renew_mode: 'RESET', Methodextend: LEGACY_ADD })).toBe('RESET');
  });

  it('honours the one panel the admin switched renewal off for', () => {
    expect(renewAllowed({ status_extend: 'off_extend' })).toBe(false);
    expect(renewAllowed({ status_extend: 'on_extend' })).toBe(true);
    // Nothing configured means allowed: every panel but one is on_extend, and
    // a silent no would look like a broken button rather than a setting.
    expect(renewAllowed({})).toBe(true);
    expect(renewAllowed({ renew_enabled: false, status_extend: 'on_extend' })).toBe(false);
  });
});

describe('extending an account', () => {
  function renewRequest(over: Partial<RenewRequest> = {}): RenewRequest {
    return {
      username: '369469521_84702b7df0',
      volumeGb: 50,
      durationDays: 30,
      note: 'shikoo b5baf9f689',
      providerConfig: {},
      planAttrs: {},
      mode: 'RESET',
      renewFrom: new Date(NOW),
      ...over,
    };
  }

  /** A panel holding one account, recording the PUT it is asked to make. */
  function panelWith(account: Record<string, unknown> | null) {
    const puts: Record<string, unknown>[] = [];
    const resets: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/admin/token')) {
        return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      }
      if (method === 'POST' && url.endsWith('/reset')) {
        resets.push(url);
        return new Response('{}', { status: 200 });
      }
      if (method === 'GET') {
        return account === null
          ? new Response('{}', { status: 404 })
          : new Response(JSON.stringify(account), { status: 200 });
      }
      if (method === 'PUT') {
        puts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ username: 'x', subscription_url: '/sub/x' }), {
          status: 200,
        });
      }
      return new Response('{}', { status: 500 });
    }) as unknown as typeof globalThis.fetch;
    return { puts, resets, fetchImpl };
  }

  it('reads an expiry the panel reports as a unix timestamp', async () => {
    // Marzban has reported this both ways across versions. Reading only ISO
    // would treat a timestamp as "no expiry" and, in ADD mode, silently throw
    // away every day the customer had left.
    const panel = panelWith({ expire: Math.floor((NOW + 10 * 86_400_000) / 1000), data_limit: 0 });

    await marzbanAdapter.renew!(
      renewRequest({ mode: 'ADD' }),
      provider({ fetch: panel.fetchImpl }),
    );

    expect(panel.puts[0]?.['expire']).toBe((NOW + 40 * 86_400_000) / 1000);
  });

  it('adds volume without touching an expiry that does not exist', async () => {
    // The extra-volume purchase: gigabytes, zero days. Zero must mean "add no
    // time", not "start the clock" — this account has no expiry, and stamping
    // one on it would end a service the customer is still paying for.
    const panel = panelWith({ expire: 0, data_limit: 10 * 1024 ** 3 });

    await marzbanAdapter.renew!(
      renewRequest({ mode: 'ADD', volumeGb: 5, durationDays: 0 }),
      provider({ fetch: panel.fetchImpl }),
    );

    expect(panel.puts[0]?.['expire']).toBe(0);
    expect(panel.puts[0]?.['data_limit']).toBe(15 * 1024 ** 3);
  });

  it('adds days without touching the quota', async () => {
    // And the mirror: the extra-time purchase is days with zero gigabytes.
    const panel = panelWith({
      expire: Math.floor((NOW + 5 * 86_400_000) / 1000),
      data_limit: 10 * 1024 ** 3,
    });

    await marzbanAdapter.renew!(
      renewRequest({ mode: 'ADD', volumeGb: 0, durationDays: 7 }),
      provider({ fetch: panel.fetchImpl }),
    );

    expect(panel.puts[0]?.['expire']).toBe((NOW + 12 * 86_400_000) / 1000);
    expect(panel.puts[0]?.['data_limit']).toBe(10 * 1024 ** 3);
  });

  /**
   * «ریست زمان، اضافه‌شدن حجم» — Sam, 2026-09-03. The half of each.
   *
   * The three assertions are the whole mode: the clock restarts like RESET, the
   * quota grows like ADD, and NO reset call is made. The last one is not a
   * detail — POST /reset zeroes the usage counter, and on a quota that is being
   * added to, zeroing it hands the customer every gigabyte they had already
   * spent back as free traffic.
   */
  it('restarts the clock and keeps the volume, without resetting usage', async () => {
    const panel = panelWith({
      // Ten days left and four gigabytes already spent against a ten-gigabyte
      // quota — a customer renewing early with volume unspent.
      expire: Math.floor((NOW + 10 * 86_400_000) / 1000),
      data_limit: 10 * 1024 ** 3,
      used_traffic: 4 * 1024 ** 3,
    });

    await marzbanAdapter.renew!(
      renewRequest({ mode: 'ADD_VOLUME_RESET_TIME', volumeGb: 50, durationDays: 30 }),
      provider({ fetch: panel.fetchImpl }),
    );

    // The clock: thirty days from NOW, not from the ten that were left.
    expect(panel.puts[0]?.['expire']).toBe((NOW + 30 * 86_400_000) / 1000);
    // The volume: the fifty bought ON TOP of the ten already there.
    expect(panel.puts[0]?.['data_limit']).toBe(60 * 1024 ** 3);
    // And the counter is left alone.
    expect(panel.resets).toEqual([]);
  });

  it('leaves an unmetered account unmetered when it resets the clock', async () => {
    // The same rule the ADD branch states, in the new mode: adding volume to an
    // account that has none capped is not a reason to cap it.
    const panel = panelWith({ expire: 0, data_limit: 0 });

    await marzbanAdapter.renew!(
      renewRequest({ mode: 'ADD_VOLUME_RESET_TIME', volumeGb: 50, durationDays: 30 }),
      provider({ fetch: panel.fetchImpl }),
    );

    expect(panel.puts[0]?.['data_limit']).toBe(0);
  });

  it('keeps an unmetered account unmetered', async () => {
    const panel = panelWith({ expire: 0, data_limit: 0 });

    await marzbanAdapter.renew!(
      renewRequest({ mode: 'ADD' }),
      provider({ fetch: panel.fetchImpl }),
    );

    // Adding fifty gigabytes to "no limit" must not impose a fifty-gigabyte cap.
    expect(panel.puts[0]?.['data_limit']).toBe(0);
  });

  it('stops before touching anything when the account is gone', async () => {
    const panel = panelWith(null);

    const result = await marzbanAdapter.renew!(
      renewRequest(),
      provider({ fetch: panel.fetchImpl }),
    );

    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(panel.puts).toHaveLength(0);
    expect(panel.resets).toHaveLength(0);
  });

  it('does nothing the second time, having recognised its own note', async () => {
    const panel = panelWith({ expire: 0, data_limit: 0, note: 'shikoo b5baf9f689' });

    const result = await marzbanAdapter.renew!(
      renewRequest(),
      provider({ fetch: panel.fetchImpl }),
    );

    expect(result).toMatchObject({ ok: true, alreadyExisted: true });
    expect(panel.puts).toHaveLength(0);
    // And the counter is not zeroed a second time either, which on a RESET
    // renewal would hand the customer a free month of usage.
    expect(panel.resets).toHaveLength(0);
  });

  it('does not mistake a different order’s note for its own', async () => {
    const panel = panelWith({ expire: 0, data_limit: 0, note: 'shikoo 0000000000' });

    await marzbanAdapter.renew!(renewRequest(), provider({ fetch: panel.fetchImpl }));

    expect(panel.puts).toHaveLength(1);
  });

  it('does not reset the counter when the mode accumulates', async () => {
    const panel = panelWith({ expire: 0, data_limit: 10 * 1024 ** 3 });

    await marzbanAdapter.renew!(
      renewRequest({ mode: 'ADD' }),
      provider({ fetch: panel.fetchImpl }),
    );

    expect(panel.resets).toHaveLength(0);
    expect(panel.puts[0]?.['data_limit']).toBe(60 * 1024 ** 3);
  });
});

/**
 * The one field whose shape is not ours to choose.
 *
 * `expire` is written two different ways against the same five production
 * panels, and which one depends on the OPERATION rather than on the panel:
 *
 *   create   Marzban.php:242    $data["expire"] = date('c', $timestamp)
 *   extend   panels.php:1958    'expire' => $time_new
 *
 * Both work in production today, so both are evidence. These tests exist so
 * that the next person to notice the inconsistency cannot tidy it into one
 * shape without deleting a citation first — and getting it wrong sells a
 * customer an account that expired in 1970.
 */
describe('the expire field, in the shape the live PHP uses', () => {
  const AT = NOW + 30 * 86_400_000;

  /** A panel that answers everything renew needs and records the PUT. */
  function renewPanel(currentExpire: string | number) {
    const puts: Record<string, unknown>[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/admin/token')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      if (url.endsWith('/reset')) return new Response('{}', { status: 200 });
      if (method === 'GET') {
        return new Response(JSON.stringify({ expire: currentExpire, data_limit: 0 }), {
          status: 200,
        });
      }
      puts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ username: 'u' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    return { puts, fetchImpl };
  }

  function renewal(over: Partial<RenewRequest> = {}): RenewRequest {
    return {
      username: 'u',
      volumeGb: 50,
      durationDays: 30,
      note: 'shikoo abc',
      providerConfig: {},
      planAttrs: {},
      mode: 'RESET',
      renewFrom: new Date(NOW),
      ...over,
    };
  }

  it('creates with ISO-8601, like Marzban.php:242', async () => {
    const panel = fakePanel();

    await marzbanAdapter.provision(
      request({ expiresAt: new Date(AT) }),
      provider({ fetch: panel.fetchImpl }),
    );

    const body = createCall(panel.calls)?.body as Record<string, unknown>;
    expect(body['expire']).toBe(new Date(AT).toISOString());
    expect(typeof body['expire']).toBe('string');
  });

  it('extends with unix seconds, like panels.php:1958', async () => {
    const panel = renewPanel(0);

    await marzbanAdapter.renew!(renewal(), provider({ fetch: panel.fetchImpl }));

    expect(panel.puts[0]?.['expire']).toBe(AT / 1000);
    expect(typeof panel.puts[0]?.['expire']).toBe('number');
  });

  it('reads back whichever shape it is answered with', async () => {
    // Needed precisely because the two paths write differently: an account we
    // created carries ISO, one we extended carries seconds, and an ADD renewal
    // has to measure from either without noticing the difference.
    const at = NOW + 10 * 86_400_000;
    const fromSeconds = renewPanel(Math.floor(at / 1000));
    const fromIso = renewPanel(new Date(at).toISOString());

    await marzbanAdapter.renew!(
      renewal({ mode: 'ADD', durationDays: 10 }),
      provider({ fetch: fromSeconds.fetchImpl }),
    );
    await marzbanAdapter.renew!(
      renewal({ mode: 'ADD', durationDays: 10 }),
      provider({ fetch: fromIso.fetchImpl }),
    );

    expect(fromSeconds.puts[0]?.['expire']).toBe((at + 10 * 86_400_000) / 1000);
    expect(fromIso.puts[0]?.['expire']).toBe(fromSeconds.puts[0]?.['expire']);
  });
});

describe('a panel that is not configured', () => {
  /**
   * Found by paying from the wallet on the test bot on 2026-08-13. The money
   * left the ledger, the order went to PAID, and the sweep retried forever
   * because a missing secret was reported as a transient failure. The customer
   * was charged and told nothing.
   */
  it('is a job for a person, not something to retry until the panel appears', async () => {
    const noSecret = { ...provider(), credentials: null };
    const result = await marzbanAdapter.provision(request(), noSecret);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.retryable).toBe(false);
    expect(result.ok === false && result.reason).toContain('secret_ref');
  });

  it('says the same about a panel with no address', async () => {
    const noUrl = { ...provider(), baseUrl: null };
    const result = await marzbanAdapter.provision(request(), noUrl);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.retryable).toBe(false);
  });

  it('treats a rejected login as configuration and a sick panel as worth retrying', async () => {
    const rejecting = (status: number) =>
      (async () => new Response('{}', { status })) as unknown as typeof globalThis.fetch;

    const badPassword = await marzbanAdapter.provision(request(), {
      ...provider(),
      fetch: rejecting(401),
    });
    expect(badPassword.ok === false && badPassword.retryable).toBe(false);

    const panelIll = await marzbanAdapter.provision(request(), {
      ...provider(),
      fetch: rejecting(503),
    });
    expect(panelIll.ok === false && panelIll.retryable).toBe(true);
  });
});

/** The renewal PUT, which is a different call from the create POST. */
function renewCall(calls: Call[]): Call | undefined {
  return calls.find((c) => c.method === 'PUT' && c.url.includes('/api/user/'));
}

describe('renewing an account into a different tier', () => {
  /*
   * A renewal used to send quota, expiry and note — and nothing about groups.
   * The panel account therefore kept whatever it was created with, which is
   * invisible until somebody renews from a DIFFERENT service.
   *
   * That is not an edge case. Renewing across services is already legal (the
   * bot only requires the same panel), and for a first-timers-only tier it is
   * the ONLY route: such a service vanishes from its own renewal list the
   * moment the customer owns anything. So the customer paid the new tier's
   * price and quietly went on receiving the old tier's inbounds, for as long as
   * the account lived.
   */
  const account = { username: 'u1', subscription_url: '/sub/u1-tok' };

  function renewRequest(over: Record<string, unknown> = {}) {
    return {
      username: 'u1',
      volumeGb: 20,
      durationDays: 30,
      note: 'shikoo order-1',
      providerConfig: { group_ids: [42, 2], proxy_settings: { vless: {} } },
      planAttrs: {},
      mode: 'RESET' as const,
      renewFrom: new Date(NOW),
      ...over,
    };
  }

  it('sends the tier being renewed into', async () => {
    const panel = fakePanel({ users: { u1: account } });
    await marzbanAdapter.renew!(
      renewRequest({ groupIds: [7] }),
      provider({ fetch: panel.fetchImpl }),
    );

    const put = renewCall(panel.calls);
    expect(put, 'the renewal never reached the panel').toBeDefined();
    expect((put!.body as { group_ids?: unknown }).group_ids).toEqual([7]);
  });

  it('never sends an empty list', async () => {
    /*
     * `[]` is not "leave the groups alone" — to PasarGuard it means "this
     * account belongs to no group", which strips every inbound and kills the
     * subscription in the quietest possible way: the link still resolves and
     * returns nothing at all. Absent is how you say "leave them alone".
     */
    const panel = fakePanel({ users: { u1: account } });
    await marzbanAdapter.renew!(
      renewRequest({ groupIds: [] }),
      provider({ fetch: panel.fetchImpl }),
    );

    const put = renewCall(panel.calls);
    expect(put, 'the renewal never reached the panel').toBeDefined();
    expect(put!.body).not.toHaveProperty('group_ids');
  });

  it('leaves the groups alone when the caller names none', async () => {
    // An add-on — five more gigabytes, ten more days — buys quota, not a tier.
    // The caller omits `groupIds` for those, and `mode` cannot be used to tell
    // the two apart: `renewModeFor` answers 'ADD' for ordinary renewals too.
    const panel = fakePanel({ users: { u1: account } });
    await marzbanAdapter.renew!(
      renewRequest({ mode: 'ADD' }),
      provider({ fetch: panel.fetchImpl }),
    );

    // Asserted to EXIST first. Without that, `?.body` on a renewal that never
    // happened is undefined, `not.toHaveProperty` is trivially true, and the
    // test passes no matter what the adapter does.
    const put = renewCall(panel.calls);
    expect(put, 'the renewal never reached the panel').toBeDefined();
    expect(put!.body).not.toHaveProperty('group_ids');
  });
});
